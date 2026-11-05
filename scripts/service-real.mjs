// `paddock service …` against the machine's REAL service manager: launchd's gui/<uid> domain on macOS, systemd's
// user instance on Linux. The package is used exactly as a user gets it — staged, packed, installed globally into a
// temporary prefix, and run from there.
//
// Ported from Local Review's scripts/service-real.mjs @ cli-contract spec 0.1; local changes: Paddock's packaging
// (scripts/make-npm-package.mjs synthesizes @edspencer/paddock from two private workspaces), a throwaway
// PADDOCK_DATA_DIR, the contract's exit codes (0/2/3/4/75), `service logs`, the file-logging check, and wave C1's
// `runtime.json` + the busy check on `stop` / `restart`.
//
// CI ONLY. It writes the real ~/Library/LaunchAgents/net.edspencer.paddock.plist or
// ~/.config/systemd/user/paddock.service and loads it, under the real label — so it must never run on a machine that
// uses Paddock as a service. It refuses unless CI=true and PADDOCK_REAL_SERVICE=1, and it refuses again if a unit is
// already installed. It removes what it installs, and checks that uninstall leaves the data home and the logs alone.
//
// What it checks, in order:
//   status with nothing installed            exit 4, --json says installed:false
//   install from an npx cache                refused, exit 1, nothing written
//   install --port <free>                    it answers; the unit names the installed CLI, `serve`, and the log file
//   the log file                             carries the server's own banner line, which proves stdout reaches it
//   status / status --json                   exit 0, running + answering, installed version == running version
//   logs, logs -n                            exit 0, reads that same file
//   an unknown flag                          exit 2
//   runtime.json                             written 0600, naming the supervisor's pid and port
//   busy / busy --json                       exit 0 against the idle service
//   stop / restart while busy                exit 75, and the service is STILL answering afterwards
//   stop --force while busy                  exit 0, `Overriding: …`, and it really goes down
//   SIGKILL                                  the supervisor brings it back (KeepAlive / Restart=always)
//   stop an idle service                     NOT refused: exit 0; status 3, logs 0, busy 3, runtime.json gone
//   start / restart                          exit 0 and answering again
//   uninstall                                the unit is gone, status and logs exit 4, the data home is untouched
import { execFileSync, spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.CI !== "true" || process.env.PADDOCK_REAL_SERVICE !== "1") {
  console.error(
    "service-real: refusing to run outside CI (set CI=true and PADDOCK_REAL_SERVICE=1, on a throwaway machine)",
  );
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "paddock-service-")));
const prefix = path.join(tmp, "prefix");
const data = path.join(tmp, "data");
const work = path.join(tmp, "work");
for (const d of [prefix, work]) fs.mkdirSync(d);
const step = (s) => console.log(`service-real: ${s}`);

// The real HOME — that is where the service manager looks — with a throwaway data dir, no drive mode that could
// spend credit, and no credentials for it to spend them with.
const env = { ...process.env, PADDOCK_DATA_DIR: data, PADDOCK_DRIVE_MODE: "batch" };
for (const k of [
  "PORT",
  "HOST",
  "PADDOCK_PROJECTS_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "NODE_OPTIONS",
  "NODE_ENV",
]) {
  delete env[k];
}

const bin = path.join(prefix, "bin", "paddock");

/**
 * Run the installed CLI. Returns { code, stdout, stderr } — never throws for a non-zero exit.
 *
 * `spawnSync`, not `execFileSync`, and that is the whole point: `execFileSync`
 * RETURNS stdout and only exposes stderr by throwing, so a command that
 * succeeded handed back `stderr: ""` no matter what it had written. That is a
 * lie for every command on this contract, because SPEC §3 puts prose on stderr
 * and keeps stdout for the one JSON document — so `stop --force`'s whole
 * observable output (`Overriding: …`, then exit 0) was being discarded, and the
 * assertion on it failed against `''`.
 */
function paddock(...args) {
  const r = spawnSync(bin, args, {
    cwd: work,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  if (r.error !== undefined) throw r.error;
  // Killed by a signal (the timeout above) rather than exited: `status` is null,
  // and reporting that as a code would turn a hang into a wrong-exit-code.
  if (r.status === null) {
    throw new Error(
      `paddock ${args.join(" ")} was killed by ${r.signal}\n${r.stdout ?? ""}\n${r.stderr ?? ""}`,
    );
  }
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Run it and insist on an exit code, so a wrong one fails here rather than three assertions later. */
function expectExit(code, ...args) {
  const r = paddock(...args);
  assert.equal(
    r.code,
    code,
    `paddock ${args.join(" ")} exited ${r.code}, expected ${code}\n${r.stdout}\n${r.stderr}`,
  );
  return r;
}

const statusJson = (expected) => JSON.parse(expectExit(expected, "service", "status", "--json").stdout);

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not yet */
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}
const health = async (port) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
};

let installed = false;
try {
  step("stage the npm package, pack it, and install it into a temporary prefix");
  // pack:npm = build + make-npm-package.mjs, which synthesizes @edspencer/paddock from the two private workspaces.
  execFileSync("npm", ["run", "pack:npm"], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "development" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const staged = path.join(root, "dist-npm");
  const packed = execFileSync("npm", ["pack", "--json", "--pack-destination", tmp], {
    cwd: staged,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const tarball = path.join(tmp, JSON.parse(packed.slice(packed.search(/^\[$/m))).at(-1).filename);
  execFileSync(
    "npm",
    ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", tarball],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const cli = fs.realpathSync(
    path.join(prefix, "lib", "node_modules", "@edspencer", "paddock", "packages", "server", "dist", "cli", "paddock.js"),
  );
  const version = expectExit(0, "--version").stdout.trim();
  assert.match(version, /^\d+\.\d+\.\d+/, `--version is bare: ${JSON.stringify(version)}`);
  step(`installed @edspencer/paddock@${version}`);

  step("status with nothing installed: exit 4");
  const before = statusJson(4);
  assert.equal(before.installed, false, `a service is already installed here (${before.unit}) — use a throwaway machine`);
  const unit = before.unit;

  step("install from an npx cache: refused, and nothing written");
  try {
    execFileSync("npx", ["-y", `--package=${tarball}`, "paddock", "service", "install"], {
      cwd: work,
      env: { ...env, npm_config_cache: path.join(tmp, "npm-cache") },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.fail("service install from an npx cache should have been refused");
  } catch (e) {
    assert.equal(e.status, 1, `exit status: ${e.stderr}`);
    assert.match(e.stderr, /npx's cache/);
  }
  assert.ok(!fs.existsSync(unit), "nothing written");

  const port = await freePort();
  step(`service install --port ${port}`);
  installed = true;
  const out = expectExit(0, "service", "install", "--port", String(port)).stdout;
  assert.match(out, new RegExp(`running at http://127\\.0\\.0\\.1:${port}`));
  const answer = await until("health", () => health(port));
  assert.equal(answer.ok, true);
  assert.equal(answer.version, version, "/api/health reports the version it is running (SPEC §8)");

  step("the unit names the installed CLI, `serve`, and the log file");
  const unitText = fs.readFileSync(unit, "utf8");
  const logFile = path.join(data, "logs", "service.log");
  assert.ok(unitText.includes(cli), `the unit runs the installed CLI (${cli}):\n${unitText}`);
  // The verb, not merely the substring: every path in here contains "server".
  const runsServe =
    process.platform === "darwin"
      ? /<string>serve<\/string>/.test(unitText)
      : new RegExp(`^ExecStart=.*${cli.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} serve `, "m").test(unitText);
  assert.ok(runsServe, `it runs \`serve\` (SPEC §1, §7):\n${unitText}`);
  assert.ok(unitText.includes(logFile), `it logs to ${logFile}:\n${unitText}`);
  assert.ok(!/fnm_multishells|_npx|node_modules\/\.bin/.test(unitText), "no per-shell PATH entries");
  if (process.platform === "darwin") execFileSync("plutil", ["-lint", unit], { stdio: "inherit" });
  // The server's own first stdout line, in the file: proof that the supervisor's redirection works, which is the
  // half of file logging that no unit test can see.
  await until(`the banner in ${logFile}`, () =>
    fs.readFileSync(logFile, "utf8").includes(`Paddock ${version}: http://127.0.0.1:${port}`),
  );

  step("status: exit 0, running, answering, versions agree");
  console.log(expectExit(0, "service", "status").stdout);
  let s = statusJson(0);
  assert.equal(s.installed, true);
  assert.equal(s.running, true);
  assert.equal(s.answering, true);
  assert.equal(s.port, port);
  assert.equal(s.cli, cli);
  assert.equal(s.log, logFile);
  assert.equal(s.installedVersion, version);
  assert.equal(s.runningVersion, version);
  assert.deepEqual(s.warnings, [], `no warnings: ${JSON.stringify(s.warnings)}`);
  if (process.platform === "linux") assert.equal(s.linger, true, "CI enables lingering");
  else assert.equal(s.linger, null, "launchd has no linger");

  step("runtime.json: written 0600 once it is listening, naming this pid and port (SPEC §4)");
  const runtimeFile = path.join(data, "runtime.json");
  const runtime = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
  assert.equal(runtime.pid, s.pid, "runtime.json names the pid the supervisor reports");
  assert.equal(runtime.port, port);
  assert.equal(runtime.version, version);
  assert.match(runtime.startedAt, /^\d{4}-\d\d-\d\dT/);
  // Written 0600 before there is a token in it (SPEC §10) — adding one later
  // must not have to change who may read the file. Asserted as "no group or
  // other access" rather than an exact 0600, because `open()`'s mode is masked
  // by the umask and a runner's umask is not ours to assume; the exact mode is
  // pinned in cli-contract.test.ts, where it is.
  assert.equal(fs.statSync(runtimeFile).mode & 0o077, 0, "runtime.json is not group/world readable");

  step("busy against the real, idle service: exit 0");
  expectExit(0, "busy");
  const idleBusy = JSON.parse(expectExit(0, "busy", "--json").stdout);
  assert.equal(idleBusy.running, true);
  assert.equal(idleBusy.busy, false);
  assert.equal(idleBusy.version, version);
  assert.equal(idleBusy.counts.chat, 0);

  // --- the refusal, against a real service manager ------------------------
  //
  // Making the REAL instance busy would mean driving a chat turn through it,
  // which needs a project, a socket and a fake `claude` inside the unit. What is
  // worth proving HERE is not the counting — unit and integration tests cover
  // that against the real hub — but that a refusal reaches the real
  // launchctl/systemctl path and stops it: `stop` returns 75 and the service is
  // still answering afterwards, and `--force` gets past it.
  //
  // So the busy ANSWER is faked, at the seam the CLI actually uses. The CLI finds
  // the instance through `<data>/runtime.json` and nothing else, so pointing that
  // file at a server answering `/api/busy` with `busy: true` is exactly what a
  // busy Paddock looks like from out here. The real service keeps running
  // throughout, untouched, which is the whole assertion.
  //
  // ⚠️ The stand-in runs in a CHILD PROCESS, and it has to. An `http.createServer`
  // in THIS process cannot answer anything while `execFileSync` is running the
  // CLI, because that blocks the event loop the server listens on — the kernel
  // accepts the connection into the backlog and Node never gets to it, so the
  // CLI's fetch times out, `checkBusy` reads a timeout as "not running", and the
  // stop goes ahead and PASSES its way to a green `exit 0`. That is how this test
  // failed on both real runners the first time it ran.
  step("stop and restart refuse with 75 while the instance reports itself busy");
  const fakePort = await freePort();
  const fake = spawn(
    process.execPath,
    [
      "-e",
      "const b=JSON.parse(process.env.BODY);" +
        "require('node:http').createServer((q,s)=>{" +
        "s.writeHead(200,{'content-type':'application/json'});s.end(JSON.stringify(b));" +
        "}).listen(Number(process.env.PORT),'127.0.0.1');",
    ],
    {
      stdio: ["ignore", "ignore", "inherit"],
      env: {
        ...process.env,
        PORT: String(fakePort),
        BODY: JSON.stringify({ busy: true, version, counts: { chat: 2, background: 0, job: 0 } }),
      },
    },
  );
  try {
    // `pid` must name a LIVE process or the file reads as stale (a crashed
    // instance leaves one behind), so it names the stand-in — which is also the
    // honest answer: that process IS the thing answering on that port.
    fs.writeFileSync(
      runtimeFile,
      JSON.stringify(
        { ...runtime, pid: fake.pid, port: fakePort, url: `http://127.0.0.1:${fakePort}` },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    // Prove the stand-in is answering BEFORE asserting on a refusal, so a child
    // that failed to start reads as a broken rig rather than as a broken guard.
    const standIn = await until(`the stand-in /api/busy on ${fakePort}`, async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${fakePort}/api/busy`, {
          signal: AbortSignal.timeout(2000),
        });
        return res.ok ? await res.json() : undefined;
      } catch {
        return undefined;
      }
    });
    assert.equal(standIn.busy, true);

    const refusedStop = expectExit(75, "service", "stop");
    assert.match(refusedStop.stderr, /is busy: 2 chat turns are running/);
    assert.match(refusedStop.stderr, /from a terminal/, "the keeper-chat trap (ROADMAP)");
    const refusedRestart = expectExit(75, "service", "restart");
    assert.match(refusedRestart.stderr, /is busy: 2 chat turns are running/);
    // THE assertion: neither refusal touched the real service.
    const stillUp = await health(port);
    assert.equal(stillUp?.ok, true, "a refused stop leaves the service running");
    assert.equal(
      JSON.parse(paddock("service", "status", "--json").stdout).pid,
      s.pid,
      "a refused restart did not bounce it either",
    );

    step("stop --force prints the same message prefixed `Overriding:`, and stops it");
    const forced = expectExit(0, "service", "stop", "--force");
    assert.match(forced.stderr, /^Overriding: .*is busy: 2 chat turns are running\.$/m);
    await until(`nothing on ${port}`, async () => (await health(port)) === undefined);
    statusJson(3);
  } finally {
    fake.kill();
    // Ours, not the server's: `removeRuntimeFile` only removes a file naming its
    // own pid, so the stop above correctly left this one alone.
    fs.rmSync(runtimeFile, { force: true });
  }

  step("start again, and the real runtime.json comes back");
  expectExit(0, "service", "start");
  await until("health after start", () => health(port));
  await until("runtime.json", () => fs.existsSync(runtimeFile));
  expectExit(0, "busy");
  s = statusJson(0);

  step("logs");
  const logged = expectExit(0, "service", "logs", "-n", "5").stdout;
  assert.ok(logged.trim() !== "", "logs printed something");

  step("an unknown flag: exit 2");
  const bad = expectExit(2, "service", "status", "--nope");
  assert.match(bad.stderr, /unknown option: --nope/);
  assert.match(bad.stderr, /Usage/, "the usage follows the message (SPEC §2)");

  step(`SIGKILL pid ${s.pid}: the supervisor brings it back`);
  const old = s.pid;
  process.kill(old, "SIGKILL");
  await until("a new process", async () => {
    const n = JSON.parse(paddock("service", "status", "--json").stdout);
    return n.running && n.pid !== old && n.answering;
  });

  step("stop an IDLE service: not refused — exit 0, status 3, logs still 0, busy 3");
  // The control for the refusal above: the busy check must not get in the way of
  // the ordinary stop. This one runs against the REAL `/api/busy`, with no
  // `--force` and nothing faked.
  expectExit(0, "service", "stop");
  await until(`nothing on ${port}`, async () => (await health(port)) === undefined);
  s = statusJson(3);
  assert.equal(s.installed, true);
  assert.equal(s.answering, false);
  expectExit(0, "service", "logs", "-n", "3");
  // Removed on the way out, so nothing later finds a live-looking instance. The
  // supervisor's stop is a real SIGTERM, which is the path that removes it.
  await until("runtime.json to go", () => !fs.existsSync(path.join(data, "runtime.json")));
  expectExit(3, "busy");

  step("start");
  expectExit(0, "service", "start");
  await until("health after start", () => health(port));
  statusJson(0);

  step("restart");
  expectExit(0, "service", "restart");
  await until("health after restart", () => health(port));

  step("uninstall: the unit goes, the data and logs stay");
  const dataBefore = fs.readdirSync(data).sort();
  const logBefore = fs.readFileSync(logFile, "utf8");
  assert.ok(logBefore.includes("Paddock "), "the log has content to keep");
  expectExit(0, "service", "uninstall");
  installed = false;
  assert.ok(!fs.existsSync(unit), "the unit file is gone");
  await until(`nothing on ${port}`, async () => (await health(port)) === undefined);
  statusJson(4);
  expectExit(4, "service", "logs");
  // (the server may add to the data dir as it stops: only what was there before matters)
  for (const f of dataBefore) {
    assert.ok(fs.existsSync(path.join(data, f)), `${f} is still in the data dir`);
  }
  assert.ok(fs.readFileSync(logFile, "utf8").startsWith(logBefore), "the logs are kept");
  expectExit(0, "service", "uninstall"); // idempotent
  step("ok");
} finally {
  if (installed) {
    try {
      paddock("service", "uninstall");
    } catch (e) {
      console.error(`service-real: cleanup: ${e.message}`);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

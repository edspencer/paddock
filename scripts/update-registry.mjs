// `paddock update` against a LOCAL registry serving two real packed builds (CLI contract SPEC §5,
// §6; rollout task C2).
//
// The package is used exactly as a user gets it: staged by `scripts/make-npm-package.mjs`, packed,
// installed globally with a real `npm install -g`, and driven from the installed bin. The registry
// is `scripts/fake-registry.mjs`, pointed at by `npm_config_registry`; it serves our package from
// disk and forwards every dependency upstream, so the install is a real one.
//
// Three builds come out of ONE compile, which is what makes this cheap enough to iterate on:
//
//   A  the repo's own version                      the "installed" version
//   B  the same tree with both manifests bumped    the "available" version
//   C  B again, with `dist/version.js` rewritten so the SERVER reports a version that is not the
//      one on disk. `--version` still answers C, so the install is proven to have taken; the
//      health check then sees the wrong version and must roll back (SPEC §5 steps 12, 13).
//
// ## What it covers
//
//   up to date                                 exit 0, nothing installed
//   an update (no service)                     exit 0, the new version is on disk
//   --to a LOWER version                       exit 0 — and the same run without --to exits 0
//                                              saying there is nothing to do
//   --check / --check --json                   exit 0, one JSON document, the cache written
//   a checkout                                 exit 5, `git pull && npm install && npm run build`
//   an npx cache                               exit 5, `npx …@latest`
//   a non-writable global folder               exit 5 with the sudo line (non-root only; see below)
//   busy                                       exit 75, before anything is stopped
//   no TTY and no --yes                        exit 2
//   PADDOCK_IN_DOCKER=1                        exit 5 with the image-pull command
//   PADDOCK_UPDATE_HINT                        exit 5 printing the hint
//   the whole §5 sequence, WITH a service      exit 0, the unit re-rendered, health reports B
//   a target that fails its health check       exit 6, rolled back, the old version answering
//
// ## Production safety — the part that is absolute
//
// This box runs the real Paddock as its own PID 1 and exports `PADDOCK_DATA_DIR` pointing at the
// LIVE instance. So every child here runs with a throwaway `HOME`, `XDG_CONFIG_HOME`,
// `PADDOCK_DATA_DIR`, npm prefix and npm cache, with `PADDOCK_DRIVE_MODE=batch` and no credentials
// — and `assertIsolated()` below refuses to go on unless `npm root -g`, resolved through that
// environment, really is inside the temp directory. Nothing here ever touches the real global
// prefix, the real `~/.paddock`, or the box's own service.
//
// ## The service half, and where it is really proven
//
// There is no systemd and no launchd here, so the service-backed scenarios run under
// `scripts/standin-systemctl.mjs` — a supervisor real enough for the sequence, and no substitute
// for the real thing. The real managers are covered by `scripts/service-real.mjs` on GitHub's
// ubuntu and macOS runners, which since C2 also installs at A, updates to B, and checks the unit
// was refreshed and health reports B. On darwin this script runs everything EXCEPT the
// service-backed scenarios and says so.
//
//   node scripts/update-registry.mjs            # all of it
//   node scripts/update-registry.mjs --keep     # leave the temp dir for inspection
import { execFileSync, spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "paddock-update-")));
const prefix = path.join(tmp, "prefix");
const data = path.join(tmp, "data");
const fakeHome = path.join(tmp, "home");
const shimDir = path.join(tmp, "shim");
const work = path.join(tmp, "work");
const npmCache = path.join(tmp, "npm-cache");
const standinDir = path.join(tmp, "standin");
const stateFile = path.join(tmp, "registry.json");
for (const d of [prefix, fakeHome, shimDir, work, npmCache, standinDir]) {
  fs.mkdirSync(d, { recursive: true });
}

const step = (s) => console.log(`\nupdate-registry: ${s}`);
const note = (s) => console.log(`  ${s}`);

// ---------------------------------------------------------------------------
// The environment every child runs in
// ---------------------------------------------------------------------------

const PACKAGE = "@edspencer/paddock";
const BIN_SUBPATH = path.join("packages", "server", "dist", "cli", "paddock.js");

/** The npm beside this node, so a shim on PATH cannot shadow it. */
const npmBin = (() => {
  const beside = path.join(path.dirname(process.execPath), "npm");
  return fs.existsSync(beside) ? beside : "npm";
})();

let registryUrl = "";

function baseEnv() {
  const env = { ...process.env };
  // Everything that could reach production, or spend money, or make a child find the real
  // instance. `PADDOCK_DATA_DIR` is the dangerous one: this box exports it.
  for (const k of [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CONFIG_DIR",
    "PADDOCK_PROJECTS_DIR",
    "PADDOCK_KEEPER_DRIVE_MODE",
    "PADDOCK_UPDATE_HINT",
    "PADDOCK_IN_DOCKER",
    "PORT",
    "HOST",
    "NODE_ENV",
    "NODE_OPTIONS",
    "npm_config_global_prefix",
  ]) {
    delete env[k];
  }
  return {
    ...env,
    HOME: fakeHome,
    XDG_CONFIG_HOME: path.join(fakeHome, ".config"),
    PADDOCK_DATA_DIR: data,
    PADDOCK_DRIVE_MODE: "batch",
    PADDOCK_AUTH_MODE: "none",
    STANDIN_SYSTEMD_DIR: standinDir,
    npm_config_prefix: prefix,
    npm_config_cache: npmCache,
    npm_config_registry: registryUrl,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    // The shim dir first, so `systemctl` is ours; then node's own bin, so `npm` resolves.
    PATH: [shimDir, path.dirname(process.execPath), env.PATH ?? ""].filter(Boolean).join(path.delimiter),
  };
}

/**
 * Refuse to continue unless the global prefix this environment resolves really is ours.
 *
 * The check that matters, and the only one that cannot be fooled by reading the env object we just
 * built: ask npm, through the same environment the CLI will inherit, where it would install. If
 * that is not inside the temp directory, something (an `.npmrc`, a `NPM_CONFIG_PREFIX`, a wrapper)
 * has overridden us and the next `npm install -g` would land on the real machine.
 */
function assertIsolated(env) {
  const r = spawnSync(npmBin, ["root", "-g"], { env, encoding: "utf8" });
  const resolved = (r.stdout ?? "").trim().split("\n").at(-1) ?? "";
  assert.ok(
    resolved.startsWith(tmp),
    `refusing to run: \`npm root -g\` resolves to ${JSON.stringify(resolved)}, which is not under ${tmp}`,
  );
  assert.equal(env.PADDOCK_DATA_DIR, data);
  assert.equal(env.HOME, fakeHome);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.PADDOCK_DRIVE_MODE, "batch");
  return resolved;
}

const bin = path.join(prefix, "bin", "paddock");

/**
 * Run the installed CLI. `spawnSync`, never `execFileSync`.
 *
 * `execFileSync` RETURNS stdout and only exposes stderr by throwing, so every command that
 * SUCCEEDED handed back `stderr: ''` — which on this contract is a lie by construction, because
 * SPEC §3 puts all the prose on stderr and keeps stdout for the one JSON document. Wave C1 lost a
 * CI run to exactly that.
 */
function paddock(args, over = {}) {
  // `over.node` runs a cli.js through this interpreter, for the checkout case: the repo's built
  // CLI has no execute bit, and `node <cli.js>` is also what makes `process.argv[1]` the path
  // SPEC §6 walks up from.
  const cmd = over.node !== undefined ? process.execPath : (over.bin ?? bin);
  const argv = over.node !== undefined ? [over.node, ...args] : args;
  const r = spawnSync(cmd, argv, {
    cwd: over.cwd ?? work,
    env: { ...baseEnv(), ...(over.env ?? {}) },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: over.timeoutMs ?? 300_000,
  });
  if (r.error !== undefined) throw r.error;
  if (r.status === null) {
    throw new Error(`paddock ${args.join(" ")} was killed by ${r.signal}\n${r.stdout}\n${r.stderr}`);
  }
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function expectExit(code, args, over = {}) {
  const r = paddock(args, over);
  assert.equal(
    r.code,
    code,
    `paddock ${args.join(" ")} exited ${r.code}, expected ${code}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`,
  );
  return r;
}

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
    await sleep(300);
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

// ---------------------------------------------------------------------------
// The three builds
// ---------------------------------------------------------------------------

/** Stage `dist-npm`, patch it to `version`, pack it, and return the tarball path + manifest. */
function build(version, patch) {
  const staged = path.join(root, "dist-npm");
  // Both manifests: npm reads the root one, and the CLI reads its own version from
  // packages/server/package.json (see version.ts and make-npm-package.mjs).
  for (const rel of ["package.json", path.join("packages", "server", "package.json")]) {
    const file = path.join(staged, rel);
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    json.version = version;
    fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  }
  patch?.(staged, version);
  const packed = execFileSync(npmBin, ["pack", "--json", "--pack-destination", tmp], {
    cwd: staged,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const name = JSON.parse(packed.slice(packed.search(/^\[$/m))).at(-1).filename;
  const to = path.join(tmp, `${version}.tgz`);
  fs.renameSync(path.join(tmp, name), to);
  const manifest = JSON.parse(fs.readFileSync(path.join(staged, "package.json"), "utf8"));
  return { version, tarball: to, manifest };
}

/**
 * The sabotage that makes a health check fail honestly.
 *
 * `version.ts` is the ONE place the running server's version comes from — `/api/health`, the
 * OpenAPI document and the MCP handshake all read it — so rewriting it makes the server report a
 * version that is not the one on disk. `--version` is answered before that module loads, from a
 * shim prepended to the CLI, so `update` can still prove the install took (SPEC §5 step 10) and
 * then fail at step 12 for the right reason.
 *
 * This is a simulation and it says so. What it simulates is real and not rare: a build whose
 * version and whose running code disagree, which is what a half-finished install, a stale
 * `dist/` or a bad publish looks like from the outside.
 */
function sabotageVersion(staged, version) {
  const versionModule = path.join(staged, "packages", "server", "dist", "version.js");
  fs.writeFileSync(
    versionModule,
    'export const PADDOCK_VERSION = "0.0.0-not-the-installed-version";\nexport const PADDOCK_NAME = "Paddock";\n',
  );
  const cli = path.join(staged, BIN_SUBPATH);
  fs.writeFileSync(
    cli,
    `#!/usr/bin/env node\nif (process.argv.includes("--version") || process.argv.includes("-v")) {\n  console.log(${JSON.stringify(version)});\n  process.exit(0);\n}\n` +
      fs.readFileSync(cli, "utf8").replace(/^#!.*\n/, ""),
  );
}

function bumped(version, by) {
  const [maj, min, patch] = version.split("-")[0].split(".").map(Number);
  return by === "minor" ? `${maj}.${min + 1}.0` : `${maj}.${min}.${patch + by}`;
}

// ---------------------------------------------------------------------------
// The registry's state
// ---------------------------------------------------------------------------

let builds = {};
function setRegistry(distTags) {
  fs.writeFileSync(
    stateFile,
    JSON.stringify(
      {
        name: PACKAGE,
        distTags,
        versions: Object.fromEntries(
          Object.values(builds).map((b) => [b.version, { tarball: b.tarball, manifest: b.manifest }]),
        ),
      },
      null,
      2,
    ),
  );
}

function installGlobally(version) {
  const r = spawnSync(npmBin, ["install", "--global", "--no-audit", "--no-fund", builds[version].tarball], {
    env: baseEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 600_000,
  });
  assert.equal(r.status, 0, `npm install -g ${version} failed:\n${r.stdout}\n${r.stderr}`);
  assert.equal(paddock(["--version"]).stdout.trim(), version, `the installed bin reports ${version}`);
}

const installedVersion = () =>
  JSON.parse(
    fs.readFileSync(path.join(prefix, "lib", "node_modules", PACKAGE, "package.json"), "utf8"),
  ).version;

// ---------------------------------------------------------------------------

let registry;
let standInService = false;
try {
  // --- the shim, the builds and the registry ------------------------------

  step("write the stand-in systemctl onto PATH");
  const shim = path.join(shimDir, "systemctl");
  fs.writeFileSync(
    shim,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, "scripts", "standin-systemctl.mjs"))} "$@"\n`,
  );
  fs.chmodSync(shim, 0o755);

  step("build once, pack three versions");
  execFileSync(npmBin, ["run", "pack:npm"], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "development" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const A = JSON.parse(fs.readFileSync(path.join(root, "packages", "server", "package.json"), "utf8")).version;
  const B = bumped(A, "minor");
  const C = bumped(B, 1);
  builds = {
    [A]: build(A),
    [B]: build(B),
    [C]: build(C, sabotageVersion),
  };
  note(`A=${A} (installed)  B=${B} (available)  C=${C} (installs, reports the wrong version)`);
  // The sabotage is real: prove C's bin answers C while its version module does not.
  assert.match(fs.readFileSync(path.join(root, "dist-npm", "packages", "server", "dist", "version.js"), "utf8"), /not-the-installed-version/);

  step("start the local registry");
  setRegistry({ latest: A });
  const port = await freePort();
  registry = spawn(process.execPath, [path.join(root, "scripts", "fake-registry.mjs"), stateFile, String(port)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    registry.stdout.setEncoding("utf8");
    registry.stdout.on("data", (chunk) => {
      if (chunk.includes("listening")) resolve();
    });
    registry.on("exit", (code) => reject(new Error(`the registry exited ${code}`)));
    setTimeout(() => reject(new Error("the registry did not start")), 15_000);
  });
  registryUrl = `http://127.0.0.1:${port}/`;
  note(`registry ${registryUrl}`);

  step("refuse unless the environment is really isolated");
  const globalRoot = assertIsolated(baseEnv());
  note(`npm root -g → ${globalRoot}`);

  // --- a checkout cannot update itself (SPEC §6 row 4) --------------------

  step("a checkout: exit 5, and the command that WOULD work");
  // `latest` has to be AHEAD of the checkout, or there is nothing to refuse: an install that
  // cannot update itself and is already up to date exits 0, which is the right answer and is
  // asserted below.
  setRegistry({ latest: B });
  // The repo's own built CLI, run in place. Nothing is called @edspencer/paddock in the checkout
  // (the published package is synthesized), so §6's walk-up finds no named root and the
  // "not under node_modules" test fires — which is the right answer.
  const checkout = expectExit(5, ["update", "--yes"], {
    node: path.join(root, "packages", "server", "dist", "cli", "paddock.js"),
    cwd: root,
  });
  assert.match(checkout.stdout, /Run: git pull && npm install && npm run build/);
  assert.match(checkout.stderr, /cannot update itself/);
  assert.match(checkout.stderr, /running from a checkout/);
  setRegistry({ latest: A });

  // --- install A ----------------------------------------------------------

  step(`install ${A} globally (a real npm install -g, into ${prefix})`);
  installGlobally(A);
  assert.equal(installedVersion(), A);

  // --- the cheap refusals, before anything is installed -------------------

  step("up to date: exit 0, and nothing is installed");
  setRegistry({ latest: A });
  const same = expectExit(0, ["update", "--yes"]);
  assert.match(same.stdout, new RegExp(`Paddock ${A.replace(/\./g, "\\.")} is up to date`));
  assert.equal(installedVersion(), A);
  // The cache was written, which is what `service status` repeats (SPEC §3).
  const cached = JSON.parse(fs.readFileSync(path.join(data, "update-check.json"), "utf8"));
  assert.equal(cached.updateAvailable, false);
  assert.equal(cached.installMethod, "npm-global");
  assert.equal(cached.canUpdate, true);
  assert.equal(fs.statSync(path.join(data, "update-check.json")).mode & 0o077, 0);

  step("--check and --check --json: report, change nothing");
  setRegistry({ latest: B });
  const check = expectExit(0, ["update", "--check"]);
  assert.match(check.stdout, new RegExp(`Paddock ${B.replace(/\./g, "\\.")} is available \\(you have ${A.replace(/\./g, "\\.")}\\)`));
  assert.match(check.stdout, /Run: paddock update/);
  assert.equal(installedVersion(), A);
  const asJson = expectExit(0, ["update", "--check", "--json"]);
  const doc = JSON.parse(asJson.stdout);
  // One JSON document on stdout and nothing else (SPEC §1).
  assert.equal(asJson.stdout.trim().split("\n").at(-1), "}");
  for (const key of ["name", "current", "target", "updateAvailable", "installMethod", "canUpdate"]) {
    assert.ok(key in doc, `--check --json carries ${key} (schemas/update-check.schema.json)`);
  }
  assert.deepEqual(
    { name: doc.name, current: doc.current, target: doc.target, updateAvailable: doc.updateAvailable, installMethod: doc.installMethod, canUpdate: doc.canUpdate, nodeOk: doc.nodeOk, tag: doc.tag },
    { name: PACKAGE, current: A, target: B, updateAvailable: true, installMethod: "npm-global", canUpdate: true, nodeOk: true, tag: "latest" },
  );
  assert.equal(doc.engines, ">=22", "the target's engines, read from the registry manifest");
  // Prose on stderr, never on stdout, under --json (SPEC §3).
  assert.match(asJson.stderr, /is available/);

  step("no TTY and no --yes: exit 2");
  const needsYes = expectExit(2, ["update"]);
  assert.match(needsYes.stderr, /no terminal to ask, so `--yes` is required/);
  assert.match(needsYes.stderr, /Usage/, "the usage follows the message (SPEC §2)");
  assert.equal(installedVersion(), A);

  step("PADDOCK_IN_DOCKER=1: exit 5 with the image-pull command (SPEC §6 row 1, §9)");
  const docker = expectExit(5, ["update", "--yes"], { env: { PADDOCK_IN_DOCKER: "1" } });
  assert.match(docker.stdout, /Run: docker compose pull && docker compose up -d/);
  assert.match(docker.stdout, new RegExp(`image ghcr\\.io/edspencer/paddock:${B.replace(/\./g, "\\.")}`));
  // `--check` in a container REPORTS rather than refusing — the line SPEC §9 asks for.
  const dockerCheck = expectExit(0, ["update", "--check"], { env: { PADDOCK_IN_DOCKER: "1" } });
  assert.match(dockerCheck.stdout, /docker compose pull/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, "update-check.json"), "utf8")).installMethod, "docker");

  step("PADDOCK_UPDATE_HINT: exit 5 printing the hint (SPEC §6 row 2)");
  const hint = expectExit(5, ["update", "--yes"], {
    env: { PADDOCK_UPDATE_HINT: "ansible-playbook -i prod paddock.yml" },
  });
  assert.match(hint.stdout, /Run: ansible-playbook -i prod paddock\.yml/);
  assert.match(hint.stderr, /managed by something outside/);

  step("an npx cache: exit 5 (SPEC §6 row 3)");
  const npx = spawnSync(
    path.join(path.dirname(npmBin), "npx"),
    ["-y", `--package=${builds[A].tarball}`, "paddock", "update", "--yes"],
    { cwd: work, env: baseEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000 },
  );
  assert.equal(npx.status, 5, `npx update exited ${npx.status}\n${npx.stdout}\n${npx.stderr}`);
  assert.match(npx.stdout, new RegExp(`Run: npx ${PACKAGE.replace("/", "\\/")}@latest`));
  assert.match(npx.stderr, /npx \/ dlx cache/);

  if (process.getuid?.() === 0) {
    step("SKIPPED: a non-writable global folder — this process is root, and root ignores the mode bits");
    note("Covered on CI, where the runner is not root. See the `update` job in ci.yml.");
  } else {
    step("a non-writable global folder: exit 5 with the sudo line, and no sudo is run (SPEC §5 step 5)");
    const modes = path.join(prefix, "lib", "node_modules");
    const before = fs.statSync(modes).mode;
    fs.chmodSync(modes, 0o500);
    try {
      const ro = expectExit(5, ["update", "--yes"]);
      assert.match(ro.stdout, new RegExp(`Run: sudo npm install -g ${PACKAGE.replace("/", "\\/")}@${B.replace(/\./g, "\\.")}`));
      assert.match(ro.stdout, /the global folder isn't writable/);
      assert.match(ro.stderr, /is not writable by this user/);
    } finally {
      fs.chmodSync(modes, before);
    }
    assert.equal(installedVersion(), A);
  }

  // --- busy (SPEC §5 step 6) ---------------------------------------------

  step("busy: exit 75, before anything is stopped");
  // The stand-in answers from a CHILD process, and it has to: an http server in THIS process
  // cannot answer while spawnSync blocks the event loop it listens on, so the CLI's fetch would
  // time out, `checkBusy` would read that as "not running", and the update would go ahead and
  // PASS. That is how wave C1 failed two real-service CI jobs.
  const busyPort = await freePort();
  const busyServer = spawn(
    process.execPath,
    [
      "-e",
      "require('node:http').createServer((q,s)=>{s.writeHead(200,{'content-type':'application/json'});" +
        "s.end(process.env.BODY);}).listen(Number(process.env.PORT),'127.0.0.1');",
    ],
    {
      stdio: ["ignore", "ignore", "inherit"],
      env: {
        ...process.env,
        PORT: String(busyPort),
        BODY: JSON.stringify({ busy: true, version: A, counts: { chat: 2, background: 0, job: 0 } }),
      },
    },
  );
  try {
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(
      path.join(data, "runtime.json"),
      JSON.stringify({
        pid: busyServer.pid,
        port: busyPort,
        url: `http://127.0.0.1:${busyPort}`,
        version: A,
        startedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    const answered = await until("the stand-in /api/busy", async () => {
      const res = await fetch(`http://127.0.0.1:${busyPort}/api/busy`, { signal: AbortSignal.timeout(2000) });
      return res.ok ? await res.json() : undefined;
    });
    assert.equal(answered.busy, true);

    const busy = expectExit(75, ["update", "--yes"]);
    assert.match(busy.stderr, /is busy: 2 chat turns are running/);
    assert.match(busy.stderr, /from a terminal, not from inside a Paddock chat/, "the keeper-chat trap");
    assert.match(busy.stderr, /paddock update --force/);
    assert.equal(installedVersion(), A, "a refused update installs nothing");

    // `--force` skips the busy check and NOTHING else (SPEC §1), which this proves twice over: the
    // `Overriding:` line says the check was overridden, and then step 9 still refuses — there is a
    // foreground instance answering and no service to stop it, so installing over it is exactly
    // the failure that step's ordering exists to prevent.
    step("--force gets past the busy check, and step 9 still refuses under a foreground serve");
    const forced = expectExit(3, ["update", "--yes", "--force"]);
    assert.match(forced.stderr, /^Overriding: .*is busy: 2 chat turns are running\.$/m);
    assert.match(forced.stderr, /there is no service to stop/);
    assert.match(forced.stderr, /Stop it \(Ctrl-C in its terminal\)/);
    assert.equal(installedVersion(), A, "nothing was installed under a running server");
  } finally {
    busyServer.kill();
    fs.rmSync(path.join(data, "runtime.json"), { force: true });
  }

  step(`an update with nothing running: exit 0, and ${B} is really on disk`);
  const updated = expectExit(0, ["update", "--yes"]);
  assert.match(updated.stdout, new RegExp(`Updated Paddock ${A.replace(/\./g, "\\.")} → ${B.replace(/\./g, "\\.")}`));
  assert.equal(installedVersion(), B);
  assert.equal(paddock(["--version"]).stdout.trim(), B, "the installed bin is the new one");
  // Fetched before anything was touched, and both versions, so a rollback has its package to
  // hand (SPEC §5 step 8).
  assert.match(updated.stderr, new RegExp(`Fetching @edspencer/paddock@${B.replace(/\./g, "\\.")}`));
  assert.ok(!updated.stderr.includes("rollback would need the network"), `both versions cached:\n${updated.stderr}`);

  // --- a downgrade needs --to (SPEC §5 step 4) ---------------------------

  step("a lower version is NOT taken without --to");
  setRegistry({ latest: A });
  const ahead = expectExit(0, ["update", "--yes"]);
  assert.match(ahead.stdout, new RegExp(`is newer than the registry's latest \\(${A.replace(/\./g, "\\.")}\\)`));
  assert.equal(installedVersion(), B);

  step("--to a lower version: exit 0, and it really goes back");
  const down = expectExit(0, ["update", "--yes", "--to", A]);
  assert.match(down.stdout, new RegExp(`Updated Paddock ${B.replace(/\./g, "\\.")} → ${A.replace(/\./g, "\\.")}`));
  assert.equal(installedVersion(), A);
  assert.equal(paddock(["--version"]).stdout.trim(), A);

  step("--to a dist-tag that does not exist: exit 1, naming the tags that do");
  const badTag = expectExit(1, ["update", "--yes", "--to", "nightly"]);
  assert.match(badTag.stderr, /no dist-tag `nightly`/);
  assert.match(badTag.stderr, /latest/);

  step("two updates cannot interleave (SPEC §5 step 1)");
  fs.writeFileSync(
    path.join(data, "update.lock"),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  try {
    setRegistry({ latest: B });
    const locked = expectExit(1, ["update", "--yes"]);
    assert.match(locked.stderr, new RegExp(`another update is already running \\(pid ${String(process.pid)}`));
    assert.equal(installedVersion(), A);
  } finally {
    fs.rmSync(path.join(data, "update.lock"), { force: true });
  }

  // --- the whole sequence, with a service --------------------------------

  if (process.platform !== "linux") {
    step("SKIPPED: the service-backed scenarios need the stand-in systemctl, which is Linux-only");
    note("Covered on CI's macOS runner by scripts/service-real.mjs against real launchd.");
  } else {
    const servicePort = await freePort();
    step(`service install --port ${servicePort} at ${A}, under the stand-in systemd`);
    const unit = path.join(fakeHome, ".config", "systemd", "user", "paddock.service");
    const installed = expectExit(0, ["service", "install", "--port", String(servicePort)]);
    standInService = true;
    assert.match(installed.stdout, new RegExp(`running at http://127\\.0\\.0\\.1:${servicePort}`));
    const first = await until("health at A", () => health(servicePort));
    assert.equal(first.version, A, "/api/health reports the installed version (SPEC §8)");
    const unitBefore = fs.readFileSync(unit, "utf8");
    // The verb, not the substring: every path in the line contains "server".
    assert.match(unitBefore, /^ExecStart=\S+ \S+ serve /m);
    assert.match(unitBefore, new RegExp(`--port ${servicePort}`));

    step(`update ${A} → ${B}: the whole §5 sequence`);
    setRegistry({ latest: B });
    const updated = expectExit(0, ["update", "--yes"]);
    assert.match(updated.stdout, new RegExp(`Updated Paddock ${A.replace(/\./g, "\\.")} → ${B.replace(/\./g, "\\.")}`));
    // The ORDER, read back off the transcript: busy, fetch, stop, install, refresh, health.
    for (const line of [
      /Fetching @edspencer\/paddock@/,
      /Stopping the Paddock service/,
      /Installing @edspencer\/paddock@.* with npm/,
      /Refreshing the service unit with the new version/,
      /Waiting for .* to answer at/,
    ]) {
      assert.match(updated.stderr, line, `the sequence printed ${String(line)}`);
    }
    assert.equal(installedVersion(), B);
    const afterUpdate = await until(`health at ${B}`, async () => {
      const h = await health(servicePort);
      return h?.version === B ? h : undefined;
    });
    assert.equal(afterUpdate.version, B);

    step("the unit was re-rendered by the NEW CLI, keeping its port (SPEC §5 step 11)");
    const unitAfter = fs.readFileSync(unit, "utf8");
    assert.match(unitAfter, new RegExp(`--port ${servicePort}`), "the port survived the refresh");
    assert.ok(unitAfter.includes(path.join(prefix, "lib", "node_modules", PACKAGE)), "it runs the installed CLI");
    // The control: the file really was rewritten, not merely left alone and found to match.
    assert.notEqual(fs.statSync(unit).mtimeMs, fs.statSync(path.join(tmp, `${A}.tgz`)).mtimeMs);

    step("service status: exit 0, versions agree, and it repeats the cached check (SPEC §3)");
    const status = JSON.parse(expectExit(0, ["service", "status", "--json"]).stdout);
    assert.equal(status.installedVersion, B);
    assert.equal(status.runningVersion, B);
    assert.equal(status.port, servicePort);
    assert.deepEqual(status.warnings, [], `no warnings: ${JSON.stringify(status.warnings)}`);
    assert.equal(status.update.updateAvailable, false, "the cache says up to date, because it is");
    assert.equal(status.update.latest, B);
    // And when the cache says otherwise, the prose repeats it on STDERR.
    setRegistry({ latest: C });
    expectExit(0, ["update", "--check"]);
    const nagging = expectExit(0, ["service", "status"]);
    assert.ok(!nagging.stdout.includes("is available"), "the notice is not on stdout (SPEC §3)");
    assert.match(nagging.stderr, new RegExp(`${C.replace(/\./g, "\\.")} is available`));

    step(`update ${B} → ${C}, whose server reports the wrong version: roll back, exit 6`);
    const rolled = expectExit(6, ["update", "--yes"]);
    assert.match(rolled.stderr, /answers with 0\.0\.0-not-the-installed-version/);
    assert.match(rolled.stderr, /The last 20 lines of/, "the log tail (SPEC §5 step 13)");
    assert.match(
      rolled.stderr,
      new RegExp(`${C.replace(/\./g, "\\.")} didn't start; ${B.replace(/\./g, "\\.")} is running again\\.`),
    );
    // THE assertion: the old version is installed AND serving again.
    assert.equal(installedVersion(), B, "the rollback reinstalled the old version");
    const back = await until(`health at ${B} again`, async () => {
      const h = await health(servicePort);
      return h?.version === B ? h : undefined;
    });
    assert.equal(back.version, B);
    const unitRestored = fs.readFileSync(unit, "utf8");
    assert.match(unitRestored, new RegExp(`--port ${servicePort}`), "the unit still names the port");
    assert.equal(JSON.parse(expectExit(0, ["service", "status", "--json"]).stdout).runningVersion, B);

    step("uninstall");
    expectExit(0, ["service", "uninstall"]);
    standInService = false;
    assert.ok(!fs.existsSync(unit));
    await until("nothing on the service port", async () => (await health(servicePort)) === undefined);
  }

  step("ok — every scenario passed");
} finally {
  if (standInService) {
    try {
      paddock(["service", "uninstall"]);
    } catch (e) {
      console.error(`update-registry: cleanup: ${e.message}`);
    }
  }
  registry?.kill();
  if (keep) console.log(`\nupdate-registry: left ${tmp} in place (--keep)`);
  else fs.rmSync(tmp, { recursive: true, force: true });
}

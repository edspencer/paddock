// A stand-in `systemctl --user`, so the service half of `paddock update` can be driven on a box
// that has no systemd (CLI contract SPEC §5, §7).
//
// This dev box is a container with tini as PID 1: there is no user systemd and no launchd, so the
// only thing the real managers are proven against is CI (`scripts/service-real.mjs` on GitHub's
// ubuntu and macOS runners). That leaves the most interesting half of §5 — stop, install, hand
// over to the new CLI, poll health, roll back — untestable anywhere a person can iterate, which is
// how a rollback ships broken.
//
// So this is a supervisor that is real enough for the sequence: it reads the unit Paddock wrote,
// runs its `ExecStart` with its `Environment=` and its log redirection, tracks the pid, and
// answers `is-active` / `show -p MainPID` honestly.
//
// ## What it deliberately does NOT do
//
// **It does not restart a process that exits.** The unit says `Restart=always`, and honouring that
// would make a server which crashes shortly after boot answer `/api/health` intermittently — so
// `update`'s version poll would pass or fail depending on timing. A supervisor that stays out of
// the way makes the rollback test deterministic. It also does not care about `WantedBy`, ordering,
// cgroups or `KillMode`, which is exactly the class of thing only real systemd can tell us about:
// this stand-in can never replace the real-service CI, only make the iteration loop usable.
//
// Invoked as `systemctl` through a shim earlier on PATH than the real one, if any. State lives in
// `$STANDIN_SYSTEMD_DIR`, units in `$XDG_CONFIG_HOME/systemd/user`.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const stateDir = process.env.STANDIN_SYSTEMD_DIR;
if (stateDir === undefined) {
  process.stderr.write("standin-systemctl: STANDIN_SYSTEMD_DIR is not set\n");
  process.exit(1);
}
fs.mkdirSync(stateDir, { recursive: true });

const unitDir = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? "/", ".config"),
  "systemd",
  "user",
);

// `--user` and `--now` are flags we honour by doing the only thing this stand-in does.
const args = process.argv.slice(2).filter((a) => a !== "--user");
const verb = args[0];
const now = args.includes("--now");
const rest = args.filter((a) => !a.startsWith("-"));
const unit = rest.at(-1) ?? "";

const pidFile = (u) => path.join(stateDir, `${u}.pid`);
const enabledFile = (u) => path.join(stateDir, `${u}.enabled`);
const unitFile = (u) => path.join(unitDir, u);

const log = (s) => process.stdout.write(`${s}\n`);
const die = (s, code = 1) => {
  process.stderr.write(`standin-systemctl: ${s}\n`);
  process.exit(code);
};

/** Split an `ExecStart=` value into its words, honouring systemd's quoting. */
function execWords(line) {
  const out = [];
  let cur = "";
  let quote = null;
  let any = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote !== null) {
      if (c === "\\" && line[i + 1] !== undefined) {
        cur += line[++i];
      } else if (c === quote) {
        quote = null;
      } else {
        cur += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      any = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur !== "" || any) out.push(cur);
      cur = "";
      any = false;
      continue;
    }
    cur += c;
  }
  if (cur !== "" || any) out.push(cur);
  // `%%` is systemd's escape for a literal `%`.
  return out.map((w) => w.replace(/%%/g, "%"));
}

function unitValue(text, key) {
  const m = new RegExp(`^${key}=(.*)$`, "m").exec(text);
  return m === null ? undefined : m[1].trim();
}

function livePid(u) {
  const file = pidFile(u);
  if (!fs.existsSync(file)) return 0;
  const pid = Number(fs.readFileSync(file, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return 0;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    if (err.code === "EPERM") return pid;
    fs.rmSync(file, { force: true });
    return 0;
  }
}

function start(u) {
  if (livePid(u) !== 0) return; // already up: `start` on a running unit is a no-op
  const file = unitFile(u);
  if (!fs.existsSync(file)) die(`Unit ${u} not found.`, 5);
  const text = fs.readFileSync(file, "utf8");
  const exec = unitValue(text, "ExecStart");
  if (exec === undefined) die(`Unit ${u} has no ExecStart.`, 5);
  const words = execWords(exec);
  const logPath = (unitValue(text, "StandardOutput") ?? "").replace(/^append:/, "");
  const cwd = unitValue(text, "WorkingDirectory");

  // `Environment="PATH=…"` — the only Environment= line Paddock writes. Taken from the unit
  // rather than inherited, because the whole point of that line is that a service does not get
  // the installing shell's PATH.
  const env = { ...process.env };
  for (const m of text.matchAll(/^Environment="?([^=]+)=([^"]*)"?$/gm)) env[m[1]] = m[2];

  if (logPath !== "") fs.mkdirSync(path.dirname(logPath), { recursive: true });
  if (cwd !== undefined) fs.mkdirSync(cwd, { recursive: true });
  const out = logPath !== "" ? fs.openSync(logPath, "a") : "ignore";
  const child = spawn(words[0], words.slice(1), {
    detached: true,
    stdio: ["ignore", out, out],
    ...(cwd !== undefined ? { cwd } : {}),
    env,
  });
  child.unref();
  fs.writeFileSync(pidFile(u), String(child.pid));
}

function stop(u) {
  const pid = livePid(u);
  if (pid === 0) {
    fs.rmSync(pidFile(u), { force: true });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  // Wait for it, the way a real stop does: `update` installs over these files straight afterwards,
  // and npm moving the old package aside under a still-running server is the exact failure SPEC §5
  // step 9 orders the sequence to avoid.
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (livePid(u) === 0) break;
    // A busy wait, because this process has nothing else to do and a sleep needs an event loop
    // turn: `Atomics.wait` on a throwaway buffer is the one synchronous sleep Node has.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  fs.rmSync(pidFile(u), { force: true });
}

switch (verb) {
  case "daemon-reload":
    process.exit(0);
  case "enable":
    fs.writeFileSync(enabledFile(unit), "enabled");
    if (now) start(unit);
    process.exit(0);
  case "disable":
    if (now) stop(unit);
    fs.rmSync(enabledFile(unit), { force: true });
    process.exit(0);
  case "is-enabled":
    log(fs.existsSync(enabledFile(unit)) ? "enabled" : "disabled");
    process.exit(fs.existsSync(enabledFile(unit)) ? 0 : 1);
  case "start":
    start(unit);
    process.exit(0);
  case "stop":
    stop(unit);
    process.exit(0);
  case "restart":
    stop(unit);
    start(unit);
    process.exit(0);
  case "is-active": {
    const active = livePid(unit) !== 0;
    log(active ? "active" : "inactive");
    process.exit(active ? 0 : 3);
  }
  case "show": {
    // Only `-p MainPID --value` is asked for, which is all `status` reads.
    log(String(livePid(unit)));
    process.exit(0);
  }
  default:
    process.exit(0);
}

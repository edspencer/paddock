/**
 * The Linux backend: a `systemd --user` unit (#796).
 *
 * ## Not the server story
 *
 * Paddock already documents itself under systemd — `guides/proxmox-lxc.md`
 * Path B, provisioned by the `paddock-deploy` Ansible recipes. That is a
 * SYSTEM unit, running as a service user, behind a reverse proxy, with a token
 * in its environment. This is the other one: a user unit, running as you, on
 * loopback, using the Claude login you already have. They should not be
 * confused, and this module writes nothing outside `~/.config/systemd/user`.
 *
 * ## Lingering
 *
 * A `--user` manager is started at your first login and stopped at your last
 * logout, so by default the unit dies when you log out — including when you log
 * out of an SSH session, which is how most people meet this. `loginctl
 * enable-linger <user>` keeps the manager (and therefore Paddock) alive.
 *
 * That is called out in the install output rather than being run for the user:
 * lingering is a real change to how the machine behaves after they leave it,
 * and it needs a privilege this command otherwise never asks for.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SYSTEMD_UNIT, type ServiceSpec } from "./spec.js";
import type { LingerState, RunResult, Runner, ServiceBackend, ServiceState } from "./backend.js";

/**
 * `~/.config/systemd/user/paddock.service`, honouring `XDG_CONFIG_HOME`.
 *
 * ## An injected home outranks the ambient variable
 *
 * The precedence is: an explicit `xdgConfigHome` argument, then an explicitly
 * **injected** `homeDir`, then — only when the caller named neither — the real
 * environment. That middle rung is the whole point, and getting it wrong was a
 * live bug rather than a style question.
 *
 * The first version read `process.env.XDG_CONFIG_HOME` before falling back to
 * `homeDir`. On any machine with that variable set — CI, and plenty of Linux
 * desktops — the `homeDir` parameter was therefore **a lie**: a caller passing a
 * throwaway directory still resolved to the real config home. Two things
 * followed. Test isolation quietly stopped working, so which assertion passed
 * depended on test ORDER rather than test content. And the suite wrote a real
 * `paddock.service` into the runner's actual config directory, outside every
 * temp dir it thought it was confined to — which on a contributor's machine
 * would have installed a unit they never asked for.
 *
 * So: passing a home is a statement about where home is, and it wins. The
 * ambient read survives only on the branch where nobody said otherwise, which
 * is the real-use branch and the one where honouring `XDG_CONFIG_HOME` is
 * correct. (`paddock.ts` threads the variable in explicitly as well, so the
 * production path does not depend on this fallback — it is here so that a
 * caller with no opinion still gets the right answer.)
 */
export function unitPath(homeDir?: string, xdgConfigHome?: string): string {
  const base =
    xdgConfigHome ??
    (homeDir !== undefined
      ? path.join(homeDir, ".config")
      : (process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")));
  return path.join(base, "systemd", "user", SYSTEMD_UNIT);
}

/**
 * Unit-file escaping, ported from Local Review's `server/service/systemd.ts`
 * (`pct`, `cEscape`, `cUnescape`, `execWord`, `execWords`) @ cli-contract spec
 * 0.1; local changes: doc comments only. Wave C4 moves these to
 * `reference/service/` and re-syncs.
 *
 * `%` starts a specifier EVERYWHERE in a unit file, so it is doubled; `$`
 * starts a variable in `ExecStart`, so it is doubled there too.
 */
const pct = (s: string): string => s.replace(/%/g, "%%");
const cEscape = (s: string): string =>
  s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t");
const cUnescape = (s: string): string =>
  s.replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));

/** One `ExecStart` word: specifiers and variables escaped, quoted when it has to be. */
export function execWord(a: string): string {
  const s = pct(a).replace(/\$/g, "$$$$");
  return s === "" || /[\s"'\\;]/.test(s) ? `"${cEscape(s)}"` : s;
}

/**
 * The other way: the words of an `ExecStart` line.
 *
 * Reads both shapes on purpose. A unit written before #796's quoting is a bare
 * whitespace-separated line, and its owner is exactly the person whose `status`
 * has to keep working — so unquoted words pass through unchanged, and quoted
 * ones are unescaped.
 */
export function execWords(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
    const w = m[1] !== undefined ? cUnescape(m[1]) : m[2];
    out.push(w.replace(/\$\$/g, "$").replace(/%%/g, "%"));
  }
  return out;
}

/**
 * Render the unit.
 *
 * `Restart=always`, matching launchd's `KeepAlive=<true/>` (#872). It was
 * `on-failure`, which for a service is the wrong default for the same reason it
 * was wrong there: `start.ts` exits `0` on SIGTERM, so a logout — or anything
 * else that signals the user manager — was read as an intended stop and Paddock
 * stayed down.
 *
 * `always` does not make the unit unstoppable. systemd never restarts a unit it
 * was itself asked to stop, so `systemctl --user stop` (and therefore
 * `uninstall`) remains the clean, explicit way to put it down. That is the
 * difference between an exit code, which has to guess at intent, and a command,
 * which carries it.
 *
 * `WantedBy=default.target` is what makes `systemctl --user enable` mean
 * "start at login" for a user unit; `multi-user.target` is the system-unit
 * spelling and does nothing here.
 *
 * ## Logs go to a file, not the journal (SPEC §7)
 *
 * `StandardOutput=append:` / `StandardError=append:` name one file, the same
 * one launchd's two keys name. The journal was the obvious choice and the wrong
 * one for three reasons: `journalctl --user` shows nothing at all on a distro
 * whose journal is volatile (the output is gone after a reboot, which is
 * exactly when someone looks); it makes "where are the logs" have a different
 * answer on each platform, so `paddock service logs` would be two
 * implementations; and it rules out Windows, which the contract requires
 * nothing rule out.
 *
 * The directory has to exist first — systemd creates the file, not its parent —
 * which `install` below does.
 *
 * ## Every ExecStart word is quoted
 *
 * `%` starts a specifier anywhere in a unit file and `$` starts a variable in
 * `ExecStart`, so both are escaped; a word containing whitespace, a quote or a
 * backslash is quoted. Paths with a space in them are the common case
 * (`/Users/Ed Spencer/.paddock`), and the old unqualified `join(" ")` wrote a
 * unit systemd then split into the wrong arguments — a service that fails at
 * login having printed nothing.
 */
export function renderUnit(spec: ServiceSpec): string {
  const exec = [spec.nodePath, spec.scriptPath, ...spec.args].map(execWord).join(" ");
  return `# Generated by Paddock — \`paddock service install\` rewrites this file.
# Node: ${spec.nodePath}
[Unit]
Description=Paddock — persistent, resumable Claude Code sessions, by project
Documentation=https://paddock.edspencer.net

[Service]
Type=simple
ExecStart=${exec}
WorkingDirectory=${pct(spec.workingDirectory)}
Environment="PATH=${cEscape(pct(spec.pathEnv))}"
StandardOutput=append:${pct(spec.logPath)}
StandardError=append:${pct(spec.logPath)}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
}

/** The log file an installed unit appends to, or undefined if it names none. */
export function parseUnitLogPath(text: string): string | undefined {
  const m = /^StandardOutput=append:(.*)$/m.exec(text);
  return m === null ? undefined : m[1].trim().replace(/%%/g, "%");
}

/**
 * Does an installed unit carry `Restart=always` (#872)?
 *
 * The counterpart to `plistKeepsAlive`, and narrow for the same reason: the
 * value it has to reject is the `on-failure` this file used to write, which
 * leaves Paddock down after the graceful exit `start.ts` performs on SIGTERM.
 * Anything unrecognised reads as "not the fixed shape", which at worst tells a
 * hand-edited unit's owner to re-run install.
 */
export function unitKeepsAlive(text: string): boolean {
  return /^Restart=always\s*$/m.test(text);
}

/** Read `ExecStart=` back out of an installed unit, split into an argv. */
export function parseUnitArgv(text: string): string[] {
  const m = /^ExecStart=(.*)$/m.exec(text);
  if (m === null) return [];
  return execWords(m[1].trim());
}

/**
 * What a `systemctl` failure means, in the manager's own words where it has any.
 *
 * The `status === null` branch is the one QA found: `spawnSync` reports a
 * missing binary that way, with no output at all, so the message was
 * `systemctl --user enable --now failed (exit null).` and then a blank line —
 * which tells someone on a container with no systemd nothing whatsoever. That
 * is also the single likeliest way this command fails on a machine it was never
 * going to work on.
 */
export function systemctlFailure(args: string[], r: RunResult): string {
  if (r.status === null || r.status === 127) {
    return (
      "systemctl is not available, so Paddock cannot install a service here.\n" +
      "It needs systemd's per-user instance (`systemctl --user`) — a container " +
      "or a non-systemd distribution has none.\n" +
      "Run `paddock serve` in a terminal, or keep it up with whatever this " +
      "machine uses."
    );
  }
  if (/Failed to connect to (user scope )?bus|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR/.test(r.stderr)) {
    return (
      `cannot reach systemd's per-user instance (${r.stderr.trim()}).\n` +
      "Run this from a login session, and check that $XDG_RUNTIME_DIR is set " +
      "(usually /run/user/$(id -u))."
    );
  }
  return (
    `systemctl ${args.join(" ")} failed (exit ${String(r.status)}).\n` +
    `${r.stderr || r.stdout}`.trim()
  );
}

/** Run a `systemctl` and turn a non-zero exit into something actionable. */
function systemctlOrThrow(run: Runner, args: string[]): void {
  const r = run("systemctl", args);
  if (r.status === 0) return;
  throw new Error(systemctlFailure(args, r));
}

export function createSystemdBackend(
  run: Runner,
  homeDir?: string,
  xdgConfigHome?: string,
): ServiceBackend {
  // Both forwarded, neither defaulted here: `unitPath` owns the precedence, and
  // defaulting `homeDir` to `os.homedir()` at this layer would collapse "the
  // caller named a home" into "the caller named nothing" — the exact
  // distinction that precedence turns on.
  const file = unitPath(homeDir, xdgConfigHome);
  return {
    platform: "linux",
    unitPath: file,
    label: SYSTEMD_UNIT,

    install(spec: ServiceSpec): void {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.mkdirSync(spec.workingDirectory, { recursive: true });
      // systemd creates the log FILE for `append:` but not its directory, and a
      // missing directory fails the unit at start with the server never having
      // run — no output anywhere, because the thing that would have written it
      // is what failed.
      fs.mkdirSync(path.dirname(spec.logPath), { recursive: true });
      fs.writeFileSync(file, renderUnit(spec), "utf8");

      // Without this the manager keeps serving the previous unit from cache and
      // an "upgrade" silently changes nothing.
      run("systemctl", ["--user", "daemon-reload"]);

      const args = ["--user", "enable", "--now", SYSTEMD_UNIT];
      const enabled = run("systemctl", args);
      if (enabled.status !== 0) throw new Error(systemctlFailure(args, enabled));
    },

    uninstall(): boolean {
      const existed = fs.existsSync(file);
      run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
      if (existed) fs.rmSync(file, { force: true });
      run("systemctl", ["--user", "daemon-reload"]);
      return existed;
    },

    /**
     * The lifecycle three (#873), which on systemd are just the verbs.
     *
     * None of them touches `enable`/`disable`: those decide whether Paddock
     * comes back at your NEXT login, which is a different question from whether
     * it is running now, and quietly answering both would make `stop` a
     * surprise the following morning. `uninstall` is where that link is cut.
     *
     * `restart` re-reads the unit itself, but a `daemon-reload` first is what
     * makes an EDITED unit take effect rather than the manager's cached copy —
     * the same reason `install` reloads before enabling.
     */
    start(): void {
      systemctlOrThrow(run, ["--user", "start", SYSTEMD_UNIT]);
    },

    stop(): void {
      systemctlOrThrow(run, ["--user", "stop", SYSTEMD_UNIT]);
    },

    restart(): void {
      run("systemctl", ["--user", "daemon-reload"]);
      systemctlOrThrow(run, ["--user", "restart", SYSTEMD_UNIT]);
    },

    status(): ServiceState {
      if (!fs.existsSync(file))
        return { registered: false, running: false, argv: [], keepsAlive: true };
      const text = fs.readFileSync(file, "utf8");
      const argv = parseUnitArgv(text);
      const active = run("systemctl", ["--user", "is-active", SYSTEMD_UNIT]);
      const pid = run("systemctl", ["--user", "show", "-p", "MainPID", "--value", SYSTEMD_UNIT]);
      const mainPid = pid.stdout.trim();
      const logPath = parseUnitLogPath(text);
      return {
        registered: true,
        running: active.stdout.trim() === "active",
        ...(mainPid !== "" && mainPid !== "0" ? { pid: mainPid } : {}),
        argv: argv.slice(2),
        ...(argv[0] !== undefined ? { nodePath: argv[0] } : {}),
        ...(argv[1] !== undefined ? { cliPath: argv[1] } : {}),
        ...(logPath !== undefined ? { logPath } : {}),
        keepsAlive: unitKeepsAlive(text),
      };
    },

    /**
     * `loginctl show-user <user> -p Linger` (SPEC §7).
     *
     * Parsed rather than trusted to exit codes: `loginctl` is absent in plenty
     * of containers and exits non-zero for a user logind has no record of, and
     * neither of those is "linger is off". An unparseable answer is reported as
     * unknown, which prints nothing — the alternative is handing a `sudo`
     * command to someone whose machine has no `loginctl` to run it with.
     */
    linger(): LingerState {
      const user = os.userInfo().username;
      const r = run("loginctl", ["show-user", user, "-p", "Linger"]);
      const m = /Linger=(yes|no)/i.exec(`${r.stdout}${r.stderr}`);
      return {
        applies: true,
        user,
        ...(m !== null ? { enabled: m[1].toLowerCase() === "yes" } : {}),
      };
    },
  };
}

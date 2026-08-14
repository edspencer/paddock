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
import type { Runner, ServiceBackend, ServiceState } from "./backend.js";

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
 * No `StandardOutput=` — a user unit's output goes to the journal, which is
 * where a Linux user will look, and duplicating it into a file would give two
 * answers to "where are the logs".
 */
export function renderUnit(spec: ServiceSpec): string {
  const exec = [spec.nodePath, spec.scriptPath, ...spec.args].join(" ");
  return `[Unit]
Description=Paddock — persistent, resumable Claude Code sessions, by project
Documentation=https://paddock.edspencer.net

[Service]
Type=simple
ExecStart=${exec}
WorkingDirectory=${spec.workingDirectory}
Environment=PATH=${spec.pathEnv}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
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
  return m[1].trim().split(/\s+/).filter(Boolean);
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
      fs.writeFileSync(file, renderUnit(spec), "utf8");

      // Without this the manager keeps serving the previous unit from cache and
      // an "upgrade" silently changes nothing.
      run("systemctl", ["--user", "daemon-reload"]);

      const enabled = run("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
      if (enabled.status !== 0) {
        throw new Error(
          `systemctl --user enable --now failed (exit ${String(enabled.status)}).\n` +
            `${enabled.stderr || enabled.stdout}`.trim(),
        );
      }
    },

    uninstall(): boolean {
      const existed = fs.existsSync(file);
      run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
      if (existed) fs.rmSync(file, { force: true });
      run("systemctl", ["--user", "daemon-reload"]);
      return existed;
    },

    status(): ServiceState {
      if (!fs.existsSync(file))
        return { registered: false, running: false, argv: [], keepsAlive: true };
      const text = fs.readFileSync(file, "utf8");
      const argv = parseUnitArgv(text);
      const active = run("systemctl", ["--user", "is-active", SYSTEMD_UNIT]);
      const pid = run("systemctl", ["--user", "show", "-p", "MainPID", "--value", SYSTEMD_UNIT]);
      const mainPid = pid.stdout.trim();
      return {
        registered: true,
        running: active.stdout.trim() === "active",
        ...(mainPid !== "" && mainPid !== "0" ? { pid: mainPid } : {}),
        argv: argv.slice(2),
        keepsAlive: unitKeepsAlive(text),
      };
    },

    logsHint(): string {
      return `  Logs: journalctl --user -u ${SYSTEMD_UNIT} -f`;
    },

    lingerNote(): string {
      const user = os.userInfo().username;
      return (
        "  A user service stops when you log out. To keep Paddock up:\n" +
        `    loginctl enable-linger ${user}`
      );
    },
  };
}

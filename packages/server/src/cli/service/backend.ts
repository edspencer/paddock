/**
 * The seam between "what a Paddock service is" and "how this init system spells
 * it" (#796).
 *
 * Two backends implement this: `launchd.ts` and `systemd.ts`. They differ in
 * more than syntax — launchd wants log file paths and systemd sends everything
 * to journald; systemd needs `loginctl enable-linger` and launchd has no
 * equivalent — so the interface carries those asymmetries explicitly rather
 * than pretending the two are the same shape with different quotes.
 */
import { spawnSync } from "node:child_process";
import type { ServiceSpec } from "./spec.js";

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run an external command.
 *
 * Injected rather than imported so the install/uninstall/status flows can be
 * driven in tests on a box that has neither `launchctl` nor a user systemd.
 */
export type Runner = (cmd: string, args: string[]) => RunResult;

export const spawnRunner: Runner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

export interface ServiceState {
  /** Is a unit file installed for us? */
  registered: boolean;
  /** Does the init system say the process is up right now? */
  running: boolean;
  pid?: string;
  /** The Paddock arguments recorded in the installed unit, interpreter stripped. */
  argv: string[];
  /**
   * Does the unit ON DISK come back after a graceful stop (#872)?
   *
   * Read from the installed file rather than from what we would write today,
   * because those differ for exactly the people who need to hear about it.
   * Upgrading the package does not rewrite a unit, so anyone who installed
   * before #872 still has `SuccessfulExit: false` / `Restart=on-failure` — the
   * shape where one sleep or logout stops Paddock for good. They cannot see
   * that from the outside: the service simply is not running one morning.
   * `status` is where they look, so `status` is where it has to say so.
   *
   * Meaningless when `registered` is false, and `true` there — "nothing to warn
   * about" — so no caller has to special-case a unit that does not exist.
   */
  keepsAlive: boolean;
}

export interface ServiceBackend {
  platform: "darwin" | "linux";
  /** Where the plist / unit file goes. */
  unitPath: string;
  /** launchd label or systemd unit name — the string a user would type. */
  label: string;
  install(spec: ServiceSpec): void;
  /** True if something was actually there to remove. */
  uninstall(): boolean;
  status(): ServiceState;
  /**
   * Start / stop / restart an already-installed unit (#873).
   *
   * These exist so an intended stop has a channel of its OWN. Before them the
   * only stop was `uninstall`, which also deregisters, so "bounce it after
   * editing config" meant either losing the unit or dropping to raw
   * `launchctl kickstart -k gui/$(id -u)/net.edspencer.paddock` — undiscoverable,
   * and different on each platform. The exit-code heuristic that #872 removed
   * was carrying the same meaning by inference; a command carries it directly.
   *
   * Each throws with the supervisor's own stderr rather than returning a
   * boolean: the interesting failures here (a unit that was booted out, a
   * manager that is not running) have text worth showing, and swallowing it
   * would leave `start` printing a URL for a server that never came up.
   */
  start(): void;
  stop(): void;
  restart(): void;
  /** How to read the logs, as printed lines. */
  logsHint(spec: ServiceSpec): string;
  /** The `enable-linger` warning, or undefined where it does not apply. */
  lingerNote(): string | undefined;
}

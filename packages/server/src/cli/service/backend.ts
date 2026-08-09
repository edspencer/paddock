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
  /** How to read the logs, as printed lines. */
  logsHint(spec: ServiceSpec): string;
  /** The `enable-linger` warning, or undefined where it does not apply. */
  lingerNote(): string | undefined;
}

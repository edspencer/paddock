/**
 * The darwin backend: a launchd **LaunchAgent** (#796).
 *
 * ## Why an agent and not a daemon
 *
 * A LaunchAgent is bootstrapped into the `gui/<uid>` domain when that user logs
 * in, and runs as them. A LaunchDaemon starts at boot, as root, before anyone
 * has logged in. The difference is not convenience — it decides whether Paddock
 * can use your Claude login at all.
 *
 * On macOS that login is a Keychain item, and the login keychain is unlocked by
 * your account password *at login*. A daemon has no such session, so the item
 * is locked and unreadable; `UserName` in the plist does not help, because it
 * changes the effective uid and not the keychain's unlock state. `claude.
 * credentials: host` on darwin therefore structurally requires a logged-in user
 * session, and boot-time start and Keychain credentials are mutually exclusive.
 *
 * The consequence users will meet is that Paddock starts **at login, not at
 * boot** — after a restart nobody logs into, it is not running. Every surface
 * that mentions this service says so, because otherwise it gets filed as a bug.
 *
 * A boot-time instance is a genuinely different feature: a LaunchDaemon plus
 * `claude.credentials: own` and a token sitting in `EnvironmentVariables` —
 * which is exactly the long-lived-credential-in-a-plist problem the agent shape
 * avoids. Stated in the docs as the trade, not offered as a flag.
 *
 * ## What has actually been verified
 *
 * A turn completed under `launchctl kickstart` on a Mac whose Claude login
 * existed only as the Keychain item, with `ps eww` confirming no credential in
 * the process environment, and with no permission dialog. Start **at login**
 * (`RunAtLoad` after a real logout/login) has NOT been tested; if a login-time
 * agent can race keychain unlock, the fix belongs in this file's plist rather
 * than in the design. Nothing here should be read as covering that case.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LAUNCHD_LABEL, type ServiceSpec } from "./spec.js";
import type { Runner, ServiceBackend, ServiceState } from "./backend.js";

/** `~/Library/LaunchAgents/net.edspencer.paddock.plist`. */
export function plistPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render the plist.
 *
 * `KeepAlive` is unconditional `<true/>`, and that is a deliberate reversal
 * (#872). It used to be `{ SuccessfulExit: false }` — "restart it if it exits
 * nonzero, leave it alone if it exits cleanly" — which reads like the polite
 * choice and is, for a service, a trap. `start.ts` handles SIGTERM by shutting
 * down cleanly and exiting `0`, so **every** SIGTERM the OS routinely sends a
 * LaunchAgent (sleep, logout, a stray `kill`) looked to launchd like "it meant
 * to stop", and Paddock stayed down until the next login. A hard crash was the
 * survivable case; the graceful stop was the terminal one.
 *
 * The worry that motivated the dict — that `<true/>` fights a deliberate stop —
 * does not hold for the stop this CLI actually performs. `launchctl bootout`
 * unloads the job from the domain, and KeepAlive only applies to a job that is
 * still loaded, so `uninstall` still stops Paddock in one call. What `<true/>`
 * does fight is `launchctl stop`, which is why nothing here uses it.
 *
 * Intent belongs in an explicit command, not in an exit code.
 *
 * `EnvironmentVariables` carries PATH and nothing else. It carries PATH because
 * launchd hands a process a stub PATH that a version manager's `node`, and the
 * `git` an agent will want, are both missing from. It carries nothing else
 * because a plist is a world-readable file in the user's home, and the one
 * category of value that would be tempting to put here — a credential — is
 * precisely what the agent shape exists to avoid needing.
 *
 * No `PADDOCK_DATA_DIR`: see `buildSpec`. One `~/.paddock` instance, reachable
 * from the service and from a terminal.
 */
export function renderPlist(spec: ServiceSpec): string {
  const argv = [spec.nodePath, spec.scriptPath, ...spec.args];
  const strings = argv.map((a) => `      <string>${xmlEscape(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(LAUNCHD_LABEL)}</string>
    <key>ProgramArguments</key>
    <array>
${strings}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(spec.workingDirectory)}</string>
    <key>StandardOutPath</key>
    <string>${xmlEscape(spec.stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(spec.stderrPath)}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${xmlEscape(spec.pathEnv)}</string>
    </dict>
  </dict>
</plist>
`;
}

/**
 * Pull `ProgramArguments` back out of a plist we wrote.
 *
 * `status` reports the port the service is ACTUALLY installed with, which is
 * only knowable from the installed unit — recomputing it from today's flags
 * would print a confident URL for a server listening somewhere else. Regex
 * rather than a plist parser because the input is a file this module wrote, in
 * a shape this module controls, and adding an XML dependency to read it back
 * would be the larger risk.
 */
export function parsePlistArgv(xml: string): string[] {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml);
  if (block === null) return [];
  return [...block[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) =>
    m[1]
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/&amp;/g, "&"),
  );
}

/**
 * Does an installed plist carry the unconditional `KeepAlive` from #872?
 *
 * Deliberately narrow: it matches `<key>KeepAlive</key>` followed by `<true/>`
 * and nothing else. The shape it must NOT accept is the old
 * `<dict><key>SuccessfulExit</key><false/></dict>`, which is the one that
 * leaves a service dead after a graceful stop — so a `false` here is the signal
 * `status` turns into "re-run install", and defaulting to `true` on anything
 * unrecognised would silence exactly the case this exists to catch.
 */
export function plistKeepsAlive(xml: string): boolean {
  return /<key>KeepAlive<\/key>\s*<true\s*\/>/.test(xml);
}

/**
 * Read liveness out of `launchctl print gui/<uid>/<label>`.
 *
 * That command is the honest answer to "is it running": it reports the service
 * as launchd currently understands it, including `state = running` and the pid.
 * The alternative — checking whether the plist file exists — answers "is it
 * registered", which is a different and much weaker question.
 */
export function parseLaunchctlPrint(out: string): { running: boolean; pid?: string } {
  const state = /^\s*state\s*=\s*(\S+)/m.exec(out);
  const pid = /^\s*pid\s*=\s*(\d+)/m.exec(out);
  return {
    running: state !== null && state[1] === "running",
    ...(pid !== null ? { pid: pid[1] } : {}),
  };
}

function target(): string {
  return `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`;
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

export function createLaunchdBackend(run: Runner, homeDir: string = os.homedir()): ServiceBackend {
  const file = plistPath(homeDir);
  return {
    platform: "darwin",
    unitPath: file,
    label: LAUNCHD_LABEL,

    install(spec: ServiceSpec): void {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.mkdirSync(spec.workingDirectory, { recursive: true });
      fs.writeFileSync(file, renderPlist(spec), "utf8");

      // `bootstrap` fails outright if the label is already loaded, so a
      // reinstall has to unload first. A first install has nothing to unload,
      // and says so on stderr — ignored rather than reported, because "there
      // was no previous service" is the expected case, not a problem.
      run("launchctl", ["bootout", target()]);

      // NOT `load`/`unload`: those are the legacy API, and on a modern macOS
      // they are shims over this one that report success in cases where it
      // reports the actual error.
      const boot = run("launchctl", ["bootstrap", domain(), file]);
      if (boot.status !== 0) {
        throw new Error(
          `launchctl bootstrap failed (exit ${String(boot.status)}).\n` +
            `${boot.stderr || boot.stdout}`.trim(),
        );
      }
      // `RunAtLoad` should already have started it; `kickstart -k` makes that
      // true rather than probable, and is the same command a later restart uses.
      run("launchctl", ["kickstart", "-k", target()]);
    },

    uninstall(): boolean {
      const existed = fs.existsSync(file);
      run("launchctl", ["bootout", target()]);
      if (existed) fs.rmSync(file, { force: true });
      return existed;
    },

    status(): ServiceState {
      if (!fs.existsSync(file))
        return { registered: false, running: false, argv: [], keepsAlive: true };
      const xml = fs.readFileSync(file, "utf8");
      const argv = parsePlistArgv(xml);
      const printed = run("launchctl", ["print", target()]);
      const parsed =
        printed.status === 0
          ? parseLaunchctlPrint(printed.stdout)
          : { running: false, pid: undefined };
      return {
        registered: true,
        running: parsed.running,
        ...(parsed.pid !== undefined ? { pid: parsed.pid } : {}),
        // Strip the interpreter and script: what a reader wants from `status`
        // is the Paddock invocation, not the absolute path to node twice.
        argv: argv.slice(2),
        keepsAlive: plistKeepsAlive(xml),
      };
    },

    logsHint(spec: ServiceSpec): string {
      return `  Logs: ${spec.stdoutPath}\n        ${spec.stderrPath}`;
    },

    lingerNote(): string | undefined {
      return undefined;
    },
  };
}

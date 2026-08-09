/**
 * Unit tests for `paddock service` (#796).
 *
 * ## What these can and cannot prove
 *
 * This project's CI is Linux, and so is the box this was written on. The
 * darwin backend's *output* is therefore fully covered — a golden plist,
 * asserted key by key — and its *execution* is not: nothing here runs
 * `launchctl`, so nothing here proves launchd accepts what we generate, that
 * `bootstrap` succeeds, or that a login-time `RunAtLoad` start beats the
 * keychain unlock. The one launchd fact that has been checked on real hardware
 * (a turn completing under `launchctl kickstart`, Keychain login, no credential
 * in the environment) was checked by hand on a Mac and is recorded in #796, not
 * here.
 *
 * The systemd side is in the same position for the same reason: a user systemd
 * manager is not available in CI either. Both backends' subprocess calls are
 * driven through an injected {@link Runner} so the install/uninstall/status
 * FLOW is exercised — which commands, in which order, with which arguments —
 * without either init system being present. That catches the class of mistake
 * that actually bites (calling deprecated `load`/`unload`, forgetting
 * `daemon-reload`, bootstrapping without first booting out) and cannot catch a
 * plist key launchd rejects.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseCommand,
  parseArgs,
  CliError,
  SERVICE_ACTIONS,
  SERVICE_USAGE,
  type Command,
} from "../../src/cli/args.js";
import {
  buildSpec,
  isNpxPath,
  portFromArgv,
  hostFromArgv,
  serviceDir,
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
} from "../../src/cli/service/spec.js";
import {
  renderPlist,
  plistPath,
  parsePlistArgv,
  parseLaunchctlPrint,
  createLaunchdBackend,
} from "../../src/cli/service/launchd.js";
import {
  renderUnit,
  unitPath,
  parseUnitArgv,
  createSystemdBackend,
} from "../../src/cli/service/systemd.js";
import type { RunResult, Runner } from "../../src/cli/service/backend.js";
import { runService } from "../../src/cli/service/index.js";

// ---------------------------------------------------------------------------
// Verb dispatch
// ---------------------------------------------------------------------------

describe("paddock CLI: verb dispatch (#796)", () => {
  /**
   * The compatibility property the whole design hangs off. `parseCommand` must
   * be a superset of `parseArgs`: anything that used to work has to keep
   * producing the same options, because bare `paddock` is the demo path.
   */
  it.each([
    [[]],
    [["--port", "4100"]],
    [["-p", "4100", "-d", "/tmp/pad", "-o", "--verbose"]],
    [["--help"]],
    [["--version"]],
  ])("bare argv %j parses exactly as it did before", (argv) => {
    const command = parseCommand(argv);
    expect(command.verb).toBe("start");
    expect(command.opts).toEqual(parseArgs(argv));
  });

  it("`start` is an exact synonym for no verb", () => {
    expect(parseCommand(["start"])).toEqual(parseCommand([]));
    expect(parseCommand(["start", "--port", "7299"]).opts.port).toBe("7299");
  });

  it("parses flags AFTER a verb", () => {
    const command = parseCommand(["service", "install", "--port", "7299", "--verbose"]);
    expect(command.verb).toBe("service");
    expect((command as Extract<Command, { verb: "service" }>).action).toBe("install");
    expect(command.opts.port).toBe("7299");
    expect(command.opts.verbose).toBe(true);
  });

  it.each(SERVICE_ACTIONS)("accepts `service %s`", (action) => {
    const command = parseCommand(["service", action]) as Extract<Command, { verb: "service" }>;
    expect(command.action).toBe(action);
  });

  it("names the valid actions when one is misspelled", () => {
    // Specifically NOT "unknown option: instal" — that sends the reader looking
    // for a flag they never typed.
    expect(() => parseCommand(["service", "instal"])).toThrow(/unknown service action: instal/);
    expect(() => parseCommand(["service", "instal"])).toThrow(/install, uninstall, status/);
  });

  it("requires an action, unless the ask was for help", () => {
    expect(() => parseCommand(["service"])).toThrow(CliError);
    expect(() => parseCommand(["service"])).toThrow(/needs an action/);
    const helped = parseCommand(["service", "--help"]) as Extract<Command, { verb: "service" }>;
    expect(helped.opts.help).toBe(true);
    expect(helped.action).toBeUndefined();
  });

  it("only treats a verb as a verb in first position", () => {
    // Otherwise `--host service` would silently become a subcommand.
    expect(() => parseCommand(["--port", "start"])).not.toThrow();
    expect(parseCommand(["--host", "service"]).opts.host).toBe("service");
    expect(() => parseCommand(["start", "start"])).toThrow(/unknown option: start/);
  });

  it("still rejects an unrecognised leading token as an unknown option", () => {
    // The pre-#796 behaviour, unchanged: dropping it would let `paddock 4100`
    // look like it worked while starting on the default port.
    expect(() => parseCommand(["4100"])).toThrow(/unknown option: 4100/);
    expect(() => parseCommand(["scan"])).toThrow(/unknown option: scan/);
  });

  it("SERVICE_USAGE says at login, not at boot, and names enable-linger", () => {
    expect(SERVICE_USAGE).toMatch(/LOG IN, not when the machine boots/);
    expect(SERVICE_USAGE).toContain("loginctl enable-linger");
    expect(SERVICE_USAGE).toContain("npm i -g @edspencer/paddock");
  });
});

// ---------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------

const BASE = {
  nodePath: "/opt/node/bin/node",
  scriptPath: "/usr/local/lib/node_modules/@edspencer/paddock/packages/server/dist/cli/paddock.js",
  dataDir: "/home/ed/.paddock",
  pathEnv: "/opt/node/bin:/usr/bin:/bin",
};

describe("paddock service: the spec", () => {
  it("leads the argument vector with the `start` verb", () => {
    // So `launchctl print` shows an argv you can read rather than recognise.
    expect(buildSpec(BASE).args).toEqual(["start"]);
  });

  /**
   * The load-bearing default. With no data dir named anywhere, the service and
   * a `paddock` typed into a terminal both fall through to `~/.paddock` and are
   * the same instance — which is the whole point of "one home instance, two
   * ways to reach it".
   */
  it("names no data dir by default", () => {
    const spec = buildSpec(BASE);
    expect(spec.args).not.toContain("--data-dir");
    expect(renderPlist(spec)).not.toContain("PADDOCK_DATA_DIR");
    expect(renderUnit(spec)).not.toContain("PADDOCK_DATA_DIR");
  });

  it("forwards a data dir only when one was asked for", () => {
    expect(buildSpec({ ...BASE, dataDirArg: "/srv/pad" }).args).toEqual([
      "start",
      "--data-dir",
      "/srv/pad",
    ]);
  });

  it("forwards port, host and verbose", () => {
    const spec = buildSpec({ ...BASE, port: "7299", host: "127.0.0.1", verbose: true });
    expect(spec.args).toEqual(["start", "--port", "7299", "--host", "127.0.0.1", "--verbose"]);
  });

  it("puts the working directory and logs inside the data dir, not $HOME", () => {
    const spec = buildSpec(BASE);
    expect(spec.workingDirectory).toBe(serviceDir("/home/ed/.paddock"));
    expect(spec.stdoutPath.startsWith(spec.workingDirectory)).toBe(true);
    // $HOME is the obvious choice and the wrong one: a background process has
    // no cwd anyone chose, and it should not sit in a directory full of the
    // user's things. (Until #798 it was worse than untidy — `.paddock` was both
    // the here-marker and the default data dir, so $HOME read as an already
    // opened workspace and the instance adopted the entire home.)
    expect(spec.workingDirectory).not.toBe("/home/ed");
  });

  it.each([
    ["/home/ed/.npm/_npx/399ccf3865bb9552/node_modules/@edspencer/paddock", true],
    ["/usr/local/lib/node_modules/@edspencer/paddock", false],
    ["/home/ed/code/_npx-experiments/paddock", false],
    ["/home/ed/code/paddock", false],
  ])("isNpxPath(%s) === %s", (p, expected) => {
    expect(isNpxPath(p)).toBe(expected);
  });

  it("reads the port and host back out of an argv", () => {
    expect(portFromArgv(["start", "--port", "7299"])).toBe("7299");
    expect(portFromArgv(["start", "-p", "7299"])).toBe("7299");
    expect(portFromArgv(["start"])).toBe("7233");
    expect(hostFromArgv(["start", "--host", "0.0.0.0"])).toBe("0.0.0.0");
    expect(hostFromArgv(["start"])).toBe("127.0.0.1");
  });
});

// ---------------------------------------------------------------------------
// launchd: the golden plist
// ---------------------------------------------------------------------------

describe("paddock service: the generated plist", () => {
  const spec = buildSpec({ ...BASE, dataDir: "/Users/ed/.paddock" });
  const plist = renderPlist(spec);

  it("matches the golden output", () => {
    expect(plist).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0">
        <dict>
          <key>Label</key>
          <string>net.edspencer.paddock</string>
          <key>ProgramArguments</key>
          <array>
            <string>/opt/node/bin/node</string>
            <string>/usr/local/lib/node_modules/@edspencer/paddock/packages/server/dist/cli/paddock.js</string>
            <string>start</string>
          </array>
          <key>RunAtLoad</key>
          <true/>
          <key>KeepAlive</key>
          <dict>
            <key>SuccessfulExit</key>
            <false/>
          </dict>
          <key>ThrottleInterval</key>
          <integer>10</integer>
          <key>WorkingDirectory</key>
          <string>/Users/ed/.paddock/service</string>
          <key>StandardOutPath</key>
          <string>/Users/ed/.paddock/service/paddock.log</string>
          <key>StandardErrorPath</key>
          <string>/Users/ed/.paddock/service/paddock.error.log</string>
          <key>EnvironmentVariables</key>
          <dict>
            <key>PATH</key>
            <string>/opt/node/bin:/usr/bin:/bin</string>
          </dict>
        </dict>
      </plist>
      "
    `);
  });

  /**
   * The one that would ship broken and look fine: the published `bin` is a
   * symlink with a `#!/usr/bin/env node` shebang, and launchd hands a process a
   * stub PATH that a version manager's node is not on. Exec'ing the bin
   * directly fails at login with a bare "no such file or directory".
   */
  it("invokes node explicitly, by absolute path, with the script after it", () => {
    const argv = parsePlistArgv(plist);
    expect(argv[0]).toBe("/opt/node/bin/node");
    expect(argv[1]).toMatch(/dist\/cli\/paddock\.js$/);
    expect(argv).not.toContain("/usr/bin/env");
  });

  it("restarts on crash but not on a clean exit", () => {
    // A bare `<key>KeepAlive</key><true/>` would fight `launchctl bootout` and
    // make stopping Paddock a wrestling match.
    expect(plist).toContain("<key>SuccessfulExit</key>\n      <false/>");
    expect(plist).not.toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });

  it("carries PATH and nothing else in the environment", () => {
    // A plist is a world-readable file in the user's home, and the value it
    // would be tempting to add here is a credential — which is exactly what the
    // LaunchAgent shape exists to avoid needing.
    const env = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(plist);
    expect(env).not.toBeNull();
    expect([...env![1].matchAll(/<key>(.*?)<\/key>/g)].map((m) => m[1])).toEqual(["PATH"]);
  });

  it("escapes XML metacharacters in paths", () => {
    const odd = renderPlist(buildSpec({ ...BASE, dataDir: "/Users/a&b/<pad>" }));
    expect(odd).toContain("/Users/a&amp;b/&lt;pad&gt;/service");
    expect(odd).not.toContain("/Users/a&b/<pad>");
    expect(parsePlistArgv(odd)).toBeTruthy();
  });

  it("round-trips its own argv", () => {
    const withFlags = renderPlist(buildSpec({ ...BASE, port: "7299", dataDirArg: "/srv/p&d" }));
    expect(parsePlistArgv(withFlags).slice(2)).toEqual([
      "start",
      "--port",
      "7299",
      "--data-dir",
      "/srv/p&d",
    ]);
  });

  it("lands in ~/Library/LaunchAgents under the reverse-DNS label", () => {
    expect(plistPath("/Users/ed")).toBe(
      `/Users/ed/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`,
    );
  });

  it.each([
    ["\tstate = running\n\tpid = 4212\n", true, "4212"],
    ["\tstate = waiting\n", false, undefined],
    ["", false, undefined],
  ])("reads launchctl print output %j", (out, running, pid) => {
    expect(parseLaunchctlPrint(out)).toEqual(pid !== undefined ? { running, pid } : { running });
  });
});

// ---------------------------------------------------------------------------
// systemd: the golden unit
// ---------------------------------------------------------------------------

describe("paddock service: the generated systemd unit", () => {
  const spec = buildSpec(BASE);
  const unit = renderUnit(spec);

  it("matches the golden output", () => {
    expect(unit).toMatchInlineSnapshot(`
      "[Unit]
      Description=Paddock — persistent, resumable Claude Code sessions, by project
      Documentation=https://paddock.edspencer.net

      [Service]
      Type=simple
      ExecStart=/opt/node/bin/node /usr/local/lib/node_modules/@edspencer/paddock/packages/server/dist/cli/paddock.js start
      WorkingDirectory=/home/ed/.paddock/service
      Environment=PATH=/opt/node/bin:/usr/bin:/bin
      Restart=on-failure
      RestartSec=10

      [Install]
      WantedBy=default.target
      "
    `);
  });

  it("wants default.target, which is what `enable` means for a user unit", () => {
    // multi-user.target is the SYSTEM-unit spelling and does nothing here.
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).not.toContain("multi-user.target");
  });

  it("restarts on failure only", () => {
    expect(unit).toContain("Restart=on-failure");
    expect(unit).not.toContain("Restart=always");
  });

  it("round-trips its ExecStart", () => {
    expect(parseUnitArgv(renderUnit(buildSpec({ ...BASE, port: "7299" }))).slice(2)).toEqual([
      "start",
      "--port",
      "7299",
    ]);
  });

  it("honours XDG_CONFIG_HOME", () => {
    expect(unitPath("/home/ed", "/home/ed/.conf")).toBe(
      `/home/ed/.conf/systemd/user/${SYSTEMD_UNIT}`,
    );
    expect(unitPath("/home/ed", "/x")).toContain("systemd/user/paddock.service");
  });
});

// ---------------------------------------------------------------------------
// The flows, against a recording runner
// ---------------------------------------------------------------------------

function recorder(result: Partial<RunResult> = {}): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    return { status: 0, stdout: "", stderr: "", ...result };
  };
  return { run, calls };
}

describe("paddock service: install / uninstall / status flows", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-service-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const spec = () => buildSpec({ ...BASE, dataDir: path.join(home, ".paddock") });

  it("launchd install boots out first, then bootstraps — never load/unload", () => {
    const { run, calls } = recorder();
    const backend = createLaunchdBackend(run, home);
    backend.install(spec());

    expect(calls.map((c) => c[1])).toEqual(["bootout", "bootstrap", "kickstart"]);
    // `load`/`unload` are the legacy API; on a modern macOS they are shims that
    // report success in cases where `bootstrap` reports the actual error.
    expect(calls.flat()).not.toContain("load");
    expect(calls.flat()).not.toContain("unload");
    expect(fs.existsSync(plistPath(home))).toBe(true);
    expect(fs.existsSync(spec().workingDirectory)).toBe(true);
  });

  it("launchd install surfaces a bootstrap failure rather than claiming success", () => {
    const { run } = recorder({ status: 5, stderr: "Bootstrap failed: 5: Input/output error" });
    expect(() => createLaunchdBackend(run, home).install(spec())).toThrow(/Input\/output error/);
  });

  it("systemd install reloads the daemon before enabling", () => {
    // Without the reload the manager serves the cached previous unit and an
    // "upgrade" silently changes nothing.
    const { run, calls } = recorder();
    createSystemdBackend(run, home).install(spec());
    expect(calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "paddock.service"],
    ]);
  });

  it("status reports the port recorded in the INSTALLED unit, not today's default", () => {
    const { run } = recorder();
    const backend = createLaunchdBackend(run, home);
    backend.install(buildSpec({ ...BASE, dataDir: path.join(home, ".paddock"), port: "7299" }));

    const printing = recorder({ stdout: "\tstate = running\n\tpid = 99\n" });
    const state = createLaunchdBackend(printing.run, home).status();
    expect(state).toEqual({
      registered: true,
      running: true,
      pid: "99",
      argv: ["start", "--port", "7299"],
    });
  });

  it("status on a machine with no unit says so without shelling out", () => {
    const { run, calls } = recorder();
    expect(createSystemdBackend(run, home).status()).toEqual({
      registered: false,
      running: false,
      argv: [],
    });
    expect(calls).toEqual([]);
  });

  it("uninstall removes the unit and reports whether there was one", () => {
    const { run } = recorder();
    const backend = createLaunchdBackend(run, home);
    backend.install(spec());
    expect(backend.uninstall()).toBe(true);
    expect(fs.existsSync(plistPath(home))).toBe(false);
    expect(backend.uninstall()).toBe(false);
  });

  it("uninstall leaves the logs behind", () => {
    // The last thing anyone wants from `uninstall` is for the record of why
    // they are uninstalling to vanish with it.
    const { run } = recorder();
    const backend = createLaunchdBackend(run, home);
    const s = spec();
    backend.install(s);
    fs.writeFileSync(s.stdoutPath, "boom\n");
    backend.uninstall();
    expect(fs.readFileSync(s.stdoutPath, "utf8")).toBe("boom\n");
  });
});

describe("paddock service: refusals", () => {
  const ctx = {
    platform: "darwin" as NodeJS.Platform,
    nodePath: BASE.nodePath,
    scriptPath: BASE.scriptPath,
    packageRoot: "/usr/local/lib/node_modules/@edspencer/paddock",
    homeDir: "/Users/ed",
    run: recorder().run,
  };
  const opts = { open: false, verbose: false, help: false, version: false };

  it("refuses to install from an npx cache path, and names the fix", () => {
    // A hash-keyed directory `npm cache clean` removes. The unit would work
    // until it silently didn't — at a login, unattended.
    const npx = { ...ctx, packageRoot: "/Users/ed/.npm/_npx/399ccf38/node_modules" };
    expect(() => runService("install", opts, npx)).toThrow(CliError);
    expect(() => runService("install", opts, npx)).toThrow(/npm i -g @edspencer\/paddock/);
  });

  it("names the platform it cannot serve", () => {
    const win = { ...ctx, platform: "win32" as NodeJS.Platform };
    expect(() => runService("status", opts, win)).toThrow(/not win32/);
  });
});

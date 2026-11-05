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
import { PADDOCK_SERVICE } from "../../src/cli/service/spec.js";
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
  serviceLogPath,
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
} from "../../src/cli/service/spec.js";
import {
  renderPlist,
  plistPath,
  parsePlistArgv,
  parseLaunchctlPrint,
  plistKeepsAlive,
  createLaunchd,
} from "../../src/cli/service/launchd.js";
import {
  renderUnit,
  unitPath,
  parseUnitArgv,
  unitKeepsAlive,
  createSystemd,
} from "../../src/cli/service/systemd.js";
import { waitForReady } from "../../src/cli/service/ready.js";
import type { RunResult, Runner } from "../../src/cli/service/manager.js";
import { runService } from "../../src/cli/service/index.js";

/**
 * Run `body` with one environment variable set, restoring it afterwards.
 *
 * Used to reproduce CI's environment on a box that does not share it — this
 * suite was green locally and red on CI for exactly one reason, that
 * `XDG_CONFIG_HOME` is set there and unset here.
 */
function withEnv(name: string, value: string, body: () => void): void {
  const before = process.env[name];
  process.env[name] = value;
  try {
    body();
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
}

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
    expect(command.verb).toBe("serve");
    expect(command.opts).toEqual(parseArgs(argv));
  });

  it("`serve` and `start` are exact synonyms for no verb", () => {
    // `serve` is the contract's name (SPEC §1); `start` is a PERMANENT alias —
    // every unit installed before the rename names it, and so do other
    // people's scripts. All three parse to the same command.
    expect(parseCommand(["serve"])).toEqual(parseCommand([]));
    expect(parseCommand(["start"])).toEqual(parseCommand([]));
    expect(parseCommand(["serve"])).toEqual(parseCommand(["start"]));
    expect(parseCommand(["start", "--port", "7299"]).opts.port).toBe("7299");
    expect(parseCommand(["serve", "--port", "7299"]).opts.port).toBe("7299");
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
    expect(parseCommand(["--host", "service"]).opts.host).toBe("service");
    expect(() => parseCommand(["start", "start"])).toThrow(/unknown option: start/);
    // `--port start` is the same grammar point, but it can no longer be shown
    // with `.not.toThrow()`: `start` still reaches the flag loop as a VALUE
    // rather than being dispatched as a verb — and is now rejected there for
    // not being a number (#823). The distinction that matters is WHICH error:
    // a value error from --port, not `unknown option`/verb dispatch.
    expect(() => parseCommand(["--port", "start"])).toThrow(/--port needs a number/);
    expect(() => parseCommand(["--port", "start"])).not.toThrow(/unknown option/);
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
  // `servicePath` keeps only directories that exist, so without these the
  // rendered PATH would depend on whether THIS machine happens to have
  // /opt/node/bin or /opt/homebrew/bin — which is how a golden unit passes on
  // the box and fails on a macOS runner for no reason worth debugging.
  pathExists: () => true,
  systemDirs: ["/usr/bin", "/bin"] as readonly string[],
};

describe("paddock service: the spec", () => {
  it("leads the argument vector with the `serve` verb", () => {
    // So `launchctl print` shows an argv you can read rather than recognise.
    // `serve` rather than `start` since the contract named it (SPEC §1, §7);
    // `start` stays an alias, so a unit written by an older Paddock still runs.
    expect(buildSpec(BASE).args).toEqual(["serve"]);
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
    expect(renderPlist(PADDOCK_SERVICE, spec)).not.toContain("PADDOCK_DATA_DIR");
    expect(renderUnit(PADDOCK_SERVICE, spec)).not.toContain("PADDOCK_DATA_DIR");
  });

  it("forwards a data dir only when one was asked for", () => {
    expect(buildSpec({ ...BASE, dataDirArg: "/srv/pad" }).args).toEqual([
      "serve",
      "--data-dir",
      "/srv/pad",
    ]);
  });

  it("forwards port, host and verbose", () => {
    const spec = buildSpec({ ...BASE, port: "7299", host: "127.0.0.1", verbose: true });
    expect(spec.args).toEqual(["serve", "--port", "7299", "--host", "127.0.0.1", "--verbose"]);
  });

  it("puts the working directory and logs inside the data dir, not $HOME", () => {
    const spec = buildSpec(BASE);
    expect(spec.workingDirectory).toBe(serviceDir("/home/ed/.paddock"));
    // ONE log file, under <dataDir>/logs — not under the service directory, so
    // it survives an uninstall and the server can rotate it from the data dir
    // alone (SPEC §7).
    expect(spec.logPath).toBe(serviceLogPath("/home/ed/.paddock"));
    expect(spec.logPath).toBe("/home/ed/.paddock/logs/service.log");
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
    expect(portFromArgv(["serve", "--port", "7299"])).toBe("7299");
    expect(portFromArgv(["serve", "-p", "7299"])).toBe("7299");
    expect(portFromArgv(["serve"])).toBe("7233");
    expect(hostFromArgv(["serve", "--host", "0.0.0.0"])).toBe("0.0.0.0");
    expect(hostFromArgv(["serve"])).toBe("127.0.0.1");
    // A unit written before the rename, which is the one still on disk for
    // everybody who installed one.
    expect(portFromArgv(["start", "--port", "7299"])).toBe("7299");
  });
});

// ---------------------------------------------------------------------------
// launchd: the golden plist
// ---------------------------------------------------------------------------

describe("paddock service: the generated plist", () => {
  const spec = buildSpec({ ...BASE, dataDir: "/Users/ed/.paddock" });
  const plist = renderPlist(PADDOCK_SERVICE, spec);

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
            <string>serve</string>
          </array>
          <key>RunAtLoad</key>
          <true/>
          <key>KeepAlive</key>
          <true/>
          <key>ThrottleInterval</key>
          <integer>10</integer>
          <key>WorkingDirectory</key>
          <string>/Users/ed/.paddock/service</string>
          <key>StandardOutPath</key>
          <string>/Users/ed/.paddock/logs/service.log</string>
          <key>StandardErrorPath</key>
          <string>/Users/ed/.paddock/logs/service.log</string>
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

  /**
   * The inversion of an earlier assertion, and worth saying why (#872).
   *
   * `SuccessfulExit: false` restarts Paddock only when it exits NON-zero — and
   * `start.ts` handles SIGTERM by exiting `0`. So the survivable case was a
   * crash, and the terminal one was the OS politely asking Paddock to stop at
   * sleep or logout. `bootout` (what `uninstall` runs) unloads the job rather
   * than stopping it, so unconditional KeepAlive does not make it unstoppable.
   */
  it("comes back after a graceful stop, not just a crash", () => {
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).not.toContain("SuccessfulExit");
    expect(plistKeepsAlive(plist)).toBe(true);
  });

  it("reads a pre-#872 plist as one that will NOT come back", () => {
    // The literal shape shipped before the fix — this is what an existing
    // install still has on disk after upgrading the package.
    expect(
      plistKeepsAlive(
        "<key>KeepAlive</key>\n    <dict>\n      <key>SuccessfulExit</key>\n      <false/>\n    </dict>",
      ),
    ).toBe(false);
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
    const odd = renderPlist(PADDOCK_SERVICE, buildSpec({ ...BASE, dataDir: "/Users/a&b/<pad>" }));
    expect(odd).toContain("/Users/a&amp;b/&lt;pad&gt;/service");
    expect(odd).not.toContain("/Users/a&b/<pad>");
    expect(parsePlistArgv(odd)).toBeTruthy();
  });

  it("round-trips its own argv", () => {
    const withFlags = renderPlist(PADDOCK_SERVICE, buildSpec({ ...BASE, port: "7299", dataDirArg: "/srv/p&d" }));
    expect(parsePlistArgv(withFlags).slice(2)).toEqual([
      "serve",
      "--port",
      "7299",
      "--data-dir",
      "/srv/p&d",
    ]);
  });

  it("lands in ~/Library/LaunchAgents under the reverse-DNS label", () => {
    expect(plistPath(PADDOCK_SERVICE, "/Users/ed")).toBe(
      `/Users/ed/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`,
    );
  });

  /**
   * The launchd twin of the `unitPath` regression below. launchd never had the
   * bug — `plistPath` reads no environment at all, and `~/Library/LaunchAgents`
   * has no XDG-style override to be tempted by — but the failure mode is
   * "injected home silently ignored", and it is worth one assertion to keep
   * that true if someone later adds an override here.
   */
  it("ignores ambient env entirely — an injected home is the whole answer", () => {
    withEnv("XDG_CONFIG_HOME", "/somewhere/else", () => {
      withEnv("HOME", "/somewhere/else", () => {
        expect(plistPath(PADDOCK_SERVICE, "/Users/ed")).toBe(
          `/Users/ed/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`,
        );
      });
    });
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
  const unit = renderUnit(PADDOCK_SERVICE, spec);

  it("matches the golden output", () => {
    expect(unit).toMatchInlineSnapshot(`
      "# Generated by Paddock: \`paddock service install\` rewrites this file.
      # Node: /opt/node/bin/node
      [Unit]
      Description=Paddock — persistent, resumable Claude Code sessions, by project
      Documentation=https://paddock.edspencer.net

      [Service]
      Type=simple
      ExecStart=/opt/node/bin/node /usr/local/lib/node_modules/@edspencer/paddock/packages/server/dist/cli/paddock.js serve
      WorkingDirectory=/home/ed/.paddock/service
      Environment="PATH=/opt/node/bin:/usr/bin:/bin"
      StandardOutput=append:/home/ed/.paddock/logs/service.log
      StandardError=append:/home/ed/.paddock/logs/service.log
      Restart=always
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

  /**
   * The launchd note applies verbatim (#872): `on-failure` plus a SIGTERM
   * handler that exits `0` means a logout stops Paddock for good. `always` does
   * not make the unit unstoppable — systemd never restarts a unit it was itself
   * asked to stop, so `systemctl --user stop` still works.
   */
  it("restarts unconditionally, not only on failure", () => {
    expect(unit).toContain("Restart=always");
    expect(unit).not.toContain("Restart=on-failure");
    expect(unitKeepsAlive(unit)).toBe(true);
  });

  it("reads a pre-#872 unit as one that will NOT come back", () => {
    expect(unitKeepsAlive(unit.replace("Restart=always", "Restart=on-failure"))).toBe(false);
  });

  it("round-trips its ExecStart", () => {
    expect(parseUnitArgv(renderUnit(PADDOCK_SERVICE, buildSpec({ ...BASE, port: "7299" }))).slice(2)).toEqual([
      "serve",
      "--port",
      "7299",
    ]);
  });

  it("honours an XDG config home when given one", () => {
    expect(unitPath(PADDOCK_SERVICE, "/home/ed", "/home/ed/.conf")).toBe(
      `/home/ed/.conf/systemd/user/${SYSTEMD_UNIT}`,
    );
  });

  /**
   * Regression, and the reason the rest of this block exists.
   *
   * `unitPath` used to read `process.env.XDG_CONFIG_HOME` *before* falling back
   * to `homeDir`, which made the `homeDir` parameter a lie on any machine where
   * that variable is set. It is unset on this box and set on CI, so the suite
   * was green locally and red there — and the red was not a flake. Two real
   * consequences, in order of severity:
   *
   * 1. The suite WROTE a `paddock.service` into the runner's actual config
   *    directory, outside every temp dir it believed it was confined to. On a
   *    contributor's Linux machine that is a unit file they did not ask for.
   * 2. Test isolation silently stopped working, so which assertion passed
   *    depended on test order rather than test content.
   *
   * Precedence is now: explicit xdg argument > injected home > ambient env.
   */
  it("lets an injected home beat the ambient XDG_CONFIG_HOME", () => {
    withEnv("XDG_CONFIG_HOME", "/somewhere/else", () => {
      expect(unitPath(PADDOCK_SERVICE, "/home/ed")).toBe(`/home/ed/.config/systemd/user/${SYSTEMD_UNIT}`);
    });
  });

  it("still honours the ambient XDG_CONFIG_HOME when no home is injected", () => {
    // The real-use branch: nobody stated a home, so the environment is the best
    // available answer and dropping it would put the unit in the wrong place.
    withEnv("XDG_CONFIG_HOME", "/somewhere/else", () => {
      expect(unitPath(PADDOCK_SERVICE)).toBe(`/somewhere/else/systemd/user/${SYSTEMD_UNIT}`);
    });
  });
});

// ---------------------------------------------------------------------------
// The flows, against a recording runner
// ---------------------------------------------------------------------------

/**
 * A fake runner that records what was asked of it.
 *
 * With no argument it is **a machine with nothing loaded**, which is why
 * `launchctl print` answers 3 rather than 0: a bare `recorder()` drives the
 * installs below, and `install` now polls `print` until launchd says the label
 * has gone (the bootout/bootstrap race, see launchd.ts). A fake that kept
 * claiming the label was loaded would make every one of those tests sit out the
 * ten-second bootout timeout and then pass anyway, which is the worst of both.
 *
 * Pass a `result` and it answers EVERY command with it, `print` included — that
 * is what the tests describing one particular launchctl failure want.
 */
function recorder(result: Partial<RunResult> = {}): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const nothingLoaded = Object.keys(result).length === 0;
  const run: Runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (nothingLoaded && cmd === "launchctl" && args[0] === "print")
      return { status: 3, stdout: "", stderr: "Could not find service" };
    return { status: 0, stdout: "", stderr: "", ...result };
  };
  return { run, calls };
}

/** The injected sleep, as a no-op: the poll and retry loops without their waits. */
const noSleep = (): void => undefined;

/**
 * Run `body` with `console.log` diverted, and hand back everything it printed.
 *
 * Async because `runService` is: `install` (#861) and `start` / `restart`
 * (#873) each await a readiness poll, so a synchronous capture would restore
 * `console.log` before the interesting half of the output was written and
 * return a string that looks like a missing message rather than a
 * mis-written test.
 */
async function capture(body: () => void | Promise<void>): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    await body();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

/** A context aimed at one platform's backend, with a recording runner. */
function contextFor(platform: "darwin" | "linux", home: string, run: Runner) {
  return {
    platform: platform as NodeJS.Platform,
    nodePath: BASE.nodePath,
    scriptPath: BASE.scriptPath,
    packageRoot: "/usr/local/lib/node_modules/@edspencer/paddock",
    homeDir: home,
    run,
  };
}

const OPTS = { open: false, verbose: false, help: false, version: false };

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
    const backend = createLaunchd(PADDOCK_SERVICE, { run: run, homeDir: home });
    backend.install(spec());

    // `print` between the two is the bootout poll: launchctl returns from a
    // bootout before the job has gone, and bootstrapping into that window is
    // the exit-5 race (see launchd.ts).
    expect(calls.map((c) => c[1])).toEqual(["bootout", "print", "bootstrap", "kickstart"]);
    // `load`/`unload` are the legacy API; on a modern macOS they are shims that
    // report success in cases where `bootstrap` reports the actual error.
    expect(calls.flat()).not.toContain("load");
    expect(calls.flat()).not.toContain("unload");
    expect(fs.existsSync(plistPath(PADDOCK_SERVICE, home))).toBe(true);
    expect(fs.existsSync(spec().workingDirectory)).toBe(true);
  });

  it("launchd install surfaces a bootstrap failure rather than claiming success", () => {
    // Exit 5 is retried first (the bootout/bootstrap race), hence `noSleep`;
    // what this pins is that running out of retries still REPORTS, with
    // launchd's own words, rather than returning as if it had worked.
    const { run } = recorder({ status: 5, stderr: "Bootstrap failed: 5: Input/output error" });
    expect(() => createLaunchd(PADDOCK_SERVICE, { run: run, homeDir: home, sleep: noSleep }).install(spec())).toThrow(
      /Input\/output error/,
    );
  });

  it("systemd install reloads the daemon before enabling, and does not restart a stopped unit", () => {
    // Without the reload the manager serves the cached previous unit and an
    // "upgrade" silently changes nothing.
    //
    // And NO restart on a first install: `enable --now` has just started it, and a second start
    // milliseconds later eats half of systemd's five-in-ten-seconds start limit for nothing.
    const { run, calls } = recorder();
    createSystemd(PADDOCK_SERVICE, { run: run, homeDir: home }).install(spec());
    expect(calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "paddock.service"],
    ]);
  });

  /**
   * The reinstall-over-a-running-service case, which is the one that bit.
   *
   * `systemctl --user enable --now` does NOTHING to a unit that is already active, so a reinstall
   * wrote a new unit and left the old process serving — and reported success. That is exactly the
   * state `paddock update`'s rollback is in: it runs `service install --refresh` while the FAILED
   * version is still up, so without the restart the "restored" service was the broken one, and a
   * clean exit 6 became an exit 7. Found end to end by scripts/update-registry.mjs; a unit test of
   * the call sequence could not see it, because the call sequence was right.
   */
  it("systemd install RESTARTS a unit that was already active", () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-reinstall-"));
    try {
      const target = buildSpec({ ...BASE, dataDir: path.join(h, ".paddock") });
      createSystemd(PADDOCK_SERVICE, { run: recorder().run, homeDir: h }).install(target);
      // Now it is running, as far as the manager is concerned.
      const calls: string[][] = [];
      const run: Runner = (cmd, args) => {
        calls.push([cmd, ...args]);
        if (args[1] === "is-active") return { status: 0, stdout: "active\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      };
      createSystemd(PADDOCK_SERVICE, { run: run, homeDir: h }).install(target);
      expect(calls).toEqual([
        ["systemctl", "--user", "is-active", "paddock.service"],
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", "paddock.service"],
        ["systemctl", "--user", "restart", "paddock.service"],
      ]);
    } finally {
      fs.rmSync(h, { recursive: true, force: true });
    }
  });

  it("status reports the port recorded in the INSTALLED unit, not today's default", () => {
    const { run } = recorder();
    const backend = createLaunchd(PADDOCK_SERVICE, { run: run, homeDir: home });
    backend.install(buildSpec({ ...BASE, dataDir: path.join(home, ".paddock"), port: "7299" }));

    const printing = recorder({ stdout: "\tstate = running\n\tpid = 99\n" });
    const state = createLaunchd(PADDOCK_SERVICE, { run: printing.run, homeDir: home }).status();
    expect(state).toEqual({
      registered: true,
      running: true,
      pid: "99",
      argv: ["serve", "--port", "7299"],
      // Reported separately so `status` can say "the Node it runs has gone"
      // (SPEC §7) — only answerable from the paths in the FILE.
      nodePath: BASE.nodePath,
      cliPath: BASE.scriptPath,
      logPath: path.join(home, ".paddock", "logs", "service.log"),
      keepsAlive: true,
    });
  });

  it("status ignores an install-only --data-dir rather than mixing it into the log path (#824)", async () => {
    // `status` reports the INSTALLED unit. `resolveDataDir` gives `opts.dataDir`
    // precedence over the unit's value — correct for `install`, wrong here: it
    // printed the unit's `Data:` beside a `Logs:` path under today's flag, i.e.
    // a directory the service never writes to. darwin because that is where the
    // log path is a real file rather than journald.
    const { run } = recorder();
    createLaunchd(PADDOCK_SERVICE, { run: run, homeDir: home }).install(buildSpec({ ...BASE, dataDir: path.join(home, ".paddock") }));

    const printing = recorder({ stdout: "\tstate = running\n\tpid = 99\n" });
    const ctx = contextFor("darwin", home, printing.run);

    const out = await capture(() =>
      runService("status", { ...OPTS, dataDir: "/srv/other" }, ctx),
    );
    expect(out).toMatch(/Logs:/);
    // The whole point: nothing in the report may come from the passed flag.
    expect(out).not.toContain("/srv/other");
  });

  /**
   * The part of #872 that reaches people who already installed.
   *
   * Upgrading the package rewrites no unit file, so the fix only lands when
   * someone re-runs `install` — and nobody re-runs install for a service that
   * looks fine. The symptom is Paddock absent one morning with a clean log, and
   * `status` is the one place that can connect the two.
   */
  it("status warns when the INSTALLED unit predates the always-restart fix (#872)", async () => {
    const { run } = recorder();
    createSystemd(PADDOCK_SERVICE, { run: run, homeDir: home }).install(spec());

    const file = path.join(home, ".config", "systemd", "user", SYSTEMD_UNIT);
    const rewrite = (from: string, to: string) =>
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(from, to));
    rewrite("Restart=always", "Restart=on-failure");

    const ctx = contextFor("linux", home, recorder({ stdout: "active" }).run);

    const stale = await capture(() => runService("status", OPTS, ctx));
    expect(stale).toContain("#872");
    expect(stale).toContain("paddock service install");

    // The control: the unit we write TODAY draws no warning.
    rewrite("Restart=on-failure", "Restart=always");
    expect(await capture(() => runService("status", OPTS, ctx))).not.toContain("#872");
  });

  it("status on a machine with no unit says so without shelling out", () => {
    const { run, calls } = recorder();
    expect(createSystemd(PADDOCK_SERVICE, { run: run, homeDir: home }).status()).toEqual({
      registered: false,
      running: false,
      argv: [],
      keepsAlive: true,
    });
    expect(calls).toEqual([]);
  });

  /**
   * The CI failure, reproduced at the layer it actually bit.
   *
   * `createSystemd` took a `homeDir` and then called `unitPath(PADDOCK_SERVICE, homeDir)`
   * — which consulted `process.env.XDG_CONFIG_HOME` first. With that variable
   * set, install wrote outside the temp home and the *next* test found the file
   * there, so `status` on a "fresh" home reported `registered: true`.
   *
   * Both halves are asserted: the injected home wins, AND nothing lands in the
   * directory the ambient variable points at.
   */
  it("keeps an injected home authoritative when XDG_CONFIG_HOME points elsewhere", () => {
    const decoy = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-xdg-decoy-"));
    try {
      withEnv("XDG_CONFIG_HOME", decoy, () => {
        const { run } = recorder();
        const backend = createSystemd(PADDOCK_SERVICE, { run: run, homeDir: home });
        backend.install(spec());

        expect(backend.unitPath.startsWith(home)).toBe(true);
        expect(fs.existsSync(path.join(home, ".config/systemd/user/paddock.service"))).toBe(true);
        // The decoy stands in for the contributor's real config directory.
        expect(fs.readdirSync(decoy)).toEqual([]);

        // And a genuinely fresh home is still seen as unregistered, which is
        // the assertion CI failed on.
        const other = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-fresh-"));
        try {
          expect(createSystemd(PADDOCK_SERVICE, { run: recorder().run, homeDir: other }).status().registered).toBe(false);
        } finally {
          fs.rmSync(other, { recursive: true, force: true });
        }
      });
    } finally {
      fs.rmSync(decoy, { recursive: true, force: true });
    }
  });

  it("uninstall removes the unit and reports whether there was one", () => {
    const { run } = recorder();
    const backend = createLaunchd(PADDOCK_SERVICE, { run: run, homeDir: home });
    backend.install(spec());
    expect(backend.uninstall()).toBe(true);
    expect(fs.existsSync(plistPath(PADDOCK_SERVICE, home))).toBe(false);
    expect(backend.uninstall()).toBe(false);
  });

  it("uninstall leaves the logs behind", () => {
    // The last thing anyone wants from `uninstall` is for the record of why
    // they are uninstalling to vanish with it.
    const { run } = recorder();
    const backend = createLaunchd(PADDOCK_SERVICE, { run: run, homeDir: home });
    const s = spec();
    backend.install(s);
    fs.writeFileSync(s.logPath, "boom\n");
    backend.uninstall();
    expect(fs.readFileSync(s.logPath, "utf8")).toBe("boom\n");
  });
});

// ---------------------------------------------------------------------------
// start / stop / restart (#873)
// ---------------------------------------------------------------------------

describe("paddock service: start / stop / restart (#873)", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-lifecycle-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const spec = () => buildSpec({ ...BASE, dataDir: path.join(home, ".paddock") });
  const ready = async () => "ready" as const;

  it("parses each new action, and none of them collides with the `start` VERB", () => {
    // `paddock start` is a server in this terminal; `paddock service start` is
    // a request to the supervisor. Dispatch is on argv[0] alone, so the shared
    // word is never ambiguous — but it is exactly the kind of thing that breaks
    // silently, so it is pinned.
    for (const action of ["start", "stop", "restart", "logs"] as const) {
      expect(parseCommand(["service", action])).toEqual({
        verb: "service",
        action,
        opts: parseArgs([]),
      });
    }
    expect(parseCommand(["start"])).toEqual({ verb: "serve", opts: parseArgs([]) });
    expect(SERVICE_USAGE).toContain("paddock service restart");
  });

  it("launchd start BOOTSTRAPS rather than `launchctl start`", () => {
    // `stop` boots the job out, so a stopped Paddock is absent from the domain
    // entirely — `launchctl start` on a label launchd does not know fails.
    const { run, calls } = recorder();
    const backend = createLaunchd(PADDOCK_SERVICE, { run: run, homeDir: home });
    backend.install(spec());
    calls.length = 0;

    backend.start();
    expect(calls.map((c) => c[1])).toEqual(["bootstrap", "kickstart"]);
  });

  it("launchd stop BOOTS OUT rather than `launchctl stop`", () => {
    // With #872's unconditional KeepAlive, `launchctl stop` is a request
    // launchd overrules by relaunching. Booting out unloads the job, so
    // KeepAlive no longer applies and it stays down.
    const { run, calls } = recorder();
    createLaunchd(PADDOCK_SERVICE, { run: run, homeDir: home }).stop();
    const target = `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`;
    // The bootout, then the wait for the job to go (the race note in launchd.ts); this recorder says it's gone at once.
    expect(calls).toEqual([
      ["launchctl", "bootout", target],
      ["launchctl", "print", target],
    ]);
    expect(calls.flat()).not.toContain("stop");
  });

  it("launchd stop treats 'no such process' as the state that was asked for", () => {
    const gone = recorder({ status: 3, stderr: "Boot-out failed: 3: No such process" });
    expect(() => createLaunchd(PADDOCK_SERVICE, { run: gone.run, homeDir: home }).stop()).not.toThrow();

    const broken = recorder({ status: 9, stderr: "Boot-out failed: 9: Bad file descriptor" });
    expect(() => createLaunchd(PADDOCK_SERVICE, { run: broken.run, homeDir: home }).stop()).toThrow(/Bad file descriptor/);
  });

  it("launchd restart works from stopped, not just from running", () => {
    // `kickstart -k` alone needs a LOADED job, so it fails on the case restart
    // most needs to handle. Boot out, bootstrap, kick — same as install, minus
    // writing the plist, which is also what re-reads an edited unit.
    const { run, calls } = recorder();
    const backend = createLaunchd(PADDOCK_SERVICE, { run: run, homeDir: home });
    backend.install(spec());
    calls.length = 0;

    backend.restart();
    expect(calls.map((c) => c.slice(1))).toEqual([
      ["bootout", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`],
      // The bootout poll: see launchd.ts's race note, and the tests below.
      ["print", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`],
      ["bootstrap", `gui/${process.getuid?.() ?? 0}`, plistPath(PADDOCK_SERVICE, home)],
      ["kickstart", "-k", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`],
    ]);
  });

  // -------------------------------------------------------------------------
  // The bootout/bootstrap race. This is the bug that failed Paddock 0.80.0's
  // first release run: CI's real-launchd job ran `paddock service restart`, and
  // `bootstrap` landed inside launchd's unfinished bootout and came back
  // `exit 5: Input/output error`. It had passed on the PR, because it is a
  // race. Both halves are pinned here, and each is asserted to be LOAD-BEARING
  // by a case the other half cannot rescue.
  // -------------------------------------------------------------------------

  /**
   * A fake launchd whose bootout takes `lingerFor` polls to take effect, and
   * whose bootstrap fails while the job is still there.
   *
   * That is the real failure mode in miniature: a bootstrap issued too early
   * does not queue, it errors.
   */
  function lingeringLaunchd(lingerFor: number): { run: Runner; calls: string[][] } {
    const calls: string[][] = [];
    let loaded = true;
    let polls = 0;
    const run: Runner = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === "print") {
        if (loaded && ++polls >= lingerFor) loaded = false;
        return loaded
          ? { status: 0, stdout: "\tstate = running\n\tpid = 42\n", stderr: "" }
          : { status: 3, stdout: "", stderr: "Could not find service" };
      }
      if (args[0] === "bootstrap" && loaded)
        return { status: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
      return { status: 0, stdout: "", stderr: "" };
    };
    return { run, calls };
  }

  it("restart waits for the bootout to take effect before bootstrapping", () => {
    // Three polls' worth of teardown. Without the wait, the bootstrap would be
    // the first thing after the bootout and would fail with 5.
    const { run, calls } = lingeringLaunchd(3);
    const backend = createLaunchd(PADDOCK_SERVICE, { run: run, homeDir: home, sleep: noSleep });
    fs.mkdirSync(path.dirname(plistPath(PADDOCK_SERVICE, home)), { recursive: true });
    fs.writeFileSync(plistPath(PADDOCK_SERVICE, home), "<plist/>");

    expect(() => backend.restart()).not.toThrow();

    const verbs = calls.map((c) => c[1]);
    expect(verbs).toEqual(["bootout", "print", "print", "print", "bootstrap", "kickstart"]);
    // The assertion that makes this a test of the FIX and not of the fake: the
    // bootstrap happened after the last poll, not before it.
    expect(verbs.lastIndexOf("print")).toBeLessThan(verbs.indexOf("bootstrap"));
  });

  it("a bootstrap that loses the race anyway is retried, not reported", () => {
    // The half the poll cannot cover: a bootout this process never issued is
    // still in flight — `service start` after another process's `service stop`.
    // There is nothing to poll for, because from here the job is already gone.
    const calls: string[][] = [];
    let attempts = 0;
    const run: Runner = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === "print") return { status: 3, stdout: "", stderr: "" };
      if (args[0] === "bootstrap" && ++attempts < 3)
        return { status: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
      return { status: 0, stdout: "", stderr: "" };
    };
    fs.mkdirSync(path.dirname(plistPath(PADDOCK_SERVICE, home)), { recursive: true });
    fs.writeFileSync(plistPath(PADDOCK_SERVICE, home), "<plist/>");

    expect(() => createLaunchd(PADDOCK_SERVICE, { run: run, homeDir: home, sleep: noSleep }).start()).not.toThrow();
    expect(calls.filter((c) => c[1] === "bootstrap")).toHaveLength(3);
    // It still kicks it afterwards: a retried bootstrap is a successful one.
    expect(calls.at(-1)?.[1]).toBe("kickstart");
  });

  it("a bootstrap failure that is NOT the race is reported at once", () => {
    // The control. Retrying a malformed plist only delays the message, so only
    // launchd's two race codes are retried — and this proves 112 is not one.
    const calls: string[][] = [];
    const run: Runner = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === "print") return { status: 3, stdout: "", stderr: "" };
      if (args[0] === "bootstrap")
        return { status: 112, stdout: "", stderr: "Bootstrap failed: 112: Could not find domain" };
      return { status: 0, stdout: "", stderr: "" };
    };
    fs.mkdirSync(path.dirname(plistPath(PADDOCK_SERVICE, home)), { recursive: true });
    fs.writeFileSync(plistPath(PADDOCK_SERVICE, home), "<plist/>");

    expect(() => createLaunchd(PADDOCK_SERVICE, { run: run, homeDir: home, sleep: noSleep }).start()).toThrow(/Could not find domain/);
    expect(calls.filter((c) => c[1] === "bootstrap")).toHaveLength(1);
  });

  it("a job that never goes is reported by the bootstrap, not by a hang", () => {
    // The poll times out rather than throwing: the bootstrap is the thing that
    // knows what went wrong, and it says so in launchd's own words. What must
    // not happen is an unbounded wait.
    const { run, calls } = lingeringLaunchd(Number.POSITIVE_INFINITY);
    fs.mkdirSync(path.dirname(plistPath(PADDOCK_SERVICE, home)), { recursive: true });
    fs.writeFileSync(plistPath(PADDOCK_SERVICE, home), "<plist/>");

    expect(() => createLaunchd(PADDOCK_SERVICE, { run: run, homeDir: home, sleep: noSleep }).restart()).toThrow(
      /Input\/output error/,
    );
    // It gave up polling, and it gave up retrying: neither loop is unbounded.
    expect(calls.filter((c) => c[1] === "print").length).toBeLessThan(100);
    expect(calls.filter((c) => c[1] === "bootstrap")).toHaveLength(6);
  });

  it("systemd start/stop/restart use the verbs, and never touch enable/disable", () => {
    // enable/disable decide whether Paddock returns at the NEXT login, which is
    // a different question from whether it is running now. `uninstall` is the
    // only command that gets to answer both.
    const { run, calls } = recorder();
    const backend = createSystemd(PADDOCK_SERVICE, { run: run, homeDir: home });
    backend.start();
    backend.stop();
    backend.restart();

    expect(calls).toEqual([
      // A unit that hit systemd's start limit stays failed, and won't start, until reset-failed.
      ["systemctl", "--user", "reset-failed", SYSTEMD_UNIT],
      ["systemctl", "--user", "start", SYSTEMD_UNIT],
      ["systemctl", "--user", "stop", SYSTEMD_UNIT],
      // The reload is what makes an EDITED unit take effect on the way up.
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "reset-failed", SYSTEMD_UNIT],
      ["systemctl", "--user", "restart", SYSTEMD_UNIT],
    ]);
    expect(calls.flat()).not.toContain("enable");
    expect(calls.flat()).not.toContain("disable");
  });

  it("systemd surfaces the manager's own words rather than claiming success", () => {
    const { run } = recorder({ status: 5, stderr: "Failed to start paddock.service: Unit not found." });
    expect(() => createSystemd(PADDOCK_SERVICE, { run: run, homeDir: home }).start()).toThrow(/Unit not found/);
  });

  it("start on a machine with no unit says install, and shells out to nothing", () => {
    const { run, calls } = recorder();
    const ctx = { ...contextFor("linux", home, run), checkReady: ready };
    return capture(() => runService("start", OPTS, ctx)).then((out) => {
      expect(out).toContain("not installed as a service");
      expect(out).toContain("paddock service install");
      expect(calls).toEqual([]);
    });
  });

  it("start on an already-running service reports it instead of erroring", async () => {
    // Bootstrapping a job that is already loaded is an error, and "it is
    // already up" is the outcome the user wanted anyway.
    const { run } = recorder();
    createSystemd(PADDOCK_SERVICE, { run: run, homeDir: home }).install(spec());

    const active = recorder({ stdout: "active" });
    const ctx = { ...contextFor("linux", home, active.run), checkReady: ready };
    const out = await capture(() => runService("start", OPTS, ctx));

    expect(out).toContain("already running");
    expect(active.calls.flat()).not.toContain("start");
  });

  it("stop leaves the unit installed, and says how to get it back", async () => {
    const { run } = recorder();
    createSystemd(PADDOCK_SERVICE, { run: run, homeDir: home }).install(spec());

    const active = recorder({ stdout: "active" });
    const out = await capture(() =>
      runService("stop", OPTS, contextFor("linux", home, active.run)),
    );

    expect(out).toContain("still installed");
    expect(out).toContain("paddock service start");
    expect(active.calls).toContainEqual(["systemctl", "--user", "stop", SYSTEMD_UNIT]);
    // The distinction from `uninstall`, and the whole reason `stop` exists.
    expect(fs.existsSync(path.join(home, ".config", "systemd", "user", SYSTEMD_UNIT))).toBe(true);
  });

  it("stop on an already-stopped service does not shell out", async () => {
    const { run } = recorder();
    createSystemd(PADDOCK_SERVICE, { run: run, homeDir: home }).install(spec());

    const inactive = recorder({ stdout: "inactive" });
    const out = await capture(() =>
      runService("stop", OPTS, contextFor("linux", home, inactive.run)),
    );

    expect(out).toContain("already stopped");
    expect(inactive.calls.flat()).not.toContain("stop");
  });

  /**
   * The line the issue asks for, and the one that would otherwise be a lie.
   *
   * Neither supervisor's "started" means the port answers — it means the fork
   * succeeded. A port clash restarts every `RestartSec`/`ThrottleInterval` and
   * reports `active`/`running` for most of that window, so an optimistic print
   * puts "✓ running at <url>" over a crash-loop.
   */
  it("restart claims success only after the URL answers", async () => {
    const { run } = recorder();
    createSystemd(PADDOCK_SERVICE, { run: run, homeDir: home }).install(buildSpec({ ...BASE, dataDir: path.join(home, ".paddock"), port: "7299" }));
    const active = recorder({ stdout: "active" });

    const good = await capture(() =>
      runService("restart", OPTS, {
        ...contextFor("linux", home, active.run),
        checkReady: ready,
      }),
    );
    expect(good).toContain("✓ Paddock is running");
    // The port comes from the INSTALLED unit, not from today's default.
    expect(good).toContain("http://127.0.0.1:7299");

    const bad = await capture(() =>
      runService("restart", OPTS, {
        ...contextFor("linux", home, active.run),
        checkReady: async () => "timeout" as const,
      }),
    );
    expect(bad).not.toContain("✓");
    expect(bad).toContain("did not");
    expect(bad).toContain("paddock service status");
  });
});

// ---------------------------------------------------------------------------
// install: progress, and a success line that has been checked (#861)
// ---------------------------------------------------------------------------

describe("paddock service: install progress + readiness (#861)", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-install-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const ready = async () => "ready" as const;
  const timeout = async () => "timeout" as const;

  /**
   * The reported defect, stated as an ordering property.
   *
   * `backend.install` is where the seconds go — `launchctl bootout` /
   * `bootstrap` / `kickstart` through `spawnSync`, plus macOS registering the
   * login item. Printing the explanation AFTER it is the same silence with
   * extra words at the end, so what has to be pinned is that the line comes
   * FIRST, not merely that it exists.
   */
  it("explains the wait BEFORE the blocking install, not after it", async () => {
    let seen = "";
    let printedBeforeInstall: string | undefined;
    // Snapshot stdout at the moment the first subprocess is spawned — i.e. the
    // instant the silence used to begin.
    const run: Runner = () => {
      printedBeforeInstall ??= seen;
      return { status: 0, stdout: "", stderr: "" };
    };
    const original = console.log;
    console.log = (...a: unknown[]) => void (seen += a.map(String).join(" ") + "\n");
    try {
      await runService("install", OPTS, {
        ...contextFor("darwin", home, run),
        checkReady: ready,
      });
    } finally {
      console.log = original;
    }

    expect(printedBeforeInstall ?? "").toMatch(/Installing the LaunchAgent and starting Paddock/);
    // macOS's Background-Task-Management approval is most of the delay and is
    // out of our control, so it gets named rather than waited out in silence.
    expect(printedBeforeInstall ?? "").toMatch(/macOS may take a few seconds/);
  });

  it("names the user service, not a LaunchAgent, on Linux", async () => {
    const out = await capture(() =>
      runService("install", OPTS, {
        ...contextFor("linux", home, recorder().run),
        checkReady: ready,
      }),
    );
    expect(out).toMatch(/Installing the user service and starting Paddock/);
    expect(out).not.toContain("LaunchAgent");
    // The macOS-only caveat must not follow the unit onto Linux.
    expect(out).not.toContain("macOS");
  });

  /**
   * The second half of #861, and the one that makes the message honest.
   *
   * "running now" was printed unconditionally, before anything had been
   * checked — so it could sit over a crash-loop (a port clash restarts every
   * `ThrottleInterval`/`RestartSec`) and still show a URL and a tick.
   */
  it("claims success only after the URL answers", async () => {
    const good = await capture(() =>
      runService("install", OPTS, {
        ...contextFor("linux", home, recorder().run),
        checkReady: ready,
      }),
    );
    expect(good).toMatch(/✓ Paddock is installed as a systemd --user service, and running at/);
    expect(good).toContain("Waiting for http://127.0.0.1:7233 to answer…");

    const bad = await capture(() =>
      runService("install", OPTS, {
        ...contextFor("linux", home, recorder().run),
        checkReady: timeout,
      }),
    );
    // Not a tick, not "running" — and still truthful about what DID happen, so
    // the unit does not read as un-installed.
    expect(bad).not.toContain("✓");
    expect(bad).not.toMatch(/and running at/);
    expect(bad).toContain("did not answer");
    expect(bad).toContain("The unit is in place");
    expect(bad).toMatch(/Logs:/);
  });

  it("waits on the URL the unit was actually installed with", async () => {
    // A readiness check against the DEFAULT port while the unit names another
    // would time out on every non-default install — a false alarm on a healthy
    // service, which is worse than no check at all.
    let probed = "";
    await capture(() =>
      runService(
        "install",
        { ...OPTS, port: "7299" },
        {
          ...contextFor("linux", home, recorder().run),
          checkReady: async (u) => {
            probed = u;
            return "ready";
          },
        },
      ),
    );
    expect(probed).toBe("http://127.0.0.1:7299");
  });

  it("still prints everything install always printed", async () => {
    // The report is what people screenshot into issues; the progress lines are
    // additive, not a replacement. loginctl says linger is off, so the
    // enable-linger line is part of it (SPEC 1.0 §7).
    const base = recorder().run;
    const lingerOff: Runner = (cmd, args) =>
      cmd === "loginctl" ? { status: 0, stdout: "Linger=no\n", stderr: "" } : base(cmd, args);
    const out = await capture(() =>
      runService("install", OPTS, {
        ...contextFor("linux", home, lingerOff),
        checkReady: ready,
      }),
    );
    for (const expected of [
      "Data: ",
      "Unit: ",
      "Logs: ",
      "LOG IN, not when the machine boots",
      "loginctl enable-linger",
      "paddock service status",
      "paddock service uninstall",
    ]) {
      expect(out).toContain(expected);
    }
  });

  it("says nothing about linger when loginctl can't answer (SPEC 1.0 §7)", async () => {
    const out = await capture(() =>
      runService("install", OPTS, {
        ...contextFor("linux", home, recorder().run),
        checkReady: ready,
      }),
    );
    expect(out).not.toContain("enable-linger");
    expect(out).not.toContain("could not reach loginctl");
  });

  it("probes /api/health, which is auth-exempt, and gives up on the clock", async () => {
    const seen: string[] = [];
    const okAfter = (n: number): typeof fetch =>
      (async (u: string | URL | Request) => {
        seen.push(String(u));
        if (seen.length < n) throw new Error("ECONNREFUSED");
        return { ok: true } as Response;
      }) as unknown as typeof fetch;

    await expect(
      waitForReady({
        url: "http://127.0.0.1:7233",
        fetchImpl: okAfter(3),
        sleep: async () => {},
      }),
    ).resolves.toBe("ready");
    // Retrying a refused connection is the POINT: a server that has not
    // finished binding refuses, and that is "not yet", not "failed".
    expect(seen).toEqual(Array(3).fill("http://127.0.0.1:7233/api/health"));

    // A clock that has already run out ends the loop rather than hanging.
    let t = 0;
    await expect(
      waitForReady({
        url: "http://127.0.0.1:7233",
        timeoutMs: 500,
        fetchImpl: (async () => {
          throw new Error("ECONNREFUSED");
        }) as unknown as typeof fetch,
        now: () => (t += 200),
        sleep: async () => {},
      }),
    ).resolves.toBe("timeout");
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

  // `rejects` rather than `toThrow`: `runService` became async in #861
  // (install awaits a readiness poll) and #873 (so do start and restart), so a
  // refusal is now a rejected promise and a synchronous `toThrow` would pass
  // vacuously.
  it("refuses to install from an npx cache path, and names the fix", async () => {
    // A hash-keyed directory `npm cache clean` removes. The unit would work
    // until it silently didn't — at a login, unattended.
    const npx = { ...ctx, packageRoot: "/Users/ed/.npm/_npx/399ccf38/node_modules" };
    await expect(runService("install", opts, npx)).rejects.toThrow(CliError);
    await expect(runService("install", opts, npx)).rejects.toThrow(
      /npm i -g @edspencer\/paddock/,
    );
  });

  it("names the platform it cannot serve", async () => {
    const win = { ...ctx, platform: "win32" as NodeJS.Platform };
    await expect(runService("status", opts, win)).rejects.toThrow(/not win32/);
  });
});

describe("lingerNote (SPEC 1.0 §7)", () => {
  it("prints the enable-linger line only when linger is off", async () => {
    const { lingerNote } = await import("../../src/cli/service/index.js");
    const off = lingerNote({ applies: true, user: "ed", enabled: false });
    expect(off).toContain("Lingering is off");
    expect(off).toContain("To keep Paddock up, once:");
    expect(off).toContain("sudo loginctl enable-linger ed");
    // loginctl couldn't answer (a container, no loginctl): say nothing, as doctor reports it skipped.
    expect(lingerNote({ applies: true, user: "ed" })).toBeUndefined();
    expect(lingerNote({ applies: true, user: "ed", enabled: true })).toBeUndefined();
    expect(lingerNote({ applies: false })).toBeUndefined();
  });
});

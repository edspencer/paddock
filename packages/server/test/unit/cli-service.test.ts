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
  plistKeepsAlive,
  createLaunchdBackend,
} from "../../src/cli/service/launchd.js";
import {
  renderUnit,
  unitPath,
  parseUnitArgv,
  unitKeepsAlive,
  createSystemdBackend,
} from "../../src/cli/service/systemd.js";
import { waitForReady } from "../../src/cli/service/ready.js";
import type { RunResult, Runner } from "../../src/cli/service/backend.js";
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
          <true/>
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
        expect(plistPath("/Users/ed")).toBe(
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
    expect(parseUnitArgv(renderUnit(buildSpec({ ...BASE, port: "7299" }))).slice(2)).toEqual([
      "start",
      "--port",
      "7299",
    ]);
  });

  it("honours an XDG config home when given one", () => {
    expect(unitPath("/home/ed", "/home/ed/.conf")).toBe(
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
      expect(unitPath("/home/ed")).toBe(`/home/ed/.config/systemd/user/${SYSTEMD_UNIT}`);
    });
  });

  it("still honours the ambient XDG_CONFIG_HOME when no home is injected", () => {
    // The real-use branch: nobody stated a home, so the environment is the best
    // available answer and dropping it would put the unit in the wrong place.
    withEnv("XDG_CONFIG_HOME", "/somewhere/else", () => {
      expect(unitPath()).toBe(`/somewhere/else/systemd/user/${SYSTEMD_UNIT}`);
    });
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

/**
 * Run `body` with `console.log` diverted, and hand back everything it printed.
 *
 * Async because `runService` is: `start`/`restart` await a readiness poll, so a
 * synchronous capture would restore `console.log` before the interesting half
 * of the output was written and return an empty string that looks like a
 * missing message rather than a mis-written test.
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
    createLaunchdBackend(run, home).install(buildSpec({ ...BASE, dataDir: path.join(home, ".paddock") }));

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
    createSystemdBackend(run, home).install(spec());

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
    expect(createSystemdBackend(run, home).status()).toEqual({
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
   * `createSystemdBackend` took a `homeDir` and then called `unitPath(homeDir)`
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
        const backend = createSystemdBackend(run, home);
        backend.install(spec());

        expect(backend.unitPath.startsWith(home)).toBe(true);
        expect(fs.existsSync(path.join(home, ".config/systemd/user/paddock.service"))).toBe(true);
        // The decoy stands in for the contributor's real config directory.
        expect(fs.readdirSync(decoy)).toEqual([]);

        // And a genuinely fresh home is still seen as unregistered, which is
        // the assertion CI failed on.
        const other = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-fresh-"));
        try {
          expect(createSystemdBackend(recorder().run, other).status().registered).toBe(false);
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
    for (const action of ["start", "stop", "restart"] as const) {
      expect(parseCommand(["service", action])).toEqual({
        verb: "service",
        action,
        opts: parseArgs([]),
      });
    }
    expect(parseCommand(["start"])).toEqual({ verb: "start", opts: parseArgs([]) });
    expect(SERVICE_USAGE).toContain("paddock service restart");
  });

  it("launchd start BOOTSTRAPS rather than `launchctl start`", () => {
    // `stop` boots the job out, so a stopped Paddock is absent from the domain
    // entirely — `launchctl start` on a label launchd does not know fails.
    const { run, calls } = recorder();
    const backend = createLaunchdBackend(run, home);
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
    createLaunchdBackend(run, home).stop();
    expect(calls).toEqual([["launchctl", "bootout", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`]]);
    expect(calls.flat()).not.toContain("stop");
  });

  it("launchd stop treats 'no such process' as the state that was asked for", () => {
    const gone = recorder({ status: 3, stderr: "Boot-out failed: 3: No such process" });
    expect(() => createLaunchdBackend(gone.run, home).stop()).not.toThrow();

    const broken = recorder({ status: 9, stderr: "Boot-out failed: 9: Bad file descriptor" });
    expect(() => createLaunchdBackend(broken.run, home).stop()).toThrow(/Bad file descriptor/);
  });

  it("launchd restart works from stopped, not just from running", () => {
    // `kickstart -k` alone needs a LOADED job, so it fails on the case restart
    // most needs to handle. Boot out, bootstrap, kick — same as install, minus
    // writing the plist, which is also what re-reads an edited unit.
    const { run, calls } = recorder();
    const backend = createLaunchdBackend(run, home);
    backend.install(spec());
    calls.length = 0;

    backend.restart();
    expect(calls.map((c) => c.slice(1))).toEqual([
      ["bootout", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`],
      ["bootstrap", `gui/${process.getuid?.() ?? 0}`, plistPath(home)],
      ["kickstart", "-k", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`],
    ]);
  });

  it("systemd start/stop/restart use the verbs, and never touch enable/disable", () => {
    // enable/disable decide whether Paddock returns at the NEXT login, which is
    // a different question from whether it is running now. `uninstall` is the
    // only command that gets to answer both.
    const { run, calls } = recorder();
    const backend = createSystemdBackend(run, home);
    backend.start();
    backend.stop();
    backend.restart();

    expect(calls).toEqual([
      ["systemctl", "--user", "start", SYSTEMD_UNIT],
      ["systemctl", "--user", "stop", SYSTEMD_UNIT],
      // The reload is what makes an EDITED unit take effect on the way up.
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "restart", SYSTEMD_UNIT],
    ]);
    expect(calls.flat()).not.toContain("enable");
    expect(calls.flat()).not.toContain("disable");
  });

  it("systemd surfaces the manager's own words rather than claiming success", () => {
    const { run } = recorder({ status: 5, stderr: "Failed to start paddock.service: Unit not found." });
    expect(() => createSystemdBackend(run, home).start()).toThrow(/Unit not found/);
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
    createSystemdBackend(run, home).install(spec());

    const active = recorder({ stdout: "active" });
    const ctx = { ...contextFor("linux", home, active.run), checkReady: ready };
    const out = await capture(() => runService("start", OPTS, ctx));

    expect(out).toContain("already running");
    expect(active.calls.flat()).not.toContain("start");
  });

  it("stop leaves the unit installed, and says how to get it back", async () => {
    const { run } = recorder();
    createSystemdBackend(run, home).install(spec());

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
    createSystemdBackend(run, home).install(spec());

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
    createSystemdBackend(run, home).install(buildSpec({ ...BASE, dataDir: path.join(home, ".paddock"), port: "7299" }));
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

  // `rejects` rather than `toThrow`: `runService` became async in #873 (start
  // and restart await a readiness poll), so a refusal is now a rejected promise
  // and a synchronous `toThrow` would pass vacuously.
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

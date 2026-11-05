/**
 * The CLI contract's §1/§3 "should"s, and the one "must" that came with them:
 * `service install --dry-run`, the checkout refusal and `--from-checkout`, the
 * refusal of a port something else holds, `--json` on the service actions that
 * change something, `serve --quiet`, and the flags that belong to one command.
 *
 * Like cli-service.test.ts, every subprocess call goes through an injected
 * Runner: what these prove is the flow and the output, not that a real systemd
 * or launchd agrees (scripts/service-real.mjs does that on CI).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCommand, UsageError, type CliOptions } from "../../src/cli/args.js";
import { CliError } from "../../src/cli/args.js";
import { EXIT } from "../../src/cli/exit-codes.js";
import { runService, type ServiceContext } from "../../src/cli/service/index.js";
import { createLaunchd, plistPath } from "../../src/cli/service/launchd.js";
import { createSystemd, unitPath } from "../../src/cli/service/systemd.js";
import { buildSpec, PADDOCK_SERVICE } from "../../src/cli/service/spec.js";
import type { Runner, RunResult } from "../../src/cli/service/manager.js";

const OPTS: CliOptions = { open: false, verbose: false, help: false, version: false };
const GLOBAL = "/usr/local/lib/node_modules/@edspencer/paddock/packages/server";
const CLI = `${GLOBAL}/dist/cli/paddock.js`;

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-shoulds-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** A runner that records, answers "active" to is-active when `active`, and says launchd has nothing loaded. */
function recorder(o: { active?: boolean; fail?: (cmd: string, args: string[]) => boolean } = {}) {
  const calls: string[][] = [];
  const run: Runner = (cmd, args): RunResult => {
    calls.push([cmd, ...args]);
    if (o.fail?.(cmd, args) === true) return { status: 1, stdout: "", stderr: "refused" };
    if (cmd === "systemctl" && args.includes("is-active"))
      return { status: o.active ? 0 : 3, stdout: o.active ? "active\n" : "inactive\n", stderr: "" };
    if (cmd === "launchctl" && args[0] === "print") return { status: 113, stdout: "", stderr: "Could not find service" };
    return { status: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

function ctxFor(platform: "linux" | "darwin", run: Runner, over: Partial<ServiceContext> = {}): ServiceContext {
  return {
    platform,
    nodePath: "/opt/node/bin/node",
    scriptPath: CLI,
    packageRoot: GLOBAL,
    homeDir: home,
    pathEnv: "/usr/bin:/bin",
    run,
    checkReady: async () => "ready",
    probeHealth: async () => ({ ok: true, version: "0.82.1" }),
    portOwner: async () => "free",
    guardBusy: async () => null,
    ...over,
  };
}

/** Everything written to stdout and to stderr, through console.log and console.error, separately. */
async function streams(body: () => Promise<unknown>): Promise<{ out: string; err: string; value: unknown; thrown?: unknown }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void err.push(a.map(String).join(" "));
  let value: unknown;
  let thrown: unknown;
  try {
    value = await body();
  } catch (e) {
    thrown = e;
  } finally {
    console.log = log;
    console.error = error;
  }
  return { out: out.join("\n"), err: err.join("\n"), value, ...(thrown !== undefined ? { thrown } : {}) };
}

const installed = (port = "7233") =>
  createSystemd(PADDOCK_SERVICE, { run: recorder().run, homeDir: home }).install(
    buildSpec({ nodePath: "/opt/node/bin/node", scriptPath: CLI, dataDir: path.join(home, ".paddock"), port }),
  );

describe("flags belong to their commands (SPEC §1)", () => {
  it.each([
    [["service", "install", "--dry-run"]],
    [["service", "install", "--from-checkout"]],
    [["service", "install", "--dry-run", "--json"]],
    [["serve", "--quiet"]],
    [["serve", "-q"]],
    [["-q"]],
    ...["install", "uninstall", "start", "stop", "restart", "status"].map((a) => [["service", a, "--json"]]),
    [["busy", "--json"]],
    [["update", "--json"]],
    [["doctor", "--json"]],
    [["config", "show", "--json"]],
  ])("accepted: %j", (argv) => {
    expect(() => parseCommand(argv)).not.toThrow();
  });

  it.each([
    [["service", "start", "--dry-run"], "--dry-run"],
    [["update", "--dry-run"], "--dry-run"],
    [["service", "status", "--from-checkout"], "--from-checkout"],
    [["serve", "--from-checkout"], "--from-checkout"],
    [["busy", "--quiet"], "--quiet"],
    [["service", "install", "-q"], "--quiet"],
    [["service", "logs", "--json"], "--json"],
    [["serve", "--json"], "--json"],
    [["--json"], "--json"],
    [["config", "eject", "--json"], "--json"],
  ])("refused with exit 2: %j", (argv, flag) => {
    let err: unknown;
    try {
      parseCommand(argv);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UsageError);
    expect((err as UsageError).exitCode).toBe(EXIT.USAGE);
    expect((err as Error).message.startsWith(`${flag} applies to`)).toBe(true);
  });

  it("serve -q sets quiet", () => {
    expect(parseCommand(["serve", "-q"]).opts.quiet).toBe(true);
  });
});

describe("service install --dry-run", () => {
  it("prints the systemd unit on stdout, says where on stderr, and writes nothing at all", async () => {
    const { run, calls } = recorder();
    const r = await streams(() => runService("install", { ...OPTS, dryRun: true, port: "7300" }, ctxFor("linux", run)));
    expect(r.value).toBe(EXIT.OK);
    expect(r.out).toMatch(/^\[Unit\]$/m);
    expect(r.out).toContain("ExecStart=/opt/node/bin/node");
    expect(r.out).toContain("--port 7300");
    expect(r.err).toContain(unitPath(PADDOCK_SERVICE, home));
    expect(r.err).toContain("Nothing was written");
    // Not the unit, not the data dir, not the logs folder — nothing in the home at all.
    expect(fs.readdirSync(home)).toEqual([]);
    // And nothing asked of systemd.
    expect(calls).toEqual([]);
  });

  it("prints the plist on macOS", async () => {
    const r = await streams(() => runService("install", { ...OPTS, dryRun: true }, ctxFor("darwin", recorder().run)));
    expect(r.out).toMatch(/^<\?xml/);
    expect(r.out).toContain("<string>net.edspencer.paddock</string>");
    expect(fs.existsSync(plistPath(PADDOCK_SERVICE, home))).toBe(false);
  });

  it("with --refresh, prints the unit re-rendered from the installed one's settings", async () => {
    installed("9123");
    const unit = unitPath(PADDOCK_SERVICE, home);
    const before = fs.readFileSync(unit, "utf8");
    const mtime = fs.statSync(unit).mtimeMs;
    const r = await streams(() =>
      runService("install", { ...OPTS, dryRun: true, refresh: true }, ctxFor("linux", recorder().run)),
    );
    expect(r.out).toContain("--port 9123");
    expect(fs.readFileSync(unit, "utf8")).toBe(before);
    expect(fs.statSync(unit).mtimeMs).toBe(mtime);
  });

  it("--json prints one document with the unit in it", async () => {
    const r = await streams(() =>
      runService("install", { ...OPTS, dryRun: true, json: true }, ctxFor("linux", recorder().run)),
    );
    const doc = JSON.parse(r.out) as Record<string, unknown>;
    expect(doc).toMatchObject({ ok: true, action: "install", dryRun: true, unit: unitPath(PADDOCK_SERVICE, home) });
    expect(String(doc.contents)).toMatch(/^\[Unit\]$/m);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("--refresh --json with nothing installed: 4, and still one document", async () => {
    const r = await streams(() =>
      runService("install", { ...OPTS, dryRun: true, refresh: true, json: true }, ctxFor("linux", recorder().run)),
    );
    expect(r.value).toBe(EXIT.NOT_INSTALLED);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: "not installed" });
  });
});

describe("service install refuses a checkout (SPEC §1, §6)", () => {
  const CHECKOUT = "/home/ed/src/paddock/packages/server";

  it("refuses with exit 1, names the way out, and writes nothing", async () => {
    const { run, calls } = recorder();
    const r = await streams(() => runService("install", OPTS, ctxFor("linux", run, { packageRoot: CHECKOUT })));
    expect(r.thrown).toBeInstanceOf(CliError);
    expect((r.thrown as CliError).exitCode).toBe(EXIT.FAILED);
    expect((r.thrown as Error).message).toContain(CHECKOUT);
    expect((r.thrown as Error).message).toContain("--from-checkout");
    expect((r.thrown as Error).message).toContain("npm i -g @edspencer/paddock");
    expect(calls).toEqual([]);
    expect(fs.existsSync(unitPath(PADDOCK_SERVICE, home))).toBe(false);
  });

  it("--dry-run is refused the same way: it previews what install would do", async () => {
    const r = await streams(() =>
      runService("install", { ...OPTS, dryRun: true }, ctxFor("linux", recorder().run, { packageRoot: CHECKOUT })),
    );
    expect(r.thrown).toBeInstanceOf(CliError);
  });

  it("--from-checkout installs anyway", async () => {
    const r = await streams(() =>
      runService("install", { ...OPTS, fromCheckout: true }, ctxFor("linux", recorder().run, { packageRoot: CHECKOUT })),
    );
    expect(r.value).toBe(EXIT.OK);
    expect(fs.existsSync(unitPath(PADDOCK_SERVICE, home))).toBe(true);
  });

  it("the control: a global install is not a checkout", async () => {
    const r = await streams(() => runService("install", OPTS, ctxFor("linux", recorder().run)));
    expect(r.value).toBe(EXIT.OK);
  });
});

describe("service install refuses a port something else holds (SPEC §1)", () => {
  it("refuses when the port is held by something that isn't Paddock", async () => {
    const { run, calls } = recorder();
    const r = await streams(() =>
      runService("install", { ...OPTS, port: "7300" }, ctxFor("linux", run, { portOwner: async () => "other" })),
    );
    expect((r.thrown as CliError).exitCode).toBe(EXIT.FAILED);
    expect((r.thrown as Error).message).toContain("port 7300 is held by something that isn't Paddock");
    expect(calls.filter((c) => c.includes("enable"))).toEqual([]);
    expect(fs.existsSync(unitPath(PADDOCK_SERVICE, home))).toBe(false);
  });

  it("goes ahead over a Paddock (a reinstall), and over its own running service even when that can't say it's Paddock", async () => {
    expect(
      (await streams(() => runService("install", OPTS, ctxFor("linux", recorder().run, { portOwner: async () => "paddock" })))).value,
    ).toBe(EXIT.OK);
    installed("7233");
    const r = await streams(() =>
      runService("install", OPTS, ctxFor("linux", recorder({ active: true }).run, { portOwner: async () => "other" })),
    );
    expect(r.thrown).toBeUndefined();
    expect(r.value).toBe(EXIT.OK);
  });
});

describe("a reinstall keeps the unit's settings (SPEC §1)", () => {
  it("service install with no flags over a --port 9123 unit keeps 9123; a flag still wins", async () => {
    installed("9123");
    const unit = unitPath(PADDOCK_SERVICE, home);
    const r = await streams(() => runService("install", OPTS, ctxFor("linux", recorder().run)));
    expect(r.value).toBe(EXIT.OK);
    expect(r.out).toContain("Keeping: paddock serve --port 9123");
    expect(fs.readFileSync(unit, "utf8")).toContain("--port 9123");

    await streams(() => runService("install", { ...OPTS, port: "9200" }, ctxFor("linux", recorder().run)));
    expect(fs.readFileSync(unit, "utf8")).toContain("--port 9200");
    expect(fs.readFileSync(unit, "utf8")).not.toContain("9123");
  });

  it("the control: a first install takes the defaults", async () => {
    const r = await streams(() => runService("install", OPTS, ctxFor("linux", recorder().run)));
    expect(r.out).not.toContain("Keeping:");
    expect(fs.readFileSync(unitPath(PADDOCK_SERVICE, home), "utf8")).not.toContain("--port");
  });
});

describe("--json on the service actions (SPEC §1, §3)", () => {
  it("install: one document on stdout — ok, action and the status after — and every word of prose on stderr", async () => {
    const r = await streams(() => runService("install", { ...OPTS, json: true }, ctxFor("linux", recorder({ active: true }).run)));
    expect(r.value).toBe(EXIT.OK);
    const doc = JSON.parse(r.out) as Record<string, unknown>;
    expect(doc).toMatchObject({ ok: true, action: "install", installed: true, running: true, answering: true, runningVersion: "0.82.1" });
    expect(doc).not.toHaveProperty("error");
    expect(r.err).toContain("Paddock is installed as a systemd --user service");
  });

  it("uninstall: installed is false afterwards", async () => {
    installed();
    const r = await streams(() => runService("uninstall", { ...OPTS, json: true }, ctxFor("linux", recorder().run)));
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, action: "uninstall", installed: false });
    expect(r.err).toContain("stopped and removed");
  });

  it("start with nothing installed: 4, and the document says why", async () => {
    const r = await streams(() => runService("start", { ...OPTS, json: true }, ctxFor("linux", recorder().run)));
    expect(r.value).toBe(EXIT.NOT_INSTALLED);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, action: "start", error: "not installed", installed: false });
  });

  it("stop refused as busy: 75, and error is busy", async () => {
    installed();
    const r = await streams(() =>
      runService(
        "stop",
        { ...OPTS, json: true },
        ctxFor("linux", recorder({ active: true }).run, { guardBusy: async () => EXIT.BUSY }),
      ),
    );
    expect(r.value).toBe(EXIT.BUSY);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, action: "stop", error: "busy", running: true });
  });

  it("restart that fails: the document is printed, then the failure is re-thrown for paddock: and its code", async () => {
    installed();
    const r = await streams(() =>
      runService(
        "restart",
        { ...OPTS, json: true },
        ctxFor("linux", recorder({ active: true, fail: (c, a) => c === "systemctl" && a.includes("restart") }).run),
      ),
    );
    expect(r.thrown).toBeInstanceOf(Error);
    const doc = JSON.parse(r.out) as Record<string, unknown>;
    expect(doc).toMatchObject({ ok: false, action: "restart" });
    expect(String(doc.error)).toContain("systemctl --user restart paddock.service failed");
  });

  it("a refused install (the checkout) still prints its document", async () => {
    const r = await streams(() =>
      runService("install", { ...OPTS, json: true }, ctxFor("linux", recorder().run, { packageRoot: "/src/paddock/packages/server" })),
    );
    expect((r.thrown as CliError).exitCode).toBe(EXIT.FAILED);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, action: "install", installed: false });
  });
});

describe("a first install the service manager refuses leaves no unit behind (cli-contract d5ddc0e)", () => {
  it("systemd", () => {
    const { run, calls } = recorder({ fail: (c, a) => c === "systemctl" && a.includes("enable") });
    const backend = createSystemd(PADDOCK_SERVICE, { run, homeDir: home });
    expect(() => backend.install(buildSpec({ nodePath: "/n", scriptPath: CLI, dataDir: path.join(home, ".paddock") }))).toThrow();
    expect(fs.existsSync(unitPath(PADDOCK_SERVICE, home))).toBe(false);
    expect(calls.some((c) => c.includes("disable"))).toBe(true);
  });

  it("systemd: a REinstall that fails keeps the unit that's there", () => {
    installed();
    const { run } = recorder({ fail: (c, a) => c === "systemctl" && a.includes("enable") });
    const backend = createSystemd(PADDOCK_SERVICE, { run, homeDir: home });
    expect(() => backend.install(buildSpec({ nodePath: "/n", scriptPath: CLI, dataDir: path.join(home, ".paddock") }))).toThrow();
    expect(fs.existsSync(unitPath(PADDOCK_SERVICE, home))).toBe(true);
  });

  it("launchd", () => {
    const { run } = recorder({ fail: (c, a) => c === "launchctl" && a[0] === "bootstrap" });
    const backend = createLaunchd(PADDOCK_SERVICE, { run, homeDir: home, sleep: () => undefined });
    expect(() => backend.install(buildSpec({ nodePath: "/n", scriptPath: CLI, dataDir: path.join(home, ".paddock") }))).toThrow();
    expect(fs.existsSync(plistPath(PADDOCK_SERVICE, home))).toBe(false);
  });
});

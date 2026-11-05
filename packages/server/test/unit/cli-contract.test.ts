/**
 * The CLI contract, as Paddock implements it (edspencer/cli-contract SPEC 0.1).
 *
 * Everything here is a clause of the spec rather than a Paddock feature, which
 * is why it is one file: when the spec moves to 0.2 and `reference/` gets its
 * own copies (wave C4), this is the list to re-read.
 *
 * ## What these can and cannot prove
 *
 * The exit codes, the JSON shape, the rendered units and the log reader are all
 * covered here, on any OS. What is NOT covered is whether launchd or systemd
 * accepts what we render, or whether `StandardOutput=append:` really receives
 * the server's stdout — this box is a container with tini as PID 1, so there is
 * no user systemd and no launchd to ask. That half is proven by
 * `scripts/service-real.mjs` on GitHub's ubuntu and macOS runners, which is
 * also the only place the kill-and-come-back behaviour can be exercised.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseArgs,
  parseCommand,
  CliError,
  UsageError,
  SERVICE_ACTIONS,
  USAGE,
  USAGE_SYNOPSIS,
  SERVICE_USAGE,
  BUSY_USAGE,
} from "../../src/cli/args.js";
import { EXIT } from "../../src/cli/exit-codes.js";
import {
  checkBusy,
  busyExitCode,
  busyJson,
  busyMessage,
  describeCounts,
  guardBusy,
  type BusyResult,
} from "../../src/cli/busy.js";
import { PADDOCK_NOUNS, paddockBusyHint } from "../../src/cli/busy-command.js";
import { createOutput, type Output } from "../../src/cli/output.js";
import {
  readLiveRuntimeFile,
  readRuntimeFile,
  removeRuntimeFile,
  runtimeFilePath,
  writeRuntimeFile,
} from "../../src/runtime-file.js";
import { runtimeUrl } from "../../src/start.js";
import { collectBusy } from "../../src/busy.js";
import { BackgroundRegistry } from "../../src/background-live.js";
import { buildSpec, serviceLogPath, SYSTEMD_UNIT } from "../../src/cli/service/spec.js";
import {
  renderUnit,
  execWord,
  execWords,
  parseUnitLogPath,
  systemctlFailure,
} from "../../src/cli/service/systemd.js";
import { renderPlist, parsePlistLogPath, createLaunchdBackend } from "../../src/cli/service/launchd.js";
import { createSystemdBackend } from "../../src/cli/service/systemd.js";
import { servicePath, which, missingPaths } from "../../src/cli/service/path-env.js";
import { tailFile, followFile, sizeOf, DEFAULT_LOG_LINES } from "../../src/cli/service/logs.js";
import { fetchHealth } from "../../src/cli/service/ready.js";
import { runService, installedVersionOf, type StatusReport } from "../../src/cli/service/index.js";
import type { RunResult, Runner } from "../../src/cli/service/backend.js";
import { rotateServiceLog, serviceLogFile } from "../../src/service-log.js";
import { PADDOCK_VERSION } from "../../src/version.js";

const BASE = {
  nodePath: "/opt/node/bin/node",
  scriptPath: "/usr/local/lib/node_modules/@edspencer/paddock/packages/server/dist/cli/paddock.js",
  dataDir: "/home/ed/.paddock",
  pathEnv: "/opt/node/bin:/usr/bin:/bin",
  pathExists: () => true,
  systemDirs: ["/usr/bin", "/bin"] as readonly string[],
};

const OPTS = { open: false, verbose: false, help: false, version: false };

function recorder(result: Partial<RunResult> = {}): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    return { status: 0, stdout: "", stderr: "", ...result };
  };
  return { run, calls };
}

/**
 * A runner that answers each command differently.
 *
 * The flows need `systemctl is-active` and `loginctl show-user` to say
 * different things in the same test, which the single-result recorder above
 * cannot express — and conflating them is how the linger assertions ended up
 * passing for the wrong reason.
 */
function answering(answers: Record<string, Partial<RunResult>>): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = Object.keys(answers).find((k) => [cmd, ...args].join(" ").includes(k));
    return { status: 0, stdout: "", stderr: "", ...(key !== undefined ? answers[key] : {}) };
  };
  return { run, calls };
}

async function capture(body: () => unknown): Promise<{ out: string; code: unknown }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    const code = await body();
    return { out: lines.join("\n"), code };
  } finally {
    console.log = original;
  }
}

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

// ---------------------------------------------------------------------------
// §1 Commands
// ---------------------------------------------------------------------------

describe("SPEC §1: commands", () => {
  it("`serve` is the name, and `start` is a permanent alias", () => {
    expect(parseCommand(["serve"]).verb).toBe("serve");
    expect(parseCommand(["start"]).verb).toBe("serve");
    expect(parseCommand([]).verb).toBe("serve");
  });

  it("the main help lists all seven service actions", () => {
    // The gap the roadmap recorded: it listed three of them, so `start`, `stop`,
    // `restart` and `logs` were reachable and undiscoverable.
    for (const action of SERVICE_ACTIONS) {
      expect(USAGE).toContain(`paddock service ${action}`);
    }
  });

  it("the help is honest about the exit codes it now uses", () => {
    for (const line of ["2  usage", "3  not running", "4  not installed"]) {
      expect(USAGE.replace(/\s+/g, " ")).toContain(line.replace(/\s+/g, " "));
    }
    expect(SERVICE_USAGE).toContain("Exit codes");
  });

  it("`logs` takes -f and -n, with 50 lines the default", () => {
    expect(parseArgs(["-f"]).follow).toBe(true);
    expect(parseArgs(["--follow"]).follow).toBe(true);
    expect(parseArgs(["-n", "200"]).lines).toBe(200);
    expect(parseArgs(["--lines", "200"]).lines).toBe(200);
    expect(parseArgs([]).lines).toBeUndefined();
    expect(DEFAULT_LOG_LINES).toBe(50);
  });

  it("rejects a -n that is not a positive number", () => {
    expect(() => parseArgs(["-n", "0"])).toThrow(/positive number/);
    expect(() => parseArgs(["-n", "lots"])).toThrow(/positive number/);
    expect(() => parseArgs(["-n"])).toThrow(/needs a value/);
  });
});

// ---------------------------------------------------------------------------
// §2 Exit codes
// ---------------------------------------------------------------------------

describe("SPEC §2: exit codes", () => {
  it("has the table, with the numbers the spec fixes", () => {
    expect(EXIT).toMatchObject({
      ok: 0,
      failure: 1,
      usage: 2,
      notRunning: 3,
      notInstalled: 4,
      cannotSelfUpdate: 5,
      rolledBack: 6,
      needsHuman: 7,
      busy: 75,
    });
  });

  it("a usage error carries 2, and a plain failure 1", () => {
    // The behaviour change scripts can see: a typo used to exit 1, which is
    // also what a real failure exits, so the two were indistinguishable.
    expect(new UsageError("x").exitCode).toBe(EXIT.usage);
    expect(new CliError("x").exitCode).toBe(EXIT.failure);
    expect(new UsageError("x")).toBeInstanceOf(CliError);
  });

  it.each([
    [["--definitely-not-a-flag"]],
    [["service", "instal"]],
    [["service"]],
    [["--port", "nonsense"]],
    [["-n", "0"]],
    [["4100"]],
  ])("parsing %j is a usage error", (argv) => {
    expect(() => parseCommand(argv)).toThrow(UsageError);
    try {
      parseCommand(argv);
    } catch (err) {
      expect((err as CliError).exitCode).toBe(EXIT.usage);
    }
  });

  it("has a short synopsis to print after a usage error", () => {
    // SPEC §2 wants the usage after the message. USAGE itself is a thousand
    // words of guide, which would bury the one line that says what was wrong.
    expect(USAGE_SYNOPSIS.split("\n").length).toBeLessThan(10);
    expect(USAGE_SYNOPSIS).toContain("paddock service <action>");
    expect(USAGE_SYNOPSIS).toContain("--help");
  });
});

// ---------------------------------------------------------------------------
// §1/§2 `service status`, and the exit codes it is for
// ---------------------------------------------------------------------------

describe("SPEC §1: service status", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-contract-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const spec = (extra: Record<string, unknown> = {}) =>
    buildSpec({ ...BASE, dataDir: path.join(home, ".paddock"), ...extra });

  /** Install a unit, then run `status` with the given runner answers. */
  async function statusWith(
    answers: Record<string, Partial<RunResult>>,
    opts = OPTS,
    platform: "linux" | "darwin" = "linux",
  ): Promise<{ out: string; code: unknown }> {
    const { run } = answering(answers);
    return capture(() => runService("status", opts, contextFor(platform, home, run)));
  }

  it("exits 4 when nothing is installed, and says so", async () => {
    const { out, code } = await capture(() =>
      runService("status", OPTS, contextFor("linux", home, recorder().run)),
    );
    expect(code).toBe(EXIT.notInstalled);
    expect(out).toContain("not installed as a service");
  });

  it("exits 3 when installed but not running", async () => {
    createSystemdBackend(recorder().run, home).install(spec());
    const { out, code } = await statusWith({ "is-active": { stdout: "inactive" } });
    expect(code).toBe(EXIT.notRunning);
    expect(out).toContain("not running right now");
  });

  it("exits 3 when running but NOT answering", async () => {
    // A supervisor reports a crash-looping job as running for most of the window
    // between restarts, so "running" alone is not a service anyone can use.
    createSystemdBackend(recorder().run, home).install(spec());
    const { out, code } = await capture(() =>
      runService("status", OPTS, {
        ...contextFor("linux", home, answering({ "is-active": { stdout: "active" } }).run),
        probeHealth: async () => undefined,
      }),
    );
    expect(code).toBe(EXIT.notRunning);
    expect(out).toContain("is not answering");
  });

  it("says so when the supervisor has not got it but something IS answering", async () => {
    // Found in QA: the common shape is a `paddock serve` in a terminal on the
    // same port. "Not running" alone reads as "nothing there", and then
    // `service start` fails on a port clash that status could have explained.
    createSystemdBackend(recorder().run, home).install(spec());
    const { out, code } = await capture(() =>
      runService("status", OPTS, {
        ...contextFor("linux", home, answering({ "is-active": { stdout: "inactive" } }).run),
        probeHealth: async () => ({ ok: true, version: PADDOCK_VERSION }),
      }),
    );
    expect(code).toBe(EXIT.notRunning);
    expect(out).toContain("something IS answering");
    expect(out).toContain("paddock serve");
  });

  it("exits 0 when running and answering", async () => {
    createSystemdBackend(recorder().run, home).install(spec());
    const { out, code } = await capture(() =>
      runService("status", OPTS, {
        ...contextFor("linux", home, answering({ "is-active": { stdout: "active" } }).run),
        probeHealth: async () => ({ ok: true, version: PADDOCK_VERSION }),
      }),
    );
    expect(code).toBe(EXIT.ok);
    expect(out).toContain("and answering");
  });

  it("--json prints exactly one document, and nothing else, on stdout", async () => {
    createSystemdBackend(recorder().run, home).install(spec({ port: "7299" }));
    const { out, code } = await capture(() =>
      runService(
        "status",
        { ...OPTS, json: true },
        {
          ...contextFor("linux", home, answering({ "is-active": { stdout: "active" }, "MainPID": { stdout: "4242" } }).run),
          probeHealth: async () => ({ ok: true, version: "9.9.9" }),
        },
      ),
    );
    // The whole of stdout has to parse: a stray progress line would make this
    // throw, which is the discipline SPEC §1 asks for.
    const report = JSON.parse(out) as StatusReport;
    expect(code).toBe(EXIT.ok);
    expect(report).toMatchObject({
      installed: true,
      running: true,
      answering: true,
      runningVersion: "9.9.9",
      port: 7299,
      host: "127.0.0.1",
      url: "http://127.0.0.1:7299",
      manager: "systemd",
      log: path.join(home, ".paddock", "logs", "service.log"),
      dataDir: path.join(home, ".paddock"),
      node: BASE.nodePath,
      cli: BASE.scriptPath,
      args: ["serve", "--port", "7299"],
    });
    expect(report.unit).toContain("paddock.service");
  });

  it("--json on a machine with no unit still answers, with installed: false", async () => {
    const { out, code } = await capture(() =>
      runService("status", { ...OPTS, json: true }, contextFor("linux", home, recorder().run)),
    );
    const report = JSON.parse(out) as StatusReport;
    expect(code).toBe(EXIT.notInstalled);
    expect(report.installed).toBe(false);
    expect(report.runningVersion).toBeNull();
    expect(report.warnings).toEqual([]);
  });

  it("reports the installed version by walking up from the unit's cli.js", () => {
    const pkg = path.join(home, "lib", "node_modules", "@edspencer", "paddock", "packages", "server");
    fs.mkdirSync(path.join(pkg, "dist", "cli"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version: "1.2.3" }));
    expect(installedVersionOf(path.join(pkg, "dist", "cli", "paddock.js"))).toBe("1.2.3");
    expect(installedVersionOf(undefined)).toBeUndefined();
  });

  it("warns when the running version is not the installed one", async () => {
    const pkg = path.dirname(path.dirname(path.dirname(BASE.scriptPath)));
    // The unit's cli.js does not exist here, so `installedVersionOf` finds
    // nothing and the comparison cannot fire — install a unit pointing at a
    // real staged package instead.
    const staged = path.join(home, "pkg", "packages", "server");
    fs.mkdirSync(path.join(staged, "dist", "cli"), { recursive: true });
    fs.writeFileSync(path.join(staged, "package.json"), JSON.stringify({ version: "0.80.0" }));
    const cli = path.join(staged, "dist", "cli", "paddock.js");
    fs.writeFileSync(cli, "");
    createSystemdBackend(recorder().run, home).install(
      buildSpec({ ...BASE, scriptPath: cli, dataDir: path.join(home, ".paddock") }),
    );
    void pkg;

    const { out } = await capture(() =>
      runService("status", OPTS, {
        ...contextFor("linux", home, answering({ "is-active": { stdout: "active" } }).run),
        probeHealth: async () => ({ ok: true, version: "0.79.1" }),
      }),
    );
    expect(out).toContain("running 0.79.1");
    expect(out).toMatch(/It is running 0\.79\.1, but 0\.80\.0 is installed/);
    expect(out).toContain("paddock service restart");
  });

  it("warns when the Node the unit names has gone (SPEC §7)", async () => {
    // nvm, fnm and volta all do this the moment a version is uninstalled, and
    // the symptom is Paddock absent with an EMPTY log — it never ran.
    createSystemdBackend(recorder().run, home).install(spec());
    const { out } = await statusWith({ "is-active": { stdout: "inactive" } });
    expect(out).toContain("/opt/node/bin/node, which is not there any more");
    expect(out).toContain("paddock service install");
  });

  it("warns about linger only when loginctl says it is off", async () => {
    createSystemdBackend(recorder().run, home).install(spec());

    const off = await statusWith({
      "is-active": { stdout: "active" },
      "show-user": { stdout: "Linger=no\n" },
    });
    expect(off.out).toContain("Lingering is off");
    expect(off.out).toContain("sudo loginctl enable-linger");

    const on = await statusWith({
      "is-active": { stdout: "active" },
      "show-user": { stdout: "Linger=yes\n" },
    });
    expect(on.out).not.toContain("Lingering is off");

    // No loginctl at all (a container): unknown, so nothing is claimed. Telling
    // someone to run a command their machine does not have is worse than silence.
    const unknown = await statusWith({
      "is-active": { stdout: "active" },
      "show-user": { status: 127, stderr: "loginctl: command not found" },
    });
    expect(unknown.out).not.toContain("Lingering is off");
  });

  it("reports linger as null on darwin, where there is no such thing", async () => {
    createLaunchdBackend(recorder().run, home).install(spec());
    const { out } = await capture(() =>
      runService("status", { ...OPTS, json: true }, {
        ...contextFor("darwin", home, recorder({ stdout: "\tstate = running\n" }).run),
        probeHealth: async () => ({ ok: true }),
      }),
    );
    const report = JSON.parse(out) as StatusReport;
    expect(report.linger).toBeNull();
    expect(report.manager).toBe("launchd");
  });
});

// ---------------------------------------------------------------------------
// §2 the other service commands' codes
// ---------------------------------------------------------------------------

describe("SPEC §2: not-installed is 4 everywhere it can be asked", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-contract-4-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it.each(["status", "start", "stop", "restart", "logs"] as const)(
    "`service %s` exits 4 with no unit",
    async (action) => {
      const { run, calls } = recorder();
      const { code } = await capture(() =>
        runService(action, OPTS, { ...contextFor("linux", home, run), checkReady: async () => "ready" as const }),
      );
      expect(code).toBe(EXIT.notInstalled);
      // And it does not shell out to a supervisor to find that out.
      expect(calls.filter((c) => c[0] === "systemctl" && c.includes("start"))).toEqual([]);
    },
  );

  it("an install that never answers exits 1, not 0", async () => {
    // The caller — usually an Ansible task — has no other way to find out.
    const { code } = await capture(() =>
      runService("install", OPTS, {
        ...contextFor("linux", home, recorder().run),
        checkReady: async () => "timeout" as const,
      }),
    );
    expect(code).toBe(EXIT.failure);
  });

  it("an install that answers exits 0", async () => {
    const { code } = await capture(() =>
      runService("install", OPTS, {
        ...contextFor("linux", home, recorder().run),
        checkReady: async () => "ready" as const,
      }),
    );
    expect(code).toBe(EXIT.ok);
  });

  it("uninstall is idempotent and exits 0 either way", async () => {
    const first = await capture(() =>
      runService("uninstall", OPTS, contextFor("linux", home, recorder().run)),
    );
    expect(first.code).toBe(EXIT.ok);
    expect(first.out).toContain("Nothing to do");
  });
});

// ---------------------------------------------------------------------------
// §7 Units
// ---------------------------------------------------------------------------

describe("SPEC §7: what the unit runs", () => {
  it("quotes every ExecStart word, escaping % and $", () => {
    expect(execWord("/usr/bin/node")).toBe("/usr/bin/node");
    expect(execWord("/Users/Ed Spencer/.paddock")).toBe('"/Users/Ed Spencer/.paddock"');
    expect(execWord("100%")).toBe("100%%");
    expect(execWord("$HOME")).toBe("$$HOME");
    expect(execWord("")).toBe('""');
  });

  it("round-trips a path with a space, which used to split into two arguments", () => {
    const spec = buildSpec({
      ...BASE,
      scriptPath: "/Users/Ed Spencer/lib/node_modules/@edspencer/paddock/dist/cli/paddock.js",
      dataDirArg: "/srv/my data",
    });
    const words = execWords(/^ExecStart=(.*)$/m.exec(renderUnit(spec))![1]);
    expect(words[1]).toBe("/Users/Ed Spencer/lib/node_modules/@edspencer/paddock/dist/cli/paddock.js");
    expect(words.slice(2)).toEqual(["serve", "--data-dir", "/srv/my data"]);
  });

  it("reads an UNQUOTED ExecStart back too — that is what is on disk today", () => {
    // Every unit installed before this change is a bare whitespace-separated
    // line, and its owner is exactly the person whose `status` must keep working.
    expect(execWords("/opt/node/bin/node /pkg/cli.js start --port 7299")).toEqual([
      "/opt/node/bin/node",
      "/pkg/cli.js",
      "start",
      "--port",
      "7299",
    ]);
  });

  it("names one log file, from both streams, on both platforms", () => {
    const spec = buildSpec(BASE);
    const unit = renderUnit(spec);
    expect(unit).toContain(`StandardOutput=append:${spec.logPath}`);
    expect(unit).toContain(`StandardError=append:${spec.logPath}`);
    // Not the journal: `journalctl --user` is empty on a distro with a volatile
    // journal, which is exactly when someone goes looking.
    expect(unit).not.toContain("journal");
    expect(parseUnitLogPath(unit)).toBe(spec.logPath);

    const plist = renderPlist(spec);
    expect(parsePlistLogPath(plist)).toBe(spec.logPath);
    expect(plist.match(new RegExp(spec.logPath.replace(/[/.]/g, "\\$&"), "g"))).toHaveLength(2);
  });

  it("strips the installing shell's per-session PATH entries", () => {
    // fnm's multishell directory is deleted when that terminal exits, so a unit
    // naming it works until the tab closes — then fails at some later login.
    const inherited = [
      "/Users/ed/.local/state/fnm_multishells/40331_1730000000/bin",
      "/Users/ed/.npm/_npx/abc/node_modules/.bin",
      "/work/node_modules/.bin",
      "/work/node_modules/.bin/node-gyp-bin",
      "relative/bin",
      "",
      "/usr/local/bin",
    ].join(":");
    const out = servicePath("/opt/node/bin", inherited, {
      exists: () => true,
      systemDirs: ["/usr/bin", "/bin"],
    });
    expect(out.split(":")).toEqual(["/opt/node/bin", "/usr/local/bin", "/usr/bin", "/bin"]);
  });

  it("drops PATH entries that do not exist, Node's own bin leading", () => {
    const out = servicePath("/opt/node/bin", "/gone:/usr/local/bin", {
      exists: (p) => p !== "/gone",
      systemDirs: ["/usr/bin"],
    });
    expect(out).toBe("/opt/node/bin:/usr/local/bin:/usr/bin");
  });

  it("explains a MISSING systemctl rather than printing `exit null`", () => {
    // Found in QA on this box, which has no systemd: `spawnSync` reports an
    // absent binary as status null with no output, so the message was
    // `systemctl --user enable --now failed (exit null).` followed by a blank
    // line — and that is the likeliest failure on a machine where this was
    // never going to work.
    const missing = systemctlFailure(["--user", "enable"], { status: null, stdout: "", stderr: "" });
    expect(missing).toContain("systemctl is not available");
    expect(missing).toContain("paddock serve");
    expect(missing).not.toContain("exit null");

    expect(
      systemctlFailure(["--user", "start"], {
        status: 1,
        stdout: "",
        stderr: "Failed to connect to bus: No such file or directory",
      }),
    ).toContain("XDG_RUNTIME_DIR");

    // And a real failure still arrives in the manager's own words.
    expect(
      systemctlFailure(["--user", "start"], { status: 5, stdout: "", stderr: "Unit not found." }),
    ).toContain("Unit not found.");
  });

  it("finds a command on the job's PATH, or says it is not there", () => {
    expect(which("git", "/a:/b", (p) => p === "/b/git")).toBe("/b/git");
    expect(which("git", "/a:/b", () => false)).toBeUndefined();
  });

  it("reports only the paths that are gone", () => {
    expect(missingPaths(["/here", "/gone", undefined], (p) => p === "/here")).toEqual(["/gone"]);
  });
});

// ---------------------------------------------------------------------------
// §1/§7 `service logs`
// ---------------------------------------------------------------------------

describe("SPEC §1: service logs", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-logs-"));
    file = path.join(dir, "service.log");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("prints the last n lines", () => {
    fs.writeFileSync(file, Array.from({ length: 200 }, (_, i) => `line ${String(i)}`).join("\n") + "\n");
    expect(tailFile(file, 3).split("\n")).toEqual(["line 197", "line 198", "line 199"]);
    expect(tailFile(file, 500).split("\n")).toHaveLength(200);
  });

  it("handles an empty file and a file with no trailing newline", () => {
    fs.writeFileSync(file, "");
    expect(tailFile(file, 10)).toBe("");
    fs.writeFileSync(file, "one\ntwo");
    expect(tailFile(file, 10).split("\n")).toEqual(["one", "two"]);
  });

  it("follows what gets appended, and survives the rotation it will meet", async () => {
    fs.writeFileSync(file, "first\n");
    const seen: string[] = [];
    let ticks = 0;
    const follow = followFile(file, {
      from: sizeOf(file),
      intervalMs: 1,
      write: (s) => seen.push(s),
      keepGoing: () => ticks++ < 40,
    });
    fs.appendFileSync(file, "second\n");
    await new Promise((r) => setTimeout(r, 30));
    // Copy-and-truncate, which is what service-log.ts does: the size goes DOWN
    // and a naive follower reads past the end for ever and goes silent.
    fs.truncateSync(file, 0);
    fs.appendFileSync(file, "third\n");
    await follow;
    expect(seen.join("")).toContain("second\n");
    expect(seen.join("")).toContain("third\n");
  });

  it("reads the file the INSTALLED unit names, not today's default", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-logs-home-"));
    try {
      const backend = createSystemdBackend(recorder().run, home);
      backend.install(buildSpec({ ...BASE, dataDir: path.join(home, ".paddock") }));
      // Rewrite the unit to the pre-contract log path, as an existing install has.
      const unit = path.join(home, ".config", "systemd", "user", "paddock.service");
      const old = path.join(home, ".paddock", "service", "paddock.log");
      fs.mkdirSync(path.dirname(old), { recursive: true });
      fs.writeFileSync(old, "ancient\n");
      fs.writeFileSync(
        unit,
        fs.readFileSync(unit, "utf8").replace(/append:\S+/g, `append:${old}`),
      );

      const { out, code } = await capture(() =>
        runService("logs", OPTS, contextFor("linux", home, recorder().run)),
      );
      expect(code).toBe(EXIT.ok);
      expect(out).toContain("ancient");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("a log file that does not exist yet is not an error", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-logs-none-"));
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
    try {
      createSystemdBackend(recorder().run, home).install(
        buildSpec({ ...BASE, dataDir: path.join(home, ".paddock") }),
      );
      const { code } = await capture(() =>
        runService("logs", OPTS, contextFor("linux", home, recorder().run)),
      );
      // A service installed thirty seconds ago has nothing to show yet, and
      // that is worth saying rather than failing over.
      expect(code).toBe(EXIT.ok);
      expect(errors.join("\n")).toContain("nothing has been written");
    } finally {
      console.error = originalError;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// §7 rotation
// ---------------------------------------------------------------------------

describe("SPEC §7: the tool rotates its own log", () => {
  let data: string;
  beforeEach(() => {
    data = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-rotate-"));
    fs.mkdirSync(path.join(data, "logs"));
  });
  afterEach(() => {
    fs.rmSync(data, { recursive: true, force: true });
  });

  it("does nothing when there is no log, or it is small", () => {
    expect(rotateServiceLog(data)).toBe(false);
    fs.writeFileSync(serviceLogFile(data), "small\n");
    expect(rotateServiceLog(data)).toBe(false);
  });

  it("copies and TRUNCATES, keeping the inode the supervisor holds open", () => {
    // The whole point. `rename()` would leave launchd's and systemd's append
    // descriptors writing to service.log.1 for ever, with a permanently empty
    // service.log beside it — the usual rotation is the one thing that cannot
    // work here, because we are not the writer.
    const file = serviceLogFile(data);
    fs.writeFileSync(file, "x".repeat(100));
    const before = fs.statSync(file).ino;

    expect(rotateServiceLog(data, { maxBytes: 10 })).toBe(true);

    expect(fs.statSync(file).ino).toBe(before);
    expect(fs.statSync(file).size).toBe(0);
    expect(fs.readFileSync(`${file}.1`, "utf8")).toBe("x".repeat(100));
  });

  it("keeps three generations and drops the oldest", () => {
    const file = serviceLogFile(data);
    for (const gen of ["a", "b", "c", "d"]) {
      fs.writeFileSync(file, gen.repeat(100));
      rotateServiceLog(data, { maxBytes: 10, keep: 3 });
    }
    expect(fs.readFileSync(`${file}.1`, "utf8")).toBe("d".repeat(100));
    expect(fs.readFileSync(`${file}.2`, "utf8")).toBe("c".repeat(100));
    expect(fs.readFileSync(`${file}.3`, "utf8")).toBe("b".repeat(100));
    expect(fs.existsSync(`${file}.4`)).toBe(false);
  });

  it("warns rather than throwing when it cannot rotate", () => {
    const file = serviceLogFile(data);
    fs.writeFileSync(file, "x".repeat(100));
    const warnings: string[] = [];
    // A DIRECTORY where the oldest generation goes: dropping it is the first
    // thing the shuffle does, and `rm` without `recursive` refuses a directory.
    // (chmod would be the obvious injection and is useless here — this suite
    // runs as root on the dev box, which ignores the mode.)
    fs.mkdirSync(`${file}.3`);
    expect(rotateServiceLog(data, { maxBytes: 10, warn: (m) => warnings.push(m) })).toBe(false);
    expect(warnings.join()).toContain("could not rotate");
    // And the log itself is untouched: a failed rotation must not lose anything.
    expect(fs.readFileSync(file, "utf8")).toBe("x".repeat(100));
  });

  it("agrees with the path the unit names", () => {
    expect(serviceLogFile("/home/ed/.paddock")).toBe(serviceLogPath("/home/ed/.paddock"));
  });
});

// ---------------------------------------------------------------------------
// §8 the server's side
// ---------------------------------------------------------------------------

describe("SPEC §8: /api/health carries the version", () => {
  it("reads ok and version out of the answer", async () => {
    const fetchImpl = (async () =>
      ({ ok: true, json: async () => ({ ok: true, version: "0.80.0" }) }) as Response) as unknown as typeof fetch;
    await expect(fetchHealth("http://127.0.0.1:7233", { fetchImpl })).resolves.toEqual({
      ok: true,
      version: "0.80.0",
    });
  });

  it("treats nothing answering as an answer, not an error", async () => {
    const refused = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(fetchHealth("http://127.0.0.1:7233", { fetchImpl: refused })).resolves.toBeUndefined();
  });

  it("tolerates a pre-contract Paddock with no version in its health", async () => {
    const fetchImpl = (async () =>
      ({ ok: true, json: async () => ({ ok: true }) }) as Response) as unknown as typeof fetch;
    await expect(fetchHealth("http://x", { fetchImpl })).resolves.toEqual({ ok: true });
  });

  it("the version the CLI prints is the version the server reports", () => {
    // One module, three readers (version.ts) — so `--version`, /api/health and
    // the OpenAPI document cannot disagree, which is what makes
    // `status`'s installed-vs-running comparison mean anything.
    expect(PADDOCK_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// ---------------------------------------------------------------------------
// §4 the busy check — the CLI's side (wave C1)
// ---------------------------------------------------------------------------

describe("SPEC §4: runtime.json is how the CLI finds the instance", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-runtime-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("writes { pid, port, url, version, startedAt } and reads it back", () => {
    const written = writeRuntimeFile(home, {
      pid: process.pid,
      port: 7233,
      url: "http://127.0.0.1:7233",
      version: "0.80.0",
    });
    expect(written.startedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(readRuntimeFile(home)).toEqual(written);
    expect(runtimeFilePath(home)).toBe(path.join(home, "runtime.json"));
  });

  // 0600 now, so that adding the §10 token later changes nothing about who can
  // read the file — which is the whole reason the reference writes it this way
  // before there is a token to protect.
  it("is readable only by this user", () => {
    writeRuntimeFile(home, { pid: 1, port: 1, url: "http://x", version: "0" });
    expect(fs.statSync(runtimeFilePath(home)).mode & 0o777).toBe(0o600);
  });

  it("leaves no temporary file behind, so a reader never sees a half-written one", () => {
    writeRuntimeFile(home, { pid: 1, port: 1, url: "http://x", version: "0" });
    expect(fs.readdirSync(home)).toEqual(["runtime.json"]);
  });

  it("reads a corrupt or foreign file as absent rather than throwing", () => {
    fs.writeFileSync(runtimeFilePath(home), "{ not json");
    expect(readRuntimeFile(home)).toBeNull();
    fs.writeFileSync(runtimeFilePath(home), JSON.stringify({ hello: "world" }));
    expect(readRuntimeFile(home)).toBeNull();
    expect(readRuntimeFile(path.join(home, "nope"))).toBeNull();
  });

  /**
   * THE case this file exists for: a crashed instance leaves the file behind,
   * and `busy` must not report a dead pid's port as a running instance — it
   * would fetch whatever took the port next and believe the answer.
   */
  it("treats a file naming a dead pid as no instance", () => {
    writeRuntimeFile(home, { pid: 2 ** 22, port: 1, url: "http://x", version: "0" });
    expect(readRuntimeFile(home)).not.toBeNull();
    expect(readLiveRuntimeFile(home)).toBeNull();
    writeRuntimeFile(home, { pid: process.pid, port: 1, url: "http://x", version: "0" });
    expect(readLiveRuntimeFile(home)).not.toBeNull();
  });

  // A second instance may have started and written its own since: removing that
  // one on our way out would blind the CLI to a server that IS running.
  it("removes the file only while it is still ours", () => {
    writeRuntimeFile(home, { pid: process.pid + 1, port: 1, url: "http://x", version: "0" });
    expect(removeRuntimeFile(home, process.pid)).toBe(false);
    expect(fs.existsSync(runtimeFilePath(home))).toBe(true);
    writeRuntimeFile(home, { pid: process.pid, port: 1, url: "http://x", version: "0" });
    expect(removeRuntimeFile(home, process.pid)).toBe(true);
    expect(fs.existsSync(runtimeFilePath(home))).toBe(false);
    // Idempotent: a SIGINT after a SIGTERM must not throw on the way out.
    expect(removeRuntimeFile(home, process.pid)).toBe(false);
  });

  /**
   * The URL recorded has to be one a CLI can fetch, which `cfg.host` is not
   * when the bind is a wildcard — the normal case in a container, and what this
   * repo's own `pm` wrapper injects (`HOST=0.0.0.0`). Found by reading the file
   * a `pm`-run instance wrote.
   */
  it("records a loopback URL for a wildcard bind, and leaves a real address alone", () => {
    expect(runtimeUrl("0.0.0.0", 5101)).toBe("http://127.0.0.1:5101");
    expect(runtimeUrl("::", 5101)).toBe("http://[::1]:5101");
    expect(runtimeUrl("127.0.0.1", 7233)).toBe("http://127.0.0.1:7233");
    expect(runtimeUrl("192.168.1.10", 80)).toBe("http://192.168.1.10:80");
    // Bracketed, because `new URL('http://::1:7233')` is not a URL — and
    // `cli/busy.ts` builds its request with `new URL('/api/busy', base)`.
    expect(() => new URL("/api/busy", runtimeUrl("::", 5101))).not.toThrow();
  });
});

describe("SPEC §4: `paddock busy` and its exit codes", () => {
  const answer = (body: unknown, ok = true): typeof fetch =>
    (async () => ({ ok, status: ok ? 200 : 503, json: async () => body }) as Response) as unknown as typeof fetch;

  it("is a top-level verb, taking --json and nothing else", () => {
    expect(parseCommand(["busy"])).toEqual({ verb: "busy", opts: OPTS });
    expect(parseCommand(["busy", "--json"]).opts.json).toBe(true);
    expect(parseCommand(["busy", "-d", "/tmp/x"]).opts.dataDir).toBe("/tmp/x");
    // Not a `service` action: the point of `busy` is to be askable where there
    // is no service to ask (SPEC §1).
    expect(() => parseCommand(["service", "busy"])).toThrow(UsageError);
  });

  it("is in the help, with its own page and its exit codes", () => {
    expect(USAGE).toContain("paddock busy");
    expect(USAGE_SYNOPSIS).toContain("paddock busy");
    expect(USAGE.replace(/\s+/g, " ")).toContain("75 busy");
    expect(BUSY_USAGE).toContain("paddock busy --json");
    for (const code of ["0 ", "75 ", "3 ", "1 "]) {
      expect(BUSY_USAGE.replace(/\s+/g, " ")).toContain(code);
    }
  });

  it("maps idle to 0, busy to 75, nothing answering to 3", async () => {
    const idle = await checkBusy({ home: "/nope", url: "http://x", fetch: answer({ busy: false }) });
    expect(busyExitCode(idle)).toBe(EXIT.ok);

    const busy = await checkBusy({
      home: "/nope",
      url: "http://x",
      fetch: answer({ busy: true, version: "0.80.0", counts: { chat: 2, background: 0, job: 0 } }),
    });
    expect(busyExitCode(busy)).toBe(EXIT.busy);
    expect(busyExitCode({ state: "not-running" })).toBe(EXIT.notRunning);
  });

  // "Nothing answering" is not a failure: §4 says it means not running, and an
  // update may go ahead. A refused connection has to land there and not on 1.
  it("reads a refused connection as not running, not as a failure", async () => {
    const refused = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await checkBusy({ home: "/nope", url: "http://x", fetch: refused });
    expect(result).toEqual({ state: "not-running" });
    expect(busyExitCode(result)).toBe(EXIT.notRunning);
  });

  // With no runtime.json there is NO fallback to a default port, because
  // guessing one asks whatever else is listening there and believes it.
  it("never guesses a port: no runtime file means not running", async () => {
    let asked = false;
    const spy = (async () => {
      asked = true;
      return { ok: true, json: async () => ({ busy: true }) } as Response;
    }) as unknown as typeof fetch;
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-nobusy-"));
    try {
      expect(await checkBusy({ home: empty, fetch: spy })).toEqual({ state: "not-running" });
      expect(asked).toBe(false);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  /**
   * Something is listening, but it is not a Paddock that knows this question —
   * an older version with no `/api/busy`, or an unrelated program on the port.
   * That is exit 1 and a sentence, NOT a silent "not busy": treating it as idle
   * is how a stop proceeds against a server it could not actually ask.
   */
  it("distinguishes an answer it cannot read from no answer at all", async () => {
    const notFound = await checkBusy({ home: "/nope", url: "http://x", fetch: answer({}, false) });
    expect(notFound).toMatchObject({ state: "unknown", detail: "HTTP 503" });
    expect(busyExitCode(notFound)).toBe(EXIT.failure);

    const notBusyShaped = await checkBusy({
      home: "/nope",
      url: "http://x",
      fetch: answer({ hello: "world" }),
    });
    expect(notBusyShaped).toMatchObject({ state: "unknown" });
    expect(busyExitCode(notBusyShaped)).toBe(EXIT.failure);
  });

  it("says what is running, in the sentence §4 gives", () => {
    const busy = (counts: Record<string, number>): BusyResult => ({
      state: "busy",
      url: "http://127.0.0.1:7233/api/busy",
      answer: { busy: true, counts },
    });
    expect(busyMessage("Paddock", busy({ chat: 2 }), PADDOCK_NOUNS)).toBe(
      "Paddock is busy: 2 chat turns are running.",
    );
    expect(busyMessage("Paddock", busy({ chat: 1 }), PADDOCK_NOUNS)).toBe(
      "Paddock is busy: 1 chat turn is running.",
    );
    expect(busyMessage("Paddock", busy({ chat: 2, background: 1, job: 0 }), PADDOCK_NOUNS)).toBe(
      "Paddock is busy: 2 chat turns and 1 background task are running.",
    );
    expect(busyMessage("Paddock", { state: "idle", url: "u", answer: { busy: false } })).toBe(
      "Paddock isn't busy.",
    );
    expect(busyMessage("Paddock", { state: "not-running" })).toBe("Paddock isn't running.");
    // No noun ends up pluralised by adding an "s" to something that is not a
    // noun: "3 backgrounds are running" was the version this guards against.
    expect(describeCounts({ background: 3 }, PADDOCK_NOUNS)).toBe("3 background tasks are running");
  });

  it("`--json` prints one document of the shape the schema fixes", () => {
    const doc = busyJson({
      state: "busy",
      url: "http://127.0.0.1:7233/api/busy",
      answer: { busy: true, version: "0.80.0", counts: { chat: 1, background: 0, job: 0 } },
    });
    expect(doc).toEqual({
      running: true,
      busy: true,
      // The INSTANCE url, not the endpoint's — `/api/busy` is stripped.
      url: "http://127.0.0.1:7233",
      version: "0.80.0",
      counts: { chat: 1, background: 0, job: 0 },
    });
    expect(busyJson({ state: "not-running" })).toEqual({ running: false, busy: false });
    expect(
      busyJson({ state: "unknown", url: "http://127.0.0.1:7233/api/busy", detail: "HTTP 404" }),
    ).toEqual({ running: true, busy: false, url: "http://127.0.0.1:7233", error: "HTTP 404" });
  });
});

describe("SPEC §4: the guard `stop`, `restart` and `update` run first", () => {
  const busyFetch = (counts: Record<string, number>): typeof fetch =>
    (async () =>
      ({ ok: true, json: async () => ({ busy: true, version: "0.80.0", counts }) }) as Response) as unknown as typeof fetch;

  function recordingOutput(): { out: Output; lines: string[] } {
    const lines: string[] = [];
    const stream = { write: (s: string) => void lines.push(s.trimEnd()) };
    return { out: createOutput({ tool: "paddock", stdout: stream, stderr: stream, env: {} }), lines };
  }

  it("refuses with 75, naming what is running and the way past it", async () => {
    const { out, lines } = recordingOutput();
    const code = await guardBusy({
      home: "/nope",
      url: "http://x",
      fetch: busyFetch({ chat: 0, background: 2, job: 0 }),
      name: "Paddock",
      nouns: PADDOCK_NOUNS,
      hint: paddockBusyHint,
      out,
    });
    expect(code).toBe(EXIT.busy);
    expect(lines.join("\n")).toContain("paddock: Paddock is busy: 2 background tasks are running.");
    expect(lines.join("\n")).toContain("--force");
  });

  // `--force` prints the SAME message, prefixed `Overriding:` (SPEC §4) — the
  // user who forced it should see exactly what they just overrode.
  it("--force prints the same message prefixed `Overriding:` and carries on", async () => {
    const { out, lines } = recordingOutput();
    const code = await guardBusy({
      home: "/nope",
      url: "http://x",
      fetch: busyFetch({ chat: 1, background: 0, job: 0 }),
      name: "Paddock",
      nouns: PADDOCK_NOUNS,
      out,
      force: true,
    });
    expect(code).toBeNull();
    expect(lines.join("\n")).toBe("Overriding: Paddock is busy: 1 chat turn is running.");
  });

  it("goes ahead when nothing answers, and when it is idle", async () => {
    const idle = (async () => ({ ok: true, json: async () => ({ busy: false }) }) as Response) as unknown as typeof fetch;
    const { out } = recordingOutput();
    const base = { home: "/nope", url: "http://x", name: "Paddock", out };
    expect(await guardBusy({ ...base, fetch: idle })).toBeNull();
    expect(await guardBusy({ ...base, home: "/definitely/not/here" })).toBeNull();
  });

  /**
   * THE Paddock-specific trap (ROADMAP "Busy, per tool"). A keeper chat that
   * runs `service restart` or `update` is itself one of the chat turns the
   * answer counted, so it can only ever see itself as busy — and `--force` from
   * there does not override a mistaken reading, it kills the chat that typed it.
   */
  it("tells a chat to run it from a terminal, when chats are what is running", () => {
    const withChats = paddockBusyHint({
      state: "busy",
      url: "http://x",
      answer: { busy: true, counts: { chat: 1, background: 0, job: 0 } },
    });
    expect(withChats).toContain("from a terminal");
    expect(withChats).toContain("not from inside a Paddock chat");

    // Background work and jobs get the ordinary advice: nothing is holding a
    // keyboard inside the service, so --force is a reasonable thing to suggest.
    const withoutChats = paddockBusyHint({
      state: "busy",
      url: "http://x",
      answer: { busy: true, counts: { chat: 0, background: 1, job: 2 } },
    });
    expect(withoutChats).toBe("Try again once it has finished, or use --force.");
    expect(paddockBusyHint({ state: "not-running" })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §4/§8 the server's side of the busy check
// ---------------------------------------------------------------------------

describe("SPEC §4: what the server counts as busy", () => {
  const sources = (chat: number, background: number, job: number) => ({
    runningChats: () => chat,
    backgroundTasks: () => background,
    runningJobs: () => job,
  });

  it("is not busy when nothing is running", () => {
    expect(collectBusy(sources(0, 0, 0), "0.80.0")).toEqual({
      busy: false,
      version: "0.80.0",
      counts: { chat: 0, background: 0, job: 0 },
    });
  });

  it("is busy on any one of the three, and reports all three counts", () => {
    expect(collectBusy(sources(1, 0, 0), "0.80.0").busy).toBe(true);
    expect(collectBusy(sources(0, 1, 0), "0.80.0").busy).toBe(true);
    expect(collectBusy(sources(0, 0, 1), "0.80.0").busy).toBe(true);
    expect(collectBusy(sources(2, 3, 1), "0.80.0").counts).toEqual({
      chat: 2,
      background: 3,
      job: 1,
    });
  });

  /**
   * A busy check that 500s is worse than one that under-reports: `cli/busy.ts`
   * reads a non-200 as "something answered, but not as Paddock's busy check" —
   * exit 1 — which FAILS a `service stop` outright rather than letting it
   * through. So a source that throws counts as zero.
   */
  it("survives a source that throws, rather than 500ing the endpoint", () => {
    const body = collectBusy(
      {
        runningChats: () => {
          throw new Error("no hub");
        },
        backgroundTasks: () => 2,
        runningJobs: () => {
          throw new Error("no fleet");
        },
      },
      "0.80.0",
    );
    expect(body).toEqual({ busy: true, version: "0.80.0", counts: { chat: 0, background: 2, job: 0 } });
  });

  it("never reports a negative or fractional count", () => {
    expect(collectBusy(sources(-1, 1.5, Number.NaN), "0.80.0")).toEqual({
      busy: false,
      version: "0.80.0",
      counts: { chat: 0, background: 0, job: 0 },
    });
  });

  /**
   * Background work is counted only in sessions whose SDK session is still
   * live, and that filter is load-bearing rather than belt-and-braces. Nothing
   * resets the registry when a one-shot `claude` exits, so on
   * `driveMode: batch` a finished turn's tasks sit in it indefinitely — without
   * the filter, one batch turn that launched a background task would report the
   * instance busy for the rest of the process's life, and every `service stop`
   * after it would refuse.
   */
  it("ignores background tasks whose session is no longer live", () => {
    const registry = new BackgroundRegistry();
    registry.observe("demo", {
      type: "system",
      subtype: "background_tasks_changed",
      session_id: "live-one",
      tasks: [{ task_id: "t1", task_type: "local_bash", description: "build" }],
    });
    registry.observe("demo", {
      type: "system",
      subtype: "background_tasks_changed",
      session_id: "dead-one",
      tasks: [
        { task_id: "t2", task_type: "local_agent", description: "review" },
        { task_id: "t3", task_type: "local_bash", description: "test" },
      ],
    });
    expect(registry.liveTaskCount()).toBe(3);
    expect(registry.liveTaskCount((id) => id === "live-one")).toBe(1);
    expect(registry.liveTaskCount(() => false)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §1/§4 `service stop` and `service restart` refuse when busy
// ---------------------------------------------------------------------------

describe("SPEC §1: stop and restart run the busy check, uninstall does not", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-busy-stop-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const ready = async () => "ready" as const;

  /**
   * A context whose busy guard is injected, with a record of what it was asked.
   *
   * `refuse` is what `guardServiceBusy` returns when it has printed a refusal:
   * 75, which `runService` must pass straight out rather than carrying on and
   * returning its own 0.
   */
  function withGuard(
    refuse: number | null,
    run: Runner,
  ): {
    ctx: Parameters<typeof runService>[2];
    asked: { action: string; home: string; force: boolean }[];
  } {
    const asked: { action: string; home: string; force: boolean }[] = [];
    return {
      asked,
      ctx: {
        ...contextFor("linux", home, run),
        checkReady: ready,
        guardBusy: async (action, askedHome, opts) => {
          asked.push({ action, home: askedHome, force: opts.force === true });
          return opts.force === true ? null : refuse;
        },
      },
    };
  }

  function installUnit(dataDir?: string): void {
    const { run } = recorder();
    createSystemdBackend(run, home).install(
      buildSpec({
        ...BASE,
        dataDir: dataDir ?? path.join(home, ".paddock"),
        ...(dataDir !== undefined ? { dataDirArg: dataDir } : {}),
      }),
    );
  }

  it("stop refuses with 75 and does not touch the supervisor", async () => {
    installUnit();
    const active = recorder({ stdout: "active" });
    const { ctx, asked } = withGuard(EXIT.busy, active.run);

    const { code } = await capture(() => runService("stop", OPTS, ctx));

    expect(code).toBe(EXIT.busy);
    expect(asked).toEqual([{ action: "stop", home: path.join(home, ".paddock"), force: false }]);
    // The point of the refusal: nothing was stopped.
    expect(active.calls.flat()).not.toContain("stop");
  });

  it("stop --force goes ahead", async () => {
    installUnit();
    const active = recorder({ stdout: "active" });
    const { ctx, asked } = withGuard(EXIT.busy, active.run);

    const { code } = await capture(() => runService("stop", { ...OPTS, force: true }, ctx));

    expect(code).toBe(EXIT.ok);
    expect(asked[0].force).toBe(true);
    expect(active.calls).toContainEqual(["systemctl", "--user", "stop", SYSTEMD_UNIT]);
  });

  it("restart refuses with 75, and --force goes ahead", async () => {
    installUnit();
    const active = recorder({ stdout: "active" });
    const refusing = withGuard(EXIT.busy, active.run);
    const { code } = await capture(() => runService("restart", OPTS, refusing.ctx));
    expect(code).toBe(EXIT.busy);
    expect(refusing.asked).toEqual([
      { action: "restart", home: path.join(home, ".paddock"), force: false },
    ]);
    expect(active.calls.flat()).not.toContain("restart");

    const forcing = withGuard(EXIT.busy, active.run);
    const forced = await capture(() => runService("restart", { ...OPTS, force: true }, forcing.ctx));
    expect(forced.code).toBe(EXIT.ok);
    expect(active.calls).toContainEqual(["systemctl", "--user", "restart", SYSTEMD_UNIT]);
  });

  /**
   * `uninstall` does not ask (SPEC §1: "removing the service is an explicit
   * act"), and neither does `start` — there is nothing running for a start to
   * cut short, so asking would be theatre that could only ever refuse wrongly.
   */
  it("start and uninstall never ask", async () => {
    installUnit();
    const inactive = recorder({ stdout: "inactive" });
    const forStart = withGuard(EXIT.busy, inactive.run);
    await capture(() => runService("start", OPTS, forStart.ctx));
    expect(forStart.asked).toEqual([]);

    const active = recorder({ stdout: "active" });
    const forUninstall = withGuard(EXIT.busy, active.run);
    await capture(() => runService("uninstall", OPTS, forUninstall.ctx));
    expect(forUninstall.asked).toEqual([]);
  });

  // Nothing to ask and nothing to cut short: a missing unit is 4 and an
  // already-stopped service is 0, both decided before the check runs.
  it("does not ask when there is no unit, or the service is already stopped", async () => {
    const noUnit = withGuard(EXIT.busy, recorder().run);
    const missing = await capture(() => runService("stop", OPTS, noUnit.ctx));
    expect(missing.code).toBe(EXIT.notInstalled);
    expect(noUnit.asked).toEqual([]);

    installUnit();
    const stopped = withGuard(EXIT.busy, recorder({ stdout: "inactive" }).run);
    const already = await capture(() => runService("stop", OPTS, stopped.ctx));
    expect(already.code).toBe(EXIT.ok);
    expect(stopped.asked).toEqual([]);
  });

  /**
   * The instance asked about is the one the UNIT describes, not whatever
   * `--data-dir` this invocation carries (#824). Getting this wrong would read
   * `runtime.json` out of a different instance and answer "not busy" about the
   * one being stopped — the quiet version of no busy check at all.
   */
  it("asks about the unit's own data dir, ignoring today's --data-dir", async () => {
    const unitDataDir = path.join(home, "service-instance");
    installUnit(unitDataDir);
    const active = recorder({ stdout: "active" });
    const { ctx, asked } = withGuard(null, active.run);

    await capture(() =>
      runService("stop", { ...OPTS, dataDir: path.join(home, "somewhere-else") }, ctx),
    );

    expect(asked[0].home).toBe(unitDataDir);
  });

  it("`--force` parses, and nothing else turns it on", () => {
    expect(parseArgs(["--force"]).force).toBe(true);
    expect(parseArgs([]).force).toBeUndefined();
    expect(parseCommand(["service", "stop", "--force"]).opts.force).toBe(true);
    expect(parseCommand(["service", "restart", "--force"]).opts.force).toBe(true);
    expect(SERVICE_USAGE).toContain("--force");
  });
});

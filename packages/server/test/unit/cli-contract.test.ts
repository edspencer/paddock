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
} from "../../src/cli/args.js";
import { EXIT } from "../../src/cli/exit-codes.js";
import { buildSpec, serviceLogPath } from "../../src/cli/service/spec.js";
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

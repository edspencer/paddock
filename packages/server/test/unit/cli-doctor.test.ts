/**
 * `paddock doctor [--json] [--offline]` (CLI contract SPEC §1).
 *
 * Everything that touches the machine is injected — the service manager's
 * commands, the port probe, the registry, the config loader — so each check's
 * pass, warning and failure can be arranged on one box. What these do NOT prove
 * is that a real systemd or launchd agrees: `service status`'s own tests and the
 * real-service CI cover the report `doctor` reads.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCommand, UsageError, DOCTOR_USAGE, USAGE, USAGE_SYNOPSIS } from "../../src/cli/args.js";
import { EXIT } from "../../src/cli/exit-codes.js";
import {
  diagnose,
  doctorExit,
  renderChecks,
  type Check,
  type DoctorInput,
  type InstanceConfig,
} from "../../src/cli/doctor.js";
import type { Runner } from "../../src/cli/service/manager.js";
import { createSystemd } from "../../src/cli/service/systemd.js";
import { buildSpec, PADDOCK_SERVICE } from "../../src/cli/service/spec.js";
import { readUpdateCheck } from "../../src/cli/update/update-check.js";
import { writeRuntimeFile } from "../../src/runtime-file.js";
import { PADDOCK_VERSION } from "../../src/version.js";
// The contract's own validator and schema, from the conformance runner this repo
// already uses: a `--json` that drifts from `schemas/doctor.schema.json` fails here.
import { validate, loadSchema, formatErrors } from "@edspencer/cli-conformance/dist/src/schema.js";

const SPEC_IDS = [
  "node-engines",
  "install-method",
  "unit",
  "running-version",
  "port",
  "linger",
  "data-home",
  "update",
];

let home: string;
let cli: string;
let node: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-doctor-"));
  // A pretend global install, so the walk-up finds a named package with engines.
  const pkg = path.join(home, "lib", "node_modules", "@edspencer", "paddock");
  cli = path.join(pkg, "packages", "server", "dist", "cli", "paddock.js");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, "");
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "@edspencer/paddock", version: PADDOCK_VERSION, engines: { node: ">=22" } }),
  );
  node = path.join(home, "bin", "node");
  fs.mkdirSync(path.dirname(node), { recursive: true });
  fs.writeFileSync(node, "");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** A systemd that answers: is-active, MainPID and linger as given. */
function systemd(o: { active?: boolean; linger?: "yes" | "no" | "none" } = {}): Runner {
  return (cmd, args) => {
    if (cmd === "systemctl" && args.includes("is-active"))
      return { status: o.active ? 0 : 3, stdout: o.active ? "active\n" : "inactive\n", stderr: "" };
    if (cmd === "systemctl" && args.includes("MainPID"))
      return { status: 0, stdout: o.active ? "4242\n" : "0\n", stderr: "" };
    if (cmd === "loginctl")
      return o.linger === "none" || o.linger === undefined
        ? { status: null, stdout: "", stderr: "" }
        : { status: 0, stdout: `Linger=${o.linger}\n`, stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
}

const CONFIG = (dataDir: string): InstanceConfig => ({
  projectsRoot: path.join(dataDir, "projects"),
  claudeHome: path.join(dataDir, "claude-home"),
  credentials: "own",
  driveMode: "session",
});

/** A registry that serves `latest` and its manifest. */
function registry(latest: string): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("dist-tags")) return new Response(JSON.stringify({ latest }), { status: 200 });
    return new Response(JSON.stringify({ name: "@edspencer/paddock", version: latest, engines: { node: ">=22" } }), {
      status: 200,
    });
  }) as typeof fetch;
}

function input(over: Partial<DoctorInput> & { run?: Runner } = {}): DoctorInput {
  const { run, ...rest } = over;
  return {
    ctx: {
      platform: "linux",
      nodePath: node,
      scriptPath: cli,
      packageRoot: path.dirname(cli),
      homeDir: home,
      run: run ?? systemd(),
      probeHealth: async () => undefined,
    },
    entry: cli,
    env: { PATH: path.join(home, "bin") },
    nodeVersion: "22.23.4",
    npmGlobalRoot: () => path.join(home, "lib", "node_modules"),
    registry: "http://registry.test",
    registryFetch: registry(PADDOCK_VERSION),
    isListening: async () => false,
    identify: async () => undefined,
    loadConfig: async (d) => CONFIG(d),
    userClaudeHome: path.join(home, ".claude"),
    ...rest,
  };
}

const byId = (checks: Check[], id: string): Check[] => checks.filter((c) => c.id === id);
const one = (checks: Check[], id: string): Check => {
  const found = byId(checks, id);
  expect(found, id).toHaveLength(1);
  return found[0];
};

function installUnit(o: { port?: string } = {}): void {
  createSystemd(PADDOCK_SERVICE, { run: systemd(), homeDir: home }).install(
    buildSpec({
      nodePath: node,
      scriptPath: cli,
      dataDir: path.join(home, ".paddock"),
      ...(o.port !== undefined ? { port: o.port } : {}),
    }),
  );
}

describe("paddock doctor: parsing", () => {
  it("is a verb, and takes --json and --offline", () => {
    const c = parseCommand(["doctor", "--json", "--offline"]);
    expect(c.verb).toBe("doctor");
    expect(c.opts.json).toBe(true);
    expect(c.opts.offline).toBe(true);
  });

  it.each([
    ["busy", "--offline"],
    ["update", "--offline"],
    ["serve", "--offline"],
    ["service", "status", "--offline"],
    ["config", "show", "--offline"],
  ])("--offline is a usage error anywhere else: %s", (...argv) => {
    expect(() => parseCommand(argv)).toThrow(UsageError);
    try {
      parseCommand(argv);
    } catch (err) {
      expect((err as UsageError).exitCode).toBe(EXIT.USAGE);
      expect((err as Error).message).toContain("--offline applies to `doctor` only");
    }
  });

  it.each([["--force"], ["--check"], ["--refresh"], ["--yes"]])("doctor %s is a usage error", (flag) => {
    expect(() => parseCommand(["doctor", flag])).toThrow(UsageError);
  });

  it("the help and the synopsis name it", () => {
    expect(USAGE).toContain("paddock doctor [--json] [--offline]");
    expect(USAGE_SYNOPSIS).toContain("paddock doctor");
    for (const id of [...SPEC_IDS, "config", "projects", "claude-login", "claude-cli"]) {
      expect(DOCTOR_USAGE).toContain(id);
    }
  });
});

describe("paddock doctor: the checks", () => {
  it("runs the contract's eight checks with their ids, then Paddock's own, and its --json fits the schema", async () => {
    const { checks } = await diagnose(input());
    const ids = [...new Set(checks.map((c) => c.id))];
    expect(ids).toEqual([
      "node-engines",
      "install-method",
      "unit",
      "running-version",
      "port",
      "linger",
      "data-home",
      "config",
      "projects",
      "claude-login",
      "claude-cli",
      "update",
    ]);
    const doc = { ok: doctorExit(checks) === 0, version: PADDOCK_VERSION, checks };
    expect(formatErrors(validate(loadSchema("doctor"), doc))).toBe("");
  });

  it("a fresh machine: nothing failed, and nothing was created", async () => {
    const { checks, notice } = await diagnose(input());
    expect(doctorExit(checks)).toBe(EXIT.OK);
    expect(one(checks, "install-method").status).toBe("pass");
    expect(one(checks, "unit").status).toBe("skip");
    expect(one(checks, "running-version").status).toBe("skip");
    expect(one(checks, "port")).toMatchObject({ status: "pass", message: "port 7233 is free" });
    expect(one(checks, "data-home").message).toContain("doesn't exist yet");
    expect(one(checks, "update")).toMatchObject({ status: "pass", message: `${PADDOCK_VERSION} is the latest` });
    expect(notice).toBeUndefined();
    // Not even update-check.json: writing it would create the data dir, and with
    // it the instance (serve's first-run welcome keys on the dir being new).
    expect(fs.existsSync(path.join(home, ".paddock"))).toBe(false);
  });

  it("every warning and every failure has a fix, and the rendering puts it under the line", async () => {
    installUnit();
    fs.rmSync(node);
    const { checks } = await diagnose(
      input({
        run: systemd({ active: false, linger: "no" }),
        isListening: async () => true,
        identify: async () => ({ paddock: false }),
        registryFetch: registry("99.0.0"),
      }),
    );
    for (const c of checks) if (c.status === "fail" || c.status === "warn") expect(c.fix, c.id).toBeTruthy();
    const text = renderChecks(checks);
    for (const line of text.trimEnd().split("\n")) expect(line).toMatch(/^([✓!✗-] |    fix: )/);
    expect(text).toMatch(/^✗ the service runs .*node, which isn't there any more.*\n    fix: paddock service install --refresh/m);
  });

  describe("unit", () => {
    it("passes for an installed, running, answering service", async () => {
      installUnit();
      const i = input({ run: systemd({ active: true, linger: "yes" }) });
      i.ctx.probeHealth = async () => ({ ok: true, version: PADDOCK_VERSION });
      const r = await diagnose({ ...i, isListening: async () => true, identify: async () => ({ paddock: true, version: PADDOCK_VERSION }) });
      expect(one(r.checks, "unit")).toMatchObject({ status: "pass" });
      expect(one(r.checks, "unit").message).toContain("running and answering at http://127.0.0.1:7233");
      expect(one(r.checks, "running-version").status).toBe("pass");
      expect(one(r.checks, "port")).toMatchObject({ status: "pass", message: `port 7233 is Paddock's (${PADDOCK_VERSION})` });
      expect(one(r.checks, "linger").status).toBe("pass");
      expect(doctorExit(r.checks)).toBe(EXIT.OK);
    });

    it("fails when the Node it runs has gone", async () => {
      installUnit();
      fs.rmSync(node);
      const { checks } = await diagnose(input({ run: systemd({ active: true }) }));
      const unit = byId(checks, "unit").find((c) => c.status === "fail");
      expect(unit?.message).toContain("isn't there any more");
      expect(doctorExit(checks)).toBe(EXIT.FAILED);
    });

    it("warns when the unit runs a different install from this CLI", async () => {
      installUnit();
      const other = path.join(home, "other", "paddock.js");
      fs.mkdirSync(path.dirname(other), { recursive: true });
      fs.writeFileSync(other, "");
      const i = input({ run: systemd({ active: true }) });
      i.ctx.scriptPath = other;
      i.ctx.probeHealth = async () => ({ ok: true, version: PADDOCK_VERSION });
      const { checks } = await diagnose(i);
      const w = byId(checks, "unit").find((c) => c.status === "warn");
      expect(w?.message).toContain("a different Paddock install");
      expect(w?.fix).toContain("--refresh");
    });

    it("warns when it's installed but not running", async () => {
      installUnit();
      const { checks } = await diagnose(input({ run: systemd({ active: false }) }));
      expect(one(checks, "unit")).toMatchObject({ status: "warn", fix: expect.stringContaining("paddock service start") });
    });

    it("skips, rather than failing, where there's no service manager (Windows)", async () => {
      const i = input();
      i.ctx.platform = "win32";
      const { checks } = await diagnose(i);
      expect(one(checks, "unit").status).toBe("skip");
      expect(one(checks, "linger").status).toBe("skip");
    });
  });

  describe("running-version", () => {
    it("fails when the service runs an older version than is installed", async () => {
      installUnit();
      const i = input({ run: systemd({ active: true }) });
      i.ctx.probeHealth = async () => ({ ok: true, version: "0.0.1" });
      const { checks } = await diagnose(i);
      expect(one(checks, "running-version")).toMatchObject({ status: "fail", fix: "paddock service restart" });
    });

    it("finds a foreground serve through runtime.json", async () => {
      const dataDir = path.join(home, ".paddock");
      writeRuntimeFile(dataDir, { pid: process.pid, port: 7300, url: "http://127.0.0.1:7300", version: "0.0.1" });
      const { checks } = await diagnose(input());
      expect(one(checks, "running-version")).toMatchObject({
        status: "fail",
        fix: expect.stringContaining("Ctrl-C"),
      });
      // …and the port check follows it to 7300.
      expect(one(checks, "port").message).toBe("port 7300 is free");
    });
  });

  describe("port", () => {
    it("fails when something that isn't Paddock holds it, and names the unit's port", async () => {
      installUnit({ port: "7299" });
      const { checks } = await diagnose(
        input({ isListening: async (_h, p) => p === 7299, identify: async () => undefined }),
      );
      expect(one(checks, "port")).toMatchObject({
        status: "fail",
        message: "something that isn't Paddock is listening on port 7299",
        fix: expect.stringContaining("paddock service install --port"),
      });
    });
  });

  describe("linger", () => {
    it("warns only when there is a service for it to matter to", async () => {
      expect(one((await diagnose(input({ run: systemd({ linger: "no" }) }))).checks, "linger").status).toBe("pass");
      installUnit();
      const c = one((await diagnose(input({ run: systemd({ linger: "no" }) }))).checks, "linger");
      expect(c.status).toBe("warn");
      expect(c.fix).toMatch(/^sudo loginctl enable-linger /);
    });
  });

  describe("data-home", () => {
    it("fails when the data dir can't be written", async () => {
      if (process.getuid?.() === 0) return; // root writes anywhere
      const dir = path.join(home, "ro");
      fs.mkdirSync(dir, { mode: 0o500 });
      const { checks } = await diagnose(input({ dataDir: dir }));
      expect(one(checks, "data-home").status).toBe("fail");
    });

    it("--data-dir picks the instance", async () => {
      const dir = path.join(home, "elsewhere");
      fs.mkdirSync(dir);
      const { checks } = await diagnose(input({ dataDir: dir }));
      expect(one(checks, "data-home").message).toBe("the data dir ~/elsewhere is writable");
      expect(readUpdateCheck(dir)).not.toBeNull();
    });
  });

  describe("Paddock's own", () => {
    it("config: a config that won't load fails, and the checks that need it skip", async () => {
      const { checks } = await diagnose(
        input({
          loadConfig: async () => {
            throw new Error("Failed to parse Paddock config file /x/paddock.config.yaml as YAML: bad\nmore");
          },
        }),
      );
      expect(one(checks, "config")).toMatchObject({ status: "fail" });
      expect(one(checks, "config").message).toContain("as YAML: bad");
      expect(one(checks, "config").message).not.toContain("more");
      expect(one(checks, "projects").status).toBe("skip");
      expect(one(checks, "claude-login").status).toBe("skip");
    });

    it("config: the real loader reads a real data dir without creating it", async () => {
      const dir = path.join(home, "never-made");
      const { checks } = await diagnose(input({ dataDir: dir, loadConfig: undefined, offline: true }));
      expect(one(checks, "config").status).toBe("pass");
      expect(fs.existsSync(dir)).toBe(false);
    });

    it("claude-login: names the kind of login, never its value", async () => {
      // Plainly not a token, so no secret scanner mistakes the fixture for one.
      const secret = "placeholder-value-doctor-must-not-print";
      const { checks } = await diagnose(input({ env: { PATH: "", CLAUDE_CODE_OAUTH_TOKEN: secret } }));
      const c = one(checks, "claude-login");
      expect(c).toMatchObject({ status: "pass", message: "CLAUDE_CODE_OAUTH_TOKEN is set in this shell" });
      expect(JSON.stringify(checks)).not.toContain(secret);
    });

    it("claude-login: a host login is found when credentials is host, and not when it's own", async () => {
      fs.mkdirSync(path.join(home, ".claude"));
      fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), "{}");
      const own = one((await diagnose(input())).checks, "claude-login");
      expect(own.status).toBe("warn");
      expect(own.message).toContain("claude.credentials: own");
      const host = one(
        (await diagnose(input({ loadConfig: async (d) => ({ ...CONFIG(d), credentials: "host" }) }))).checks,
        "claude-login",
      );
      expect(host).toMatchObject({ status: "pass" });
      expect(host.message).toContain("shares this machine's Claude Code login");
    });

    it("claude-login: the macOS Keychain counts on darwin", async () => {
      const i = input({
        keychain: async () => "found",
        loadConfig: async (d) => ({ ...CONFIG(d), credentials: "host" }),
      });
      i.ctx.platform = "darwin";
      expect(one((await diagnose(i)).checks, "claude-login").message).toContain("macOS Keychain");
    });

    it("claude-cli: no claude is a warning on session, a failure on batch", async () => {
      expect(one((await diagnose(input())).checks, "claude-cli").status).toBe("warn");
      const batch = await diagnose(input({ loadConfig: async (d) => ({ ...CONFIG(d), driveMode: "batch" }) }));
      expect(one(batch.checks, "claude-cli").status).toBe("fail");
      expect(doctorExit(batch.checks)).toBe(EXIT.FAILED);

      const claude = path.join(home, "bin", "claude");
      fs.writeFileSync(claude, "#!/bin/sh\n", { mode: 0o755 });
      expect(one((await diagnose(input())).checks, "claude-cli")).toMatchObject({ status: "pass" });
    });
  });

  describe("update", () => {
    it("a newer version is a warning with the notice, and update-check.json is written for status", async () => {
      fs.mkdirSync(path.join(home, ".paddock"));
      const r = await diagnose(input({ registryFetch: registry("99.0.0") }));
      expect(one(r.checks, "update")).toMatchObject({ status: "warn", fix: "paddock update" });
      expect(r.notice).toContain(`Paddock 99.0.0 is available (you have ${PADDOCK_VERSION}).`);
      expect(r.notice).toContain("Run: paddock update");
      expect(doctorExit(r.checks)).toBe(EXIT.OK);
      const cache = readUpdateCheck(path.join(home, ".paddock"));
      expect(cache).toMatchObject({ current: PADDOCK_VERSION, target: "99.0.0", updateAvailable: true, command: "paddock update" });
    });

    it("an install that can't update itself gets its own command", async () => {
      const r = await diagnose(input({ registryFetch: registry("99.0.0"), env: { PATH: "", PADDOCK_IN_DOCKER: "1" } }));
      expect(one(r.checks, "install-method").status).toBe("warn");
      expect(one(r.checks, "update").fix).toBe("docker compose pull && docker compose up -d");
    });

    it("a registry that doesn't answer is a warning, not a failure", async () => {
      const r = await diagnose(
        input({
          registryFetch: (async () => {
            throw new Error("connect ECONNREFUSED");
          }) as typeof fetch,
        }),
      );
      expect(one(r.checks, "update")).toMatchObject({ status: "warn", fix: expect.stringContaining("--offline") });
      expect(doctorExit(r.checks)).toBe(EXIT.OK);
    });

    it("--offline asks nothing and writes nothing", async () => {
      let asked = false;
      const r = await diagnose(
        input({
          offline: true,
          registryFetch: (async () => {
            asked = true;
            throw new Error("asked");
          }) as typeof fetch,
        }),
      );
      expect(asked).toBe(false);
      expect(one(r.checks, "update").status).toBe("skip");
      expect(fs.existsSync(path.join(home, ".paddock"))).toBe(false);
    });
  });
});

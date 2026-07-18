/**
 * Unit tests for loadPaddockConfig env resolution — focused on the native
 * system-prompt toggle (issue #176), which is deliberately DECOUPLED from the
 * dev-servers capability flag. Each case saves/restores the touched env vars and
 * points PADDOCK_DATA_DIR at a throwaway tmp dir (loadPaddockConfig mkdirs it).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadPaddockConfig } from "../../src/config.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

const ENV_KEYS = [
  "PADDOCK_DATA_DIR",
  "PADDOCK_KEEPER_NATIVE_PROMPT",
  "PADDOCK_DEV_SERVERS_ENABLED",
  "PADDOCK_MAX_SPAWN_DEPTH",
];

/** Env vars folded into PaddockConfig by issue #269 (F1). */
const FOLD_ENV_KEYS = [
  "PADDOCK_DATA_DIR",
  "LOG_LEVEL",
  "PADDOCK_BROWSER_MCP",
  "PADDOCK_SWEEP_MIN_INTERVAL_MS",
  "PADDOCK_GIT_AUTHOR_NAME",
  "PADDOCK_GIT_AUTHOR_EMAIL",
  "PADDOCK_GITHUB_CLIENT_ID",
];

describe("loadPaddockConfig: nativeSystemPrompt (#176)", () => {
  let dataDir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(async () => {
    dataDir = await makeTmpDir("paddock-config-");
    saved = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.PADDOCK_DATA_DIR = dataDir;
    delete process.env.PADDOCK_KEEPER_NATIVE_PROMPT;
    delete process.env.PADDOCK_DEV_SERVERS_ENABLED;
    delete process.env.PADDOCK_MAX_SPAWN_DEPTH;
  });
  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rmTmpDir(dataDir);
  });

  it("defaults to native (true) on every instance", () => {
    expect(loadPaddockConfig().nativeSystemPrompt).toBe(true);
  });

  it("is independent of PADDOCK_DEV_SERVERS_ENABLED", () => {
    process.env.PADDOCK_DEV_SERVERS_ENABLED = "false";
    const cfg = loadPaddockConfig();
    expect(cfg.devServers.enabled).toBe(false);
    // Dev servers off must NOT force a replace prompt anymore (the old coupling).
    expect(cfg.nativeSystemPrompt).toBe(true);
  });

  it.each(["0", "false", "no", "FALSE", "No"])(
    "opts into the replace prompt when set to %s",
    (val) => {
      process.env.PADDOCK_KEEPER_NATIVE_PROMPT = val;
      expect(loadPaddockConfig().nativeSystemPrompt).toBe(false);
    },
  );

  it.each(["1", "true", "yes", "anything-else"])(
    "stays native when set to %s",
    (val) => {
      process.env.PADDOCK_KEEPER_NATIVE_PROMPT = val;
      expect(loadPaddockConfig().nativeSystemPrompt).toBe(true);
    },
  );
});

describe("loadPaddockConfig: maxSpawnDepth (#262)", () => {
  let dataDir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(async () => {
    dataDir = await makeTmpDir("paddock-config-");
    saved = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.PADDOCK_DATA_DIR = dataDir;
    delete process.env.PADDOCK_MAX_SPAWN_DEPTH;
  });
  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rmTmpDir(dataDir);
  });

  it("defaults to 1 (manager → children → report-back works out of the box)", () => {
    expect(loadPaddockConfig().maxSpawnDepth).toBe(1);
  });

  it.each([
    ["0", 0],
    ["2", 2],
    ["8", 8],
  ])("honors a valid PADDOCK_MAX_SPAWN_DEPTH=%s", (raw, expected) => {
    process.env.PADDOCK_MAX_SPAWN_DEPTH = raw;
    expect(loadPaddockConfig().maxSpawnDepth).toBe(expected);
  });

  it.each(["-1", "9", "1.5", "nonsense", ""])(
    "falls back to the default 1 for the invalid value %s",
    (raw) => {
      process.env.PADDOCK_MAX_SPAWN_DEPTH = raw;
      expect(loadPaddockConfig().maxSpawnDepth).toBe(1);
    },
  );
});

describe("loadPaddockConfig: folded env knobs (#269)", () => {
  let dataDir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(async () => {
    dataDir = await makeTmpDir("paddock-config-");
    saved = {};
    for (const k of FOLD_ENV_KEYS) saved[k] = process.env[k];
    for (const k of FOLD_ENV_KEYS) delete process.env[k];
    process.env.PADDOCK_DATA_DIR = dataDir;
  });
  afterEach(async () => {
    for (const k of FOLD_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rmTmpDir(dataDir);
  });

  it("preserves the pre-fold defaults when nothing is set", () => {
    const cfg = loadPaddockConfig();
    expect(cfg.logLevel).toBe("info");
    expect(cfg.browserMcp).toBe(false);
    expect(cfg.sweepMinIntervalMs).toBeUndefined();
    expect(cfg.gitAuthor).toEqual({ name: "Paddock", email: "paddock@localhost" });
    expect(cfg.githubClientId).toBeUndefined();
  });

  it("LOG_LEVEL overrides the logger level", () => {
    process.env.LOG_LEVEL = "debug";
    expect(loadPaddockConfig().logLevel).toBe("debug");
  });

  it("PADDOCK_BROWSER_MCP=1 enables the browser MCP (only the literal '1')", () => {
    process.env.PADDOCK_BROWSER_MCP = "1";
    expect(loadPaddockConfig().browserMcp).toBe(true);
    process.env.PADDOCK_BROWSER_MCP = "true";
    expect(loadPaddockConfig().browserMcp).toBe(false);
  });

  it.each([
    ["0", 0],
    ["250", 250],
    ["60000", 60000],
  ])("parses a valid PADDOCK_SWEEP_MIN_INTERVAL_MS=%s", (raw, expected) => {
    process.env.PADDOCK_SWEEP_MIN_INTERVAL_MS = raw;
    expect(loadPaddockConfig().sweepMinIntervalMs).toBe(expected);
  });

  it.each(["-1", "nonsense", "  "])(
    "ignores an invalid PADDOCK_SWEEP_MIN_INTERVAL_MS=%s (falls back to the default)",
    (raw) => {
      process.env.PADDOCK_SWEEP_MIN_INTERVAL_MS = raw;
      expect(loadPaddockConfig().sweepMinIntervalMs).toBeUndefined();
    },
  );

  it("threads the git author identity from env", () => {
    process.env.PADDOCK_GIT_AUTHOR_NAME = "Ed";
    process.env.PADDOCK_GIT_AUTHOR_EMAIL = "ed@example.com";
    expect(loadPaddockConfig().gitAuthor).toEqual({ name: "Ed", email: "ed@example.com" });
  });

  it("trims PADDOCK_GITHUB_CLIENT_ID and treats blank as unset", () => {
    process.env.PADDOCK_GITHUB_CLIENT_ID = "  Iv1.abc  ";
    expect(loadPaddockConfig().githubClientId).toBe("Iv1.abc");
    process.env.PADDOCK_GITHUB_CLIENT_ID = "   ";
    expect(loadPaddockConfig().githubClientId).toBeUndefined();
  });
});

/**
 * YAML instance-config file loader (issue #270 / DD-5) — precedence file < env.
 * Each case points PADDOCK_DATA_DIR at a throwaway tmp dir and writes the
 * optional `paddock.config.yaml` under it; the surrounding env vars that could
 * shadow file values are cleared so the file layer is observed in isolation.
 */
describe("loadPaddockConfig: YAML instance-config file (#270)", () => {
  // Every env var the file layer can be overridden by, plus the file-path knob.
  const FILE_ENV_KEYS = [
    "PADDOCK_DATA_DIR",
    "PADDOCK_CONFIG",
    "PORT",
    "HOST",
    "PADDOCK_AUTH_MODE",
    "PADDOCK_AUTH_JWKS_URL",
    "PADDOCK_BRAND_NAME",
    "PADDOCK_KEEPER_DRIVE_MODE",
    "PADDOCK_MAX_SPAWN_DEPTH",
    "PADDOCK_DEV_SERVERS_ENABLED",
    "PADDOCK_SELF_MCP",
    "PADDOCK_SELF_MCP_WRITE",
    "PADDOCK_BROWSER_MCP",
    "PADDOCK_SWEEP_MIN_INTERVAL_MS",
    "PADDOCK_GIT_AUTHOR_NAME",
    "LOG_LEVEL",
  ];

  let dataDir: string;
  let saved: Record<string, string | undefined>;

  const writeConfig = (body: string, dir = dataDir): string => {
    const p = path.join(dir, "paddock.config.yaml");
    fs.writeFileSync(p, body, "utf8");
    return p;
  };

  beforeEach(async () => {
    dataDir = await makeTmpDir("paddock-config-file-");
    saved = {};
    for (const k of FILE_ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.PADDOCK_DATA_DIR = dataDir;
  });
  afterEach(async () => {
    for (const k of FILE_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rmTmpDir(dataDir);
  });

  it("no file present → env-only behaviour is unchanged (a no-op)", () => {
    const cfg = loadPaddockConfig();
    expect(cfg.port).toBe(4000);
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.auth.mode).toBe("none");
    expect(cfg.brand.name).toBe("Paddock");
    expect(cfg.keeperDriveMode).toBe("batch");
    expect(cfg.maxSpawnDepth).toBe(1);
    expect(cfg.devServers.enabled).toBe(false);
    expect(cfg.gitAuthor).toEqual({ name: "Paddock", email: "paddock@localhost" });
  });

  it("an empty (comments-only) file is also a no-op", () => {
    writeConfig("# nothing to see here\n");
    expect(loadPaddockConfig().brand.name).toBe("Paddock");
  });

  it("populates config from file values across scalar + nested sections", () => {
    writeConfig(
      [
        "port: 5123",
        "host: 127.0.0.1",
        "logLevel: debug",
        "keeperDriveMode: session",
        "maxSpawnDepth: 2",
        "browserMcp: true",
        "sweepMinIntervalMs: 250",
        "auth:",
        "  mode: jwt",
        "  jwksUrl: https://idp.example/jwks",
        "brand:",
        "  name: Homelab",
        "  accent: '#123456'",
        "devServers:",
        "  enabled: true",
        "selfMcpEnabled: true",
        "selfMcpWriteEnabled: true",
        "gitAuthor:",
        "  name: Ed",
        "  email: ed@example.com",
      ].join("\n") + "\n",
    );
    const cfg = loadPaddockConfig();
    expect(cfg.port).toBe(5123);
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.logLevel).toBe("debug");
    expect(cfg.keeperDriveMode).toBe("session");
    expect(cfg.maxSpawnDepth).toBe(2);
    expect(cfg.browserMcp).toBe(true);
    expect(cfg.sweepMinIntervalMs).toBe(250);
    expect(cfg.auth.mode).toBe("jwt");
    expect(cfg.auth.jwksUrl).toBe("https://idp.example/jwks");
    expect(cfg.brand).toMatchObject({ name: "Homelab", accent: "#123456" });
    expect(cfg.devServers.enabled).toBe(true);
    expect(cfg.selfMcpEnabled).toBe(true);
    expect(cfg.selfMcpWriteEnabled).toBe(true);
    expect(cfg.gitAuthor).toEqual({ name: "Ed", email: "ed@example.com" });
  });

  it("env overrides a file value (precedence file < env), file base still applies elsewhere", () => {
    writeConfig(["brand:", "  name: FromFile", "auth:", "  mode: jwt"].join("\n") + "\n");
    process.env.PADDOCK_BRAND_NAME = "FromEnv";
    const cfg = loadPaddockConfig();
    // Env wins for the shadowed key…
    expect(cfg.brand.name).toBe("FromEnv");
    // …while an un-shadowed file value is still honoured.
    expect(cfg.auth.mode).toBe("jwt");
  });

  it("env overrides a file boolean too (dev servers off via env beats file `true`)", () => {
    writeConfig(["devServers:", "  enabled: true"].join("\n") + "\n");
    process.env.PADDOCK_DEV_SERVERS_ENABLED = "false";
    expect(loadPaddockConfig().devServers.enabled).toBe(false);
  });

  it("PADDOCK_BROWSER_MCP keeps literal-'1' env semantics over any file value", () => {
    writeConfig("browserMcp: true\n");
    // File alone enables it…
    expect(loadPaddockConfig().browserMcp).toBe(true);
    // …but a non-'1' env value explicitly disables it (unchanged env semantics).
    process.env.PADDOCK_BROWSER_MCP = "true";
    expect(loadPaddockConfig().browserMcp).toBe(false);
    process.env.PADDOCK_BROWSER_MCP = "1";
    expect(loadPaddockConfig().browserMcp).toBe(true);
  });

  it("honours an explicit PADDOCK_CONFIG path outside the data dir", async () => {
    const other = await makeTmpDir("paddock-config-explicit-");
    try {
      const p = writeConfig("brand:\n  name: Explicit\n", other);
      process.env.PADDOCK_CONFIG = p;
      expect(loadPaddockConfig().brand.name).toBe("Explicit");
    } finally {
      await rmTmpDir(other);
    }
  });

  it("throws a clear error when PADDOCK_CONFIG points at a missing file", () => {
    process.env.PADDOCK_CONFIG = path.join(dataDir, "does-not-exist.yaml");
    expect(() => loadPaddockConfig()).toThrow(/does not exist/);
  });

  it("throws a clear error on malformed YAML (not a silent crash)", () => {
    writeConfig("port: 5000\n  bad: : indentation:\n:::\n");
    expect(() => loadPaddockConfig()).toThrow(/parse .*config file/i);
  });

  it("throws a clear error when the file is a YAML list instead of a mapping", () => {
    writeConfig("- one\n- two\n");
    expect(() => loadPaddockConfig()).toThrow(/must contain a YAML mapping/);
  });
});

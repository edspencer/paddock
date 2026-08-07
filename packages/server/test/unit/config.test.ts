/**
 * Unit tests for loadPaddockConfig env resolution — focused on the native
 * system-prompt toggle (issue #176). Each case saves/restores the touched env
 * vars and points PADDOCK_DATA_DIR at a throwaway tmp dir (loadPaddockConfig
 * mkdirs it).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  loadPaddockConfig,
  resolveDefaultWebDist,
  claudeHomeRefusal,
  DEFAULT_CLAUDE_HOME_DIRNAME,
} from "../../src/config.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

const ENV_KEYS = [
  "PADDOCK_DATA_DIR",
  "PADDOCK_NATIVE_PROMPT",
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
    delete process.env.PADDOCK_NATIVE_PROMPT;
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

  it.each(["0", "false", "no", "FALSE", "No"])(
    "opts into the replace prompt when set to %s",
    (val) => {
      process.env.PADDOCK_NATIVE_PROMPT = val;
      expect(loadPaddockConfig().nativeSystemPrompt).toBe(false);
    },
  );

  it.each(["1", "true", "yes", "anything-else"])(
    "stays native when set to %s",
    (val) => {
      process.env.PADDOCK_NATIVE_PROMPT = val;
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

describe("loadPaddockConfig: hooksMcpEnabled (G5)", () => {
  let dataDir: string;
  let saved: Record<string, string | undefined>;
  const KEYS = ["PADDOCK_DATA_DIR", "PADDOCK_HOOKS_MCP"];

  beforeEach(async () => {
    dataDir = await makeTmpDir("paddock-config-");
    saved = {};
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.PADDOCK_DATA_DIR = dataDir;
    delete process.env.PADDOCK_HOOKS_MCP;
  });
  afterEach(async () => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rmTmpDir(dataDir);
  });

  it("defaults OFF (opt-in per instance / project)", () => {
    expect(loadPaddockConfig().hooksMcpEnabled).toBe(false);
  });

  it.each(["1", "true", "yes", "TRUE"])("PADDOCK_HOOKS_MCP=%s enables it", (raw) => {
    process.env.PADDOCK_HOOKS_MCP = raw;
    expect(loadPaddockConfig().hooksMcpEnabled).toBe(true);
  });

  it.each(["0", "false", "no", "nonsense", ""])("leaves it OFF for %s", (raw) => {
    process.env.PADDOCK_HOOKS_MCP = raw;
    expect(loadPaddockConfig().hooksMcpEnabled).toBe(false);
  });
});

describe("loadPaddockConfig: openapi reference", () => {
  let dataDir: string;
  let saved: Record<string, string | undefined>;
  const KEYS = ["PADDOCK_DATA_DIR", "PADDOCK_OPENAPI_ENABLED", "PADDOCK_OPENAPI_PATH"];

  beforeEach(async () => {
    dataDir = await makeTmpDir("paddock-config-");
    saved = {};
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.PADDOCK_DATA_DIR = dataDir;
    delete process.env.PADDOCK_OPENAPI_ENABLED;
    delete process.env.PADDOCK_OPENAPI_PATH;
  });
  afterEach(async () => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rmTmpDir(dataDir);
  });

  it("defaults OFF (opt-in) with the /open-api path", () => {
    const cfg = loadPaddockConfig();
    expect(cfg.openapi.enabled).toBe(false);
    expect(cfg.openapi.path).toBe("/open-api");
  });

  it.each(["1", "true", "yes", "on", "TRUE"])("PADDOCK_OPENAPI_ENABLED=%s enables it", (raw) => {
    process.env.PADDOCK_OPENAPI_ENABLED = raw;
    expect(loadPaddockConfig().openapi.enabled).toBe(true);
  });

  it.each(["0", "false", "no", "off", "nonsense", ""])("leaves it OFF for %s", (raw) => {
    process.env.PADDOCK_OPENAPI_ENABLED = raw;
    expect(loadPaddockConfig().openapi.enabled).toBe(false);
  });

  it("normalizes a custom path to a leading slash, no trailing slash", () => {
    process.env.PADDOCK_OPENAPI_PATH = "api-docs/";
    expect(loadPaddockConfig().openapi.path).toBe("/api-docs");
  });
});

describe("loadPaddockConfig: recovery (#301)", () => {
  let dataDir: string;
  let saved: Record<string, string | undefined>;
  const KEYS = [
    "PADDOCK_DATA_DIR",
    "PADDOCK_RECOVERY_SURFACE",
    "PADDOCK_RECOVERY_AUTODRIVE",
    "PADDOCK_RECOVERY_DEBOUNCE_MS",
    "PADDOCK_RECOVERY_MAX_RETRIES",
    "PADDOCK_RECOVERY_LIMBO_MS",
  ];

  beforeEach(async () => {
    dataDir = await makeTmpDir("paddock-config-");
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.PADDOCK_DATA_DIR = dataDir;
  });
  afterEach(async () => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rmTmpDir(dataDir);
  });

  it("defaults: Layer 2 ON, Layer 3 OFF, guards at documented values", () => {
    expect(loadPaddockConfig().recovery).toEqual({
      surfaceKilledTask: true,
      autoReDrive: false,
      debounceMs: 5000,
      maxRetries: 1,
      limboTimeoutMs: 0,
    });
  });

  it("PADDOCK_RECOVERY_SURFACE=0 turns Layer 2 off", () => {
    process.env.PADDOCK_RECOVERY_SURFACE = "0";
    expect(loadPaddockConfig().recovery.surfaceKilledTask).toBe(false);
  });

  it.each(["1", "true", "yes"])("PADDOCK_RECOVERY_AUTODRIVE=%s opts Layer 3 in", (raw) => {
    process.env.PADDOCK_RECOVERY_AUTODRIVE = raw;
    expect(loadPaddockConfig().recovery.autoReDrive).toBe(true);
  });

  it("parses the numeric knobs from env", () => {
    process.env.PADDOCK_RECOVERY_DEBOUNCE_MS = "1500";
    process.env.PADDOCK_RECOVERY_MAX_RETRIES = "3";
    process.env.PADDOCK_RECOVERY_LIMBO_MS = "30000";
    const r = loadPaddockConfig().recovery;
    expect(r).toMatchObject({ debounceMs: 1500, maxRetries: 3, limboTimeoutMs: 30000 });
  });

  it.each(["-1", "1.5", "nonsense", ""])(
    "falls back to the default for an invalid debounce value %j",
    (raw) => {
      process.env.PADDOCK_RECOVERY_DEBOUNCE_MS = raw;
      expect(loadPaddockConfig().recovery.debounceMs).toBe(5000);
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
    "PADDOCK_DRIVE_MODE",
    "PADDOCK_MAX_SPAWN_DEPTH",
    "PADDOCK_SELF_MCP",
    "PADDOCK_SELF_MCP_WRITE",
    "PADDOCK_HOOKS_MCP",
    "PADDOCK_BROWSER_MCP",
    "PADDOCK_SWEEP_MIN_INTERVAL_MS",
    "PADDOCK_GIT_AUTHOR_NAME",
    "PADDOCK_RECOVERY_SURFACE",
    "PADDOCK_RECOVERY_AUTODRIVE",
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
    // Safe by default (#435): the bind host now defaults to loopback.
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.dangerouslyAllowOpen).toBe(false);
    expect(cfg.auth.mode).toBe("none");
    expect(cfg.brand.name).toBe("Paddock");
    // Built-in default flipped to session (#316); env + file still override.
    expect(cfg.driveMode).toBe("session");
    expect(cfg.maxSpawnDepth).toBe(1);
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
        "driveMode: session",
        "maxSpawnDepth: 2",
        "browserMcp: true",
        "sweepMinIntervalMs: 250",
        "auth:",
        "  mode: jwt",
        "  jwksUrl: https://idp.example/jwks",
        "brand:",
        "  name: Homelab",
        "  accent: '#123456'",
        "selfMcpEnabled: true",
        "selfMcpWriteEnabled: true",
        "hooksMcpEnabled: true",
        "recovery:",
        "  surfaceKilledTask: false",
        "  autoReDrive: true",
        "  debounceMs: 2500",
        "  limboTimeoutMs: 60000",
        "gitAuthor:",
        "  name: Ed",
        "  email: ed@example.com",
      ].join("\n") + "\n",
    );
    const cfg = loadPaddockConfig();
    expect(cfg.port).toBe(5123);
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.logLevel).toBe("debug");
    expect(cfg.driveMode).toBe("session");
    expect(cfg.maxSpawnDepth).toBe(2);
    expect(cfg.browserMcp).toBe(true);
    expect(cfg.sweepMinIntervalMs).toBe(250);
    expect(cfg.auth.mode).toBe("jwt");
    expect(cfg.auth.jwksUrl).toBe("https://idp.example/jwks");
    expect(cfg.brand).toMatchObject({ name: "Homelab", accent: "#123456" });
    expect(cfg.selfMcpEnabled).toBe(true);
    expect(cfg.selfMcpWriteEnabled).toBe(true);
    // Not in the file above ⇒ the project tool (#467) stays off even with write on.
    expect(cfg.selfMcpProjectsEnabled).toBe(false);
    expect(cfg.hooksMcpEnabled).toBe(true);
    // Recovery (#301): file values populate the group; the unset `maxRetries`
    // still falls back to the built-in default (1).
    expect(cfg.recovery).toEqual({
      surfaceKilledTask: false,
      autoReDrive: true,
      debounceMs: 2500,
      maxRetries: 1,
      limboTimeoutMs: 60000,
    });
    expect(cfg.gitAuthor).toEqual({ name: "Ed", email: "ed@example.com" });
  });

  it("selfMcpProjectsEnabled implies write implies read (#467)", () => {
    // Alone it is inert — the project tool rides on the write block.
    writeConfig("selfMcpProjectsEnabled: true\n");
    expect(loadPaddockConfig().selfMcpProjectsEnabled).toBe(false);

    // Write without read is also inert (the existing implication), so is projects.
    writeConfig(["selfMcpWriteEnabled: true", "selfMcpProjectsEnabled: true"].join("\n") + "\n");
    expect(loadPaddockConfig().selfMcpProjectsEnabled).toBe(false);

    // All three ⇒ on.
    writeConfig(
      ["selfMcpEnabled: true", "selfMcpWriteEnabled: true", "selfMcpProjectsEnabled: true"].join(
        "\n",
      ) + "\n",
    );
    expect(loadPaddockConfig().selfMcpProjectsEnabled).toBe(true);

    // Env shadows the file, same as its siblings.
    writeConfig(["selfMcpEnabled: true", "selfMcpWriteEnabled: true"].join("\n") + "\n");
    expect(loadPaddockConfig().selfMcpProjectsEnabled).toBe(false);
    process.env.PADDOCK_SELF_MCP_PROJECTS = "1";
    expect(loadPaddockConfig().selfMcpProjectsEnabled).toBe(true);
  });

  it("env overrides a recovery file value (precedence file < env)", () => {
    writeConfig(["recovery:", "  surfaceKilledTask: false"].join("\n") + "\n");
    process.env.PADDOCK_RECOVERY_SURFACE = "1";
    expect(loadPaddockConfig().recovery.surfaceKilledTask).toBe(true);
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

  it("treats an empty nested section (valueless key → null) as absent, not a crash", () => {
    // `brand:` / `auth:` with nothing after them parse to null; must NOT throw.
    writeConfig(["port: 4000", "brand:", "auth:"].join("\n") + "\n");
    let cfg!: ReturnType<typeof loadPaddockConfig>;
    expect(() => (cfg = loadPaddockConfig())).not.toThrow();
    expect(cfg.port).toBe(4000);
    expect(cfg.brand.name).toBe("Paddock");
    expect(cfg.auth.mode).toBe("none");
  });

  it("treats a null scalar (valueless key) as absent, falling back to the default", () => {
    writeConfig(["port:", "logLevel:", "maxSpawnDepth:"].join("\n") + "\n");
    const cfg = loadPaddockConfig();
    expect(cfg.port).toBe(4000);
    expect(cfg.logLevel).toBe("info");
    expect(cfg.maxSpawnDepth).toBe(1);
  });

  it("an empty section next to a populated one still honours the populated one", () => {
    writeConfig(
      ["brand:", "auth:", "  mode: jwt", "  jwksUrl: https://idp.example/jwks"].join("\n") + "\n",
    );
    const cfg = loadPaddockConfig();
    expect(cfg.brand.name).toBe("Paddock"); // empty section → default
    expect(cfg.auth.mode).toBe("jwt"); // sibling section still applies
    expect(cfg.auth.jwksUrl).toBe("https://idp.example/jwks");
  });
});

/**
 * Instance offered-models allow-list (issue #457 Step 2): env `PADDOCK_MODELS`
 * (comma-separated) over YAML `models:` (a string array) over the default
 * (undefined ⇒ offer the full catalog). Unknown ids are dropped; an all-unknown /
 * empty result falls back to undefined (the full catalog), so an instance is never
 * left offering zero models.
 */
describe("loadPaddockConfig: models allow-list (#457)", () => {
  const MODELS_ENV_KEYS = ["PADDOCK_DATA_DIR", "PADDOCK_CONFIG", "PADDOCK_MODELS"];
  let dataDir: string;
  let saved: Record<string, string | undefined>;

  const writeConfig = (body: string): string => {
    const p = path.join(dataDir, "paddock.config.yaml");
    fs.writeFileSync(p, body, "utf8");
    return p;
  };

  beforeEach(async () => {
    dataDir = await makeTmpDir("paddock-config-models-");
    saved = {};
    for (const k of MODELS_ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.PADDOCK_DATA_DIR = dataDir;
  });
  afterEach(async () => {
    for (const k of MODELS_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rmTmpDir(dataDir);
  });

  it("defaults to undefined (offer the full catalog) when neither env nor file set", () => {
    expect(loadPaddockConfig().models).toBeUndefined();
  });

  it("reads a YAML `models:` array, dropping unknown ids and de-duping", () => {
    writeConfig(
      ["models:", "  - claude-opus-5", "  - gpt-4", "  - claude-sonnet-5", "  - claude-opus-5"].join(
        "\n",
      ) + "\n",
    );
    expect(loadPaddockConfig().models).toEqual(["claude-opus-5", "claude-sonnet-5"]);
  });

  it("env `PADDOCK_MODELS` (comma-separated) overrides the YAML list", () => {
    writeConfig(["models:", "  - claude-opus-5"].join("\n") + "\n");
    process.env.PADDOCK_MODELS = "claude-sonnet-5, claude-haiku-4-5-20251001";
    expect(loadPaddockConfig().models).toEqual(["claude-sonnet-5", "claude-haiku-4-5-20251001"]);
  });

  it("falls back to undefined (full catalog) when every configured id is unknown", () => {
    process.env.PADDOCK_MODELS = "gpt-4,gemini";
    expect(loadPaddockConfig().models).toBeUndefined();
  });
});

/**
 * Retired settings must be IGNORED, never fatal (#549).
 *
 * `scratchDir` / `PADDOCK_SCRATCH_DIR` was deleted in #549. An operator upgrading
 * with a stale env file or an old `paddock.config.yaml` must still boot: config is
 * pull-based on both layers (env vars read by name, YAML parsed into a loose record
 * that is only ever read), so a deleted key is simply never looked at. These tests
 * pin that as a contract rather than an accident — and use `scratchDir` as the
 * concrete case the issue asked us to decide.
 */
describe("loadPaddockConfig: retired settings are ignored, not fatal (#549)", () => {
  const ENV = ["PADDOCK_DATA_DIR", "PADDOCK_CONFIG", "PADDOCK_SCRATCH_DIR"];
  let dataDir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(async () => {
    dataDir = await makeTmpDir("paddock-config-retired-");
    saved = {};
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.PADDOCK_DATA_DIR = dataDir;
  });
  afterEach(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rmTmpDir(dataDir);
  });

  it("boots with a stale PADDOCK_SCRATCH_DIR set, and carries no scratchDir", () => {
    process.env.PADDOCK_SCRATCH_DIR = path.join(dataDir, "somewhere-else");
    const cfg = loadPaddockConfig();
    expect(cfg.dataDir).toBeTruthy();
    expect("scratchDir" in cfg).toBe(false);
  });

  it("does not create a scratch dir for a stale PADDOCK_SCRATCH_DIR", () => {
    const stale = path.join(dataDir, "stale-scratch");
    process.env.PADDOCK_SCRATCH_DIR = stale;
    loadPaddockConfig();
    expect(fs.existsSync(stale)).toBe(false);
  });

  it("boots with a retired `scratchDir:` key in the YAML file, alongside live keys", () => {
    fs.writeFileSync(
      path.join(dataDir, "paddock.config.yaml"),
      ["scratchDir: /gone/nowhere", "logLevel: debug"].join("\n") + "\n",
      "utf8",
    );
    const cfg = loadPaddockConfig();
    // The retired key is inert; the live key beside it still resolves.
    expect("scratchDir" in cfg).toBe(false);
    expect(cfg.logLevel).toBe("debug");
  });

  it("ignores an entirely unknown key rather than throwing", () => {
    fs.writeFileSync(
      path.join(dataDir, "paddock.config.yaml"),
      ["neverWasASetting: 42", "logLevel: warn"].join("\n") + "\n",
      "utf8",
    );
    expect(loadPaddockConfig().logLevel).toBe("warn");
  });
});

/**
 * The `claude:` block and the home it is NOT allowed to resolve to (#691).
 *
 * Paddock used to have one lever — which Claude home it pointed at — and every
 * distinct concern hung off it: whose transcripts a delete removed, which login
 * was visible, whether agent memory could be written. Three incidents in a week
 * (#682, #683, #689) came out of moving it for one reason and getting the other
 * four for free. These pin the replacement: the home is always paddock's, and
 * what is SHARED is asked for by name.
 */
describe("loadPaddockConfig: the claude: block (#691)", () => {
  const KEYS = [
    "PADDOCK_DATA_DIR",
    "PADDOCK_CONFIG",
    "PADDOCK_CLAUDE_TRANSCRIPTS",
    "PADDOCK_CLAUDE_CREDENTIALS",
    "PADDOCK_CLAUDE_INSTRUCTIONS",
    "PADDOCK_CLAUDE_HOOKS",
    "PADDOCK_CLAUDE_MCP_SERVERS",
    "CLAUDE_HOME",
    "CLAUDE_CONFIG_DIR",
    "HOME",
  ];

  let dataDir: string;
  let saved: Record<string, string | undefined>;

  const writeConfig = (body: string): void => {
    fs.writeFileSync(path.join(dataDir, "paddock.config.yaml"), body, "utf8");
  };

  beforeEach(async () => {
    dataDir = await makeTmpDir("paddock-claudecfg-");
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.HOME = await makeTmpDir("paddock-claudecfg-home-");
    process.env.PADDOCK_DATA_DIR = dataDir;
  });
  afterEach(async () => {
    const home = process.env.HOME;
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (home !== undefined) await rmTmpDir(home);
    await rmTmpDir(dataDir);
  });

  it("defaults to own — nothing outside the data dir is written", () => {
    const cfg = loadPaddockConfig();
    expect(cfg.claude.transcripts).toBe("own");
    expect(cfg.claudeHome).toBe(path.join(cfg.dataDir, DEFAULT_CLAUDE_HOME_DIRNAME));
    expect(cfg.legacyClaudeHome).toBe(path.join(process.env.HOME!, ".claude"));
  });

  it("reads transcripts: host from the file, and env still wins over it", () => {
    writeConfig("claude:\n  transcripts: host\n");
    expect(loadPaddockConfig().claude.transcripts).toBe("host");
    process.env.PADDOCK_CLAUDE_TRANSCRIPTS = "own";
    expect(loadPaddockConfig().claude.transcripts).toBe("own");
  });

  it("falls back to own on an unrecognised value — a typo isolates, never shares", () => {
    writeConfig("claude:\n  transcripts: hostt\n");
    expect(loadPaddockConfig().claude.transcripts).toBe("own");
  });

  // The one key that does not default to `own`, and the reason is not symmetry:
  // reading a login writes nothing, while defaulting it to `own` is #683 — an
  // instance that boots clean and fails every turn.
  it("defaults credentials to host, deliberately against the pattern", () => {
    expect(loadPaddockConfig().claude.credentials).toBe("host");
  });

  it("reads credentials: own from the file, and env still wins over it", () => {
    writeConfig("claude:\n  credentials: own\n");
    expect(loadPaddockConfig().claude.credentials).toBe("own");
    process.env.PADDOCK_CLAUDE_CREDENTIALS = "host";
    expect(loadPaddockConfig().claude.credentials).toBe("host");
  });

  it("falls back to host on an unrecognised credentials value", () => {
    // Note the direction: for credentials a typo SHARES, because the failure it
    // avoids is the worse one and nothing of the user's is put at risk.
    writeConfig("claude:\n  credentials: ownn\n");
    expect(loadPaddockConfig().claude.credentials).toBe("host");
  });

  // #691 step 4. Both default `own`, and `instructions: own` is a deliberate
  // reversal of the argument #620 shipped with — see `claude-instructions.ts`.
  it("defaults instructions and hooks to own", () => {
    const cfg = loadPaddockConfig();
    expect(cfg.claude.instructions).toBe("own");
    expect(cfg.claude.hooks).toBe("own");
  });

  it("reads instructions: host from the file, and env still wins over it", () => {
    writeConfig("claude:\n  instructions: host\n");
    expect(loadPaddockConfig().claude.instructions).toBe("host");
    process.env.PADDOCK_CLAUDE_INSTRUCTIONS = "own";
    expect(loadPaddockConfig().claude.instructions).toBe("own");
  });

  it("reads hooks: host from the file, and env still wins over it", () => {
    writeConfig("claude:\n  hooks: host\n");
    expect(loadPaddockConfig().claude.hooks).toBe("host");
    process.env.PADDOCK_CLAUDE_HOOKS = "own";
    expect(loadPaddockConfig().claude.hooks).toBe("own");
  });

  it("falls back to own on an unrecognised hooks value — a typo never executes", () => {
    // The direction matters more here than anywhere else in the block: the
    // fallback for a security lever has to be the safe side of it.
    writeConfig("claude:\n  hooks: hots\n  instructions: hostt\n");
    const cfg = loadPaddockConfig();
    expect(cfg.claude.hooks).toBe("own");
    expect(cfg.claude.instructions).toBe("own");
  });

  // #691 step 5, the last lever. Defaults `own` like the other three; the typo
  // direction matters because an MCP server is a process paddock spawns.
  it("defaults mcpServers to own", () => {
    expect(loadPaddockConfig().claude.mcpServers).toBe("own");
  });

  it("reads mcpServers: host from the file, and env still wins over it", () => {
    writeConfig("claude:\n  mcpServers: host\n");
    expect(loadPaddockConfig().claude.mcpServers).toBe("host");
    process.env.PADDOCK_CLAUDE_MCP_SERVERS = "own";
    expect(loadPaddockConfig().claude.mcpServers).toBe("own");
  });

  it("falls back to own on an unrecognised mcpServers value", () => {
    writeConfig("claude:\n  mcpServers: hosts\n");
    expect(loadPaddockConfig().claude.mcpServers).toBe("own");
  });

  it("keeps all five keys independent — that separation is the whole point", () => {
    writeConfig(
      "claude:\n  transcripts: host\n  credentials: own\n  instructions: host\n" +
        "  hooks: own\n  mcpServers: host\n",
    );
    const cfg = loadPaddockConfig();
    expect(cfg.claude.transcripts).toBe("host");
    expect(cfg.claude.credentials).toBe("own");
    expect(cfg.claude.instructions).toBe("host");
    expect(cfg.claude.hooks).toBe("own");
    expect(cfg.claude.mcpServers).toBe("host");
  });

  // CLAUDE_HOME is deleted (#691). It is not an error — retired settings are
  // ignored, never fatal (#549) — it simply has no effect any more, and the
  // point of asserting it is that a stale export cannot quietly move the home
  // back on top of the user's.
  it("ignores the removed CLAUDE_HOME entirely", () => {
    process.env.CLAUDE_HOME = path.join(process.env.HOME!, ".claude");
    const cfg = loadPaddockConfig();
    expect(cfg.claudeHome).toBe(path.join(cfg.dataDir, DEFAULT_CLAUDE_HOME_DIRNAME));
  });

  // CLAUDE_CONFIG_DIR cannot be ignored the same way: it is Claude Code's own
  // variable, and herdctl declines to clobber an operator-set value, so
  // disagreeing with it is the #588 split-brain.
  it("honours CLAUDE_CONFIG_DIR as where paddock's OWN home goes", () => {
    const alt = path.join(dataDir, "elsewhere");
    process.env.CLAUDE_CONFIG_DIR = alt;
    expect(loadPaddockConfig().claudeHome).toBe(alt);
  });

  it("REFUSES to start when the home resolves to the user's own ~/.claude", () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(process.env.HOME!, ".claude");
    expect(() => loadPaddockConfig()).toThrow(/refusing to start/);
    // …and the message names the lever that does what they actually wanted.
    expect(() => loadPaddockConfig()).toThrow(/transcripts: host/);
  });

  it("refuses the same value from the config file, not just from env", () => {
    writeConfig(`claudeHome: ${path.join(process.env.HOME!, ".claude")}\n`);
    expect(() => loadPaddockConfig()).toThrow(/paddock.config.yaml/);
  });

  it("sees through a trailing slash — the check resolves both sides", () => {
    expect(claudeHomeRefusal("/u/me/.claude/", "/u/me/.claude", true)).toMatch(/refusing/);
    expect(claudeHomeRefusal("/u/me/.paddock/claude-home", "/u/me/.claude", true)).toBeUndefined();
  });
});

describe("resolveDefaultWebDist: percent-encoding (npx/global install)", () => {
  it("decodes a space in the install path instead of leaving %20", () => {
    // `new URL(url).pathname` would yield `/opt/my%20paddock/...`, which names a
    // directory that does not exist — and app.ts fails SILENTLY into API-only
    // mode, so the symptom is a blank page rather than an error.
    const dist = resolveDefaultWebDist("file:///opt/my%20paddock/packages/server/dist/config.js");
    expect(dist).toBe("/opt/my paddock/packages/web/dist");
    expect(dist).not.toContain("%20");
  });

  it("decodes non-ASCII characters in the install path", () => {
    const dist = resolveDefaultWebDist(
      "file:///home/ed/D%C3%A9veloppement/paddock/packages/server/dist/config.js",
    );
    expect(dist).toBe("/home/ed/Développement/paddock/packages/web/dist");
  });

  it("still resolves the plain ASCII case to packages/web/dist", () => {
    expect(resolveDefaultWebDist("file:///app/packages/server/dist/config.js")).toBe(
      "/app/packages/web/dist",
    );
  });
});

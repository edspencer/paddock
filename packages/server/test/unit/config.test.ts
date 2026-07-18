/**
 * Unit tests for loadPaddockConfig env resolution — focused on the native
 * system-prompt toggle (issue #176), which is deliberately DECOUPLED from the
 * dev-servers capability flag. Each case saves/restores the touched env vars and
 * points PADDOCK_DATA_DIR at a throwaway tmp dir (loadPaddockConfig mkdirs it).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

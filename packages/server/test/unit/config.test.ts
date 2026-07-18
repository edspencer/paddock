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

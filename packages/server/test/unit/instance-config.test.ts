/**
 * Unit tests for the instance-settings surface (issue #385): the GET DTO
 * builder, the PUT validator, and the comment-preserving YAML writer.
 *
 * These touch real `PADDOCK_*` env vars (to exercise env-shadow reporting), so
 * each case saves/restores the ones it sets. The writer tests round-trip a real
 * temp file on disk.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadPaddockConfig } from "../../src/config.js";
import {
  buildInstanceConfig,
  validatePatch,
  writeInstanceConfig,
  instanceConfigPath,
  InstanceConfigError,
  FIELDS,
} from "../../src/instance-config.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

// Every env var any field references — cleared before each case so the box's
// leaked PADDOCK_* vars don't poison env-shadow assertions, restored after.
const TOUCHED = [
  "PADDOCK_CONFIG",
  ...new Set(FIELDS.flatMap((f) => f.envVars)),
];

describe("instance-config (#385)", () => {
  let dataDir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(async () => {
    dataDir = await makeTmpDir("paddock-instcfg-");
    saved = {};
    for (const k of TOUCHED) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.PADDOCK_DATA_DIR = dataDir;
  });
  afterEach(async () => {
    for (const k of TOUCHED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rmTmpDir(dataDir);
  });

  const field = (dto: ReturnType<typeof buildInstanceConfig>, key: string) =>
    dto.groups.flatMap((g) => g.fields).find((f) => f.key === key)!;

  describe("buildInstanceConfig (GET shape)", () => {
    it("reports value/default/editable/sensitive per field", () => {
      const dto = buildInstanceConfig(loadPaddockConfig());
      const overview = field(dto, "curation.overviewMaxTokens");
      expect(overview.value).toBe(2000);
      expect(overview.default).toBe(2000);
      expect(overview.editable).toBe(true);
      expect(overview.envOverridden).toBe(false);

      const port = field(dto, "port");
      expect(port.editable).toBe(false);

      const authMode = field(dto, "auth.mode");
      expect(authMode.editable).toBe(false);
      expect(authMode.sensitive).toBe(true);
    });

    it("marks a field env-overridden when its PADDOCK_* var is set", () => {
      process.env.PADDOCK_CURATION_OVERVIEW_MAX_TOKENS = "3333";
      const dto = buildInstanceConfig(loadPaddockConfig());
      const overview = field(dto, "curation.overviewMaxTokens");
      expect(overview.value).toBe(3333);
      expect(overview.envOverridden).toBe(true);
      expect(overview.envVar).toBe("PADDOCK_CURATION_OVERVIEW_MAX_TOKENS");
    });

    it("does not mark a field overridden by a blank env var", () => {
      process.env.PADDOCK_BROWSER_MCP = "   ";
      const dto = buildInstanceConfig(loadPaddockConfig());
      expect(field(dto, "browserMcp").envOverridden).toBe(false);
    });

    it("never surfaces secret values (transcription apiKey / auth jwt)", () => {
      const keys = FIELDS.map((f) => f.key);
      expect(keys).not.toContain("transcription.apiKey");
      expect(keys.some((k) => k.startsWith("auth.jwt"))).toBe(false);
      expect(keys).not.toContain("auth.jwksUrl");
    });

    it("reports the resolved config file path", () => {
      const cfg = loadPaddockConfig();
      const dto = buildInstanceConfig(cfg);
      expect(dto.configPath).toBe(path.join(cfg.dataDir, "paddock.config.yaml"));
      expect(dto.restartRequired).toBe(false);
    });
  });

  describe("validatePatch", () => {
    it("rejects unknown keys", () => {
      expect(() => validatePatch({ nope: 1 })).toThrow(InstanceConfigError);
    });
    it("rejects read-only keys", () => {
      expect(() => validatePatch({ port: 8080 })).toThrow(/read-only/);
    });
    it("rejects a non-positive curation budget", () => {
      expect(() => validatePatch({ "curation.overviewMaxTokens": 0 })).toThrow(/positive integer/);
    });
    it("coerces valid values", () => {
      expect(validatePatch({ "curation.overviewMaxTokens": 2500 })).toEqual([
        { key: "curation.overviewMaxTokens", value: 2500 },
      ]);
      expect(validatePatch({ keeperDriveMode: "batch" })).toEqual([
        { key: "keeperDriveMode", value: "batch" },
      ]);
      expect(validatePatch({ "brand.accent": "#abcdef" })).toEqual([
        { key: "brand.accent", value: "#abcdef" },
      ]);
    });
    it("rejects a bad enum / bad hex / bad drive mode", () => {
      expect(() => validatePatch({ keeperDriveMode: "turbo" })).toThrow(/one of/);
      expect(() => validatePatch({ "brand.accent": "red" })).toThrow(/hex color/);
      expect(() => validatePatch({ logLevel: "loud" })).toThrow(/one of/);
    });
    it("clears an optional field with null", () => {
      expect(validatePatch({ sweepMinIntervalMs: null })).toEqual([
        { key: "sweepMinIntervalMs", value: null },
      ]);
    });
    it("accepts an allowedTypes list", () => {
      expect(validatePatch({ "attachments.allowedTypes": ["image/*", ".pdf"] })).toEqual([
        { key: "attachments.allowedTypes", value: ["image/*", ".pdf"] },
      ]);
    });
  });

  describe("writeInstanceConfig (comment-preserving, atomic, create-on-missing)", () => {
    it("creates the file when absent", () => {
      const p = path.join(dataDir, "paddock.config.yaml");
      expect(fs.existsSync(p)).toBe(false);
      writeInstanceConfig(p, [{ key: "curation.overviewMaxTokens", value: 2500 }]);
      expect(fs.existsSync(p)).toBe(true);
      const parsed = loadPaddockConfig();
      expect(parsed.curation.overviewMaxTokens).toBe(2500);
    });

    it("preserves operator comments and unmanaged keys", () => {
      const p = path.join(dataDir, "paddock.config.yaml");
      fs.writeFileSync(
        p,
        [
          "# Operator notes: do not delete!",
          "brand:",
          "  name: My Box # inline comment",
          "someUnmanagedKey: keep-me",
          "curation:",
          "  overviewMaxTokens: 1000",
          "",
        ].join("\n"),
        "utf8",
      );
      writeInstanceConfig(p, [
        { key: "curation.overviewMaxTokens", value: 4242 },
        { key: "brand.accent", value: "#123456" },
      ]);
      const raw = fs.readFileSync(p, "utf8");
      expect(raw).toContain("# Operator notes: do not delete!");
      expect(raw).toContain("inline comment");
      expect(raw).toContain("someUnmanagedKey: keep-me");
      expect(raw).toContain("4242");
      expect(raw).toContain("#123456");
      // The pre-existing brand.name survives the nested write.
      expect(raw).toContain("My Box");
    });

    it("round-trips a change the loader then reads back", () => {
      const p = path.join(dataDir, "paddock.config.yaml");
      writeInstanceConfig(p, [
        { key: "keeperDriveMode", value: "batch" },
        { key: "selfMcpEnabled", value: true },
        { key: "recovery.autoReDrive", value: true },
      ]);
      const cfg = loadPaddockConfig();
      expect(cfg.keeperDriveMode).toBe("batch");
      expect(cfg.selfMcpEnabled).toBe(true);
      expect(cfg.recovery.autoReDrive).toBe(true);
    });

    it("deletes a key when the value is null (clear back to default)", () => {
      const p = path.join(dataDir, "paddock.config.yaml");
      writeInstanceConfig(p, [{ key: "sweepMinIntervalMs", value: 12345 }]);
      expect(loadPaddockConfig().sweepMinIntervalMs).toBe(12345);
      writeInstanceConfig(p, [{ key: "sweepMinIntervalMs", value: null }]);
      const raw = fs.readFileSync(p, "utf8");
      expect(raw).not.toContain("sweepMinIntervalMs");
      expect(loadPaddockConfig().sweepMinIntervalMs).toBeUndefined();
    });

    it("respects PADDOCK_CONFIG for the target path", () => {
      const explicit = path.join(dataDir, "nested", "custom.yaml");
      process.env.PADDOCK_CONFIG = explicit;
      // instanceConfigPath reads PADDOCK_CONFIG directly, so cfg.dataDir is moot.
      const p = instanceConfigPath({ dataDir } as never);
      expect(p).toBe(explicit);
      writeInstanceConfig(p, [{ key: "brand.name", value: "Explicit" }]);
      expect(fs.existsSync(explicit)).toBe(true);
      // The loader now reads the same explicit path back (file exists → no throw).
      expect(loadPaddockConfig().brand.name).toBe("Explicit");
    });
  });
});

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
import { DEFAULT_RECOVERY } from "../../src/recovery-config.js";
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

    it("does not mark a normal field overridden by a blank env var", () => {
      // For most knobs (envOr/envOpt semantics) a blank env var is not a shadow.
      process.env.PADDOCK_CURATION_OVERVIEW_MAX_TOKENS = "   ";
      const dto = buildInstanceConfig(loadPaddockConfig());
      expect(field(dto, "curation.overviewMaxTokens").envOverridden).toBe(false);
    });

    it("marks browserMcp overridden by a DEFINED-but-blank env var (matches loadBrowserMcp)", () => {
      // loadBrowserMcp keys off `env !== undefined`, so a defined-but-blank
      // PADDOCK_BROWSER_MCP forces browserMcp=false — the UI must render it
      // read-only, not as an editable toggle that would silently no-op.
      process.env.PADDOCK_BROWSER_MCP = "   ";
      const dto = buildInstanceConfig(loadPaddockConfig());
      const bm = field(dto, "browserMcp");
      expect(bm.value).toBe(false);
      expect(bm.envOverridden).toBe(true);
      expect(bm.envVar).toBe("PADDOCK_BROWSER_MCP");
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
      expect(dto.configVersion).toBeNull(); // no file yet
    });
  });

  /**
   * Issue #722. The DTO used to be built from the frozen boot config alone, so a
   * GET could not observe the file AT ALL — not even a write the same client had
   * just made. Every case here writes the file AFTER resolving the config, which
   * is exactly the runtime situation: a frozen process plus a file that has moved
   * on.
   */
  describe("pending (on-disk) values vs effective (frozen) values (#722)", () => {
    const writeFile = (body: string) =>
      fs.writeFileSync(path.join(dataDir, "paddock.config.yaml"), body, "utf8");

    it("reports the file's value as pendingValue and flags the divergence", () => {
      const cfg = loadPaddockConfig(); // boots with no file → defaults
      writeFile("curation:\n  overviewMaxTokens: 1234\nbrand:\n  name: AuditBrand\n");

      const dto = buildInstanceConfig(cfg);
      const overview = field(dto, "curation.overviewMaxTokens");
      expect(overview.value).toBe(2000); // still in force
      expect(overview.pendingValue).toBe(1234); // what a restart would load
      expect(overview.pendingRestart).toBe(true);
      expect(field(dto, "brand.name").pendingValue).toBe("AuditBrand");
      expect(dto.restartRequired).toBe(true);
      expect(dto.configVersion).toEqual(expect.any(String));
    });

    it("reports no divergence for a file that agrees with the process", () => {
      writeFile("curation:\n  overviewMaxTokens: 1234\n");
      const cfg = loadPaddockConfig(); // now boots WITH the file
      const dto = buildInstanceConfig(cfg);
      const overview = field(dto, "curation.overviewMaxTokens");
      expect(overview.value).toBe(1234);
      expect(overview.pendingValue).toBe(1234);
      expect(overview.pendingRestart).toBe(false);
      expect(dto.restartRequired).toBe(false);
    });

    it("treats a key the file omits as its built-in default (a cleared override)", () => {
      writeFile("recovery:\n  maxRetries: 7\n");
      const cfg = loadPaddockConfig();
      expect(field(buildInstanceConfig(cfg), "recovery.maxRetries").pendingValue).toBe(7);

      writeFile("recovery: {}\n"); // the operator cleared it (#723's null patch)
      const after = field(buildInstanceConfig(cfg), "recovery.maxRetries");
      expect(after.value).toBe(7); // still retrying 7× until restart
      expect(after.pendingValue).toBe(DEFAULT_RECOVERY.maxRetries);
      expect(after.pendingRestart).toBe(true);
    });

    it("does not manufacture divergence for unset or env-shadowed fields", () => {
      const cfg = loadPaddockConfig();
      writeFile("brand:\n  name: Only This Changed\n");
      const dto = buildInstanceConfig(cfg);
      // `models` is unset in both cfg and file: null there, catalog here. It must
      // not read as a permanent pending change.
      expect(field(dto, "models").pendingRestart).toBe(false);
      // Read-only bindings are normalised at boot (canonicalised paths, Number()
      // -ed port), so they are never compared against raw file text.
      expect(field(dto, "dataDir").pendingRestart).toBe(false);
      expect(field(dto, "brand.name").pendingRestart).toBe(true);
    });

    it("changes configVersion when the file changes", () => {
      const cfg = loadPaddockConfig();
      writeFile("brand:\n  name: One\n");
      const a = buildInstanceConfig(cfg).configVersion;
      writeFile("brand:\n  name: Two\n");
      const b = buildInstanceConfig(cfg).configVersion;
      expect(a).not.toBe(b);
    });

    it("surfaces a malformed file instead of silently reporting nothing pending", () => {
      const cfg = loadPaddockConfig();
      writeFile("brand:\n  name: [unterminated\n");
      const dto = buildInstanceConfig(cfg);
      expect(dto.configFileError).toMatch(/parse/);
      expect(dto.restartRequired).toBe(false);
      expect(field(dto, "brand.name").pendingValue).toBe(field(dto, "brand.name").value);
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
      expect(validatePatch({ driveMode: "batch" })).toEqual([
        { key: "driveMode", value: "batch" },
      ]);
      expect(validatePatch({ "brand.accent": "#abcdef" })).toEqual([
        { key: "brand.accent", value: "#abcdef" },
      ]);
    });
    it("rejects a bad enum / bad hex / bad drive mode", () => {
      expect(() => validatePatch({ driveMode: "turbo" })).toThrow(/one of/);
      expect(() => validatePatch({ "brand.accent": "red" })).toThrow(/hex color/);
      expect(() => validatePatch({ logLevel: "loud" })).toThrow(/one of/);
    });
    it("clears an optional field with null", () => {
      expect(validatePatch({ sweepMinIntervalMs: null })).toEqual([
        { key: "sweepMinIntervalMs", value: null },
      ]);
    });

    // Issue #723. `Number(null)` is 0, and 0 IS a valid non-negative integer, so
    // the documented "null clears this key" used to write a very meaningful
    // zero: `maxRetries: 0` disables recovery retries, `debounceMs: 0` removes
    // the debounce. The clear must produce `value: null` (the writer's delete).
    it("clears a nonNegInt field with null / empty string rather than writing 0 (#723)", () => {
      for (const key of ["recovery.debounceMs", "recovery.maxRetries"]) {
        expect(validatePatch({ [key]: null })).toEqual([{ key, value: null }]);
        expect(validatePatch({ [key]: "" })).toEqual([{ key, value: null }]);
      }
    });

    it("still accepts a real zero on a nonNegInt field (#723)", () => {
      // The clear must not cost the ability to deliberately SET zero.
      expect(validatePatch({ "recovery.debounceMs": 0 })).toEqual([
        { key: "recovery.debounceMs", value: 0 },
      ]);
      expect(validatePatch({ "recovery.maxRetries": 3 })).toEqual([
        { key: "recovery.maxRetries", value: 3 },
      ]);
    });

    // Same missing type check: `Number()` maps true→1, [7]→7, [] →0.
    it("rejects non-numeric types on numeric fields (#723)", () => {
      expect(() => validatePatch({ "curation.overviewMaxTokens": true })).toThrow(/positive integer/);
      expect(() => validatePatch({ "curation.overviewMaxTokens": [7] })).toThrow(/positive integer/);
      expect(() => validatePatch({ "recovery.debounceMs": false })).toThrow(/non-negative integer/);
      expect(() => validatePatch({ "recovery.maxRetries": [2] })).toThrow(/non-negative integer/);
      expect(() => validatePatch({ maxSpawnDepth: true })).toThrow(/non-negative integer/);
    });

    // Same hole as #723's, in the sibling validator: a null used to write depth
    // 0, which takes the self-MCP away from every child, for what the caller
    // meant as "restore the default".
    it("clears maxSpawnDepth with null rather than writing depth 0", () => {
      expect(validatePatch({ maxSpawnDepth: null })).toEqual([{ key: "maxSpawnDepth", value: null }]);
      expect(validatePatch({ maxSpawnDepth: 0 })).toEqual([{ key: "maxSpawnDepth", value: 0 }]);
      expect(validatePatch({ maxSpawnDepth: 3 })).toEqual([{ key: "maxSpawnDepth", value: 3 }]);
    });

    it("bounds numeric and string fields", () => {
      expect(() => validatePatch({ "curation.overviewMaxTokens": 1e12 })).toThrow(/at most/);
      expect(() => validatePatch({ "recovery.debounceMs": 1e12 })).toThrow(/up to/);
      expect(() => validatePatch({ "brand.name": "x".repeat(200_000) })).toThrow(/at most/);
      expect(() => validatePatch({ "transcription.endpoint": "y".repeat(5_000) })).toThrow(/at most/);
      // Still generous enough for anything deliberate.
      expect(validatePatch({ "brand.name": "A Perfectly Normal Box" })).toHaveLength(1);
    });

    // env > file > default: writing a shadowed field to the file can never take
    // effect, so a 200 + "restartRequired" was a lie the UI already knew better
    // than (it renders these read-only).
    it("rejects a field an env var currently shadows", () => {
      process.env.PADDOCK_BRAND_NAME = "From The Environment";
      expect(() => validatePatch({ "brand.name": "From The File" })).toThrow(
        /PADDOCK_BRAND_NAME/,
      );
      delete process.env.PADDOCK_BRAND_NAME;
      expect(validatePatch({ "brand.name": "From The File" })).toEqual([
        { key: "brand.name", value: "From The File" },
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
        { key: "driveMode", value: "batch" },
        { key: "selfMcpEnabled", value: true },
        { key: "recovery.autoReDrive", value: true },
      ]);
      const cfg = loadPaddockConfig();
      expect(cfg.driveMode).toBe("batch");
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

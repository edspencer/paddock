/**
 * `paddock config show` — grammar, provenance and rendering (#878).
 *
 * The provenance block is the substance. It resolves a REAL config through
 * `loadPaddockConfig` against a throwaway data dir rather than hand-building a
 * `PaddockConfig`, because the property under test is precisely that the report
 * agrees with the loader: a hand-built fixture could assert `source: "file"` for
 * a key the loader never actually reads.
 *
 * Every one of those cases starts from a SCRUBBED environment. This suite would
 * otherwise pass or fail depending on the machine — a dev box that exports
 * `PADDOCK_SELF_MCP` turns every "comes from the profile" assertion into "comes
 * from the environment", correctly, and the test would be wrong rather than the
 * code. The scrub list is derived from `FIELDS` instead of typed out, so a lever
 * added tomorrow is covered without anyone remembering this file.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  CliError,
  CONFIG_ACTIONS,
  CONFIG_USAGE,
  type Command,
  parseArgs,
  parseCommand,
} from "../../src/cli/args.js";
import { formatResolved, formatSummary, toJson } from "../../src/cli/config.js";
import {
  FIELDS,
  GROUPS,
  type ResolvedConfigField,
  type ResolvedConfigReport,
  resolveConfigReport,
} from "../../src/instance-config.js";
import { loadPaddockConfig } from "../../src/config.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

describe("paddock config: parseCommand (#878)", () => {
  it("parses the show action", () => {
    expect(parseCommand(["config", "show"])).toEqual({
      verb: "config",
      action: "show",
      opts: parseArgs([]),
    });
  });

  it("parses the config flags after the action", () => {
    const command = parseCommand([
      "config",
      "show",
      "--resolved",
      "--json",
      "--show-sensitive",
      "-d",
      "/tmp/pad",
    ]) as Extract<Command, { verb: "config" }>;
    expect(command.opts.resolved).toBe(true);
    expect(command.opts.json).toBe(true);
    expect(command.opts.showSensitive).toBe(true);
    expect(command.opts.dataDir).toBe("/tmp/pad");
  });

  /**
   * The reason the three flags are optional rather than defaulted booleans: this
   * shape is asserted structurally elsewhere, and it is the documented meaning of
   * "no flags were given". Adding always-present keys to it would change an
   * invocation that has nothing to do with `config`.
   */
  it("leaves the config flags absent when they are not given", () => {
    expect(parseArgs([])).toEqual({ open: false, verbose: false, help: false, version: false });
    expect(parseArgs([])).not.toHaveProperty("resolved");
  });

  it("names the actions when one is misspelled, rather than blaming a flag", () => {
    expect(() => parseCommand(["config", "shwo"])).toThrow(CliError);
    expect(() => parseCommand(["config", "shwo"])).toThrow(/unknown config action: shwo/);
    expect(() => parseCommand(["config", "shwo"])).toThrow(/Expected one of: show/);
  });

  it("requires an action, unless the request is for usage", () => {
    expect(() => parseCommand(["config"])).toThrow(/needs an action: show/);
    const helped = parseCommand(["config", "--help"]) as Extract<Command, { verb: "config" }>;
    expect(helped.action).toBeUndefined();
    expect(helped.opts.help).toBe(true);
  });

  it("does not disturb the other verbs", () => {
    expect(parseCommand(["start"])).toEqual({ verb: "start", opts: parseArgs([]) });
    expect(() => parseCommand(["service", "instal"])).toThrow(/unknown service action: instal/);
    // `config` is a verb only in first position, like every other one.
    expect(() => parseCommand(["start", "config"])).toThrow(/unknown option: config/);
  });

  it("documents every action it accepts", () => {
    for (const action of CONFIG_ACTIONS) expect(CONFIG_USAGE).toContain(`paddock config ${action}`);
  });
});

// --- provenance -------------------------------------------------------------

/**
 * Every variable that could make a field resolve from the environment, taken
 * from the descriptor table itself plus the two that steer resolution rather
 * than a single field.
 */
const ENV_KEYS = [
  ...new Set([
    ...FIELDS.flatMap((f) => f.envVars),
    "PADDOCK_PROFILE",
    "PADDOCK_CONFIG",
    "PADDOCK_DATA_DIR",
  ]),
];

describe("resolveConfigReport: which layer supplied each value (#878)", () => {
  let dataDir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(async () => {
    dataDir = await makeTmpDir("paddock-config-show-");
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.PADDOCK_DATA_DIR = dataDir;
  });
  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rmTmpDir(dataDir);
  });

  const writeConfig = (yaml: string): void =>
    fs.writeFileSync(path.join(dataDir, "paddock.config.yaml"), yaml, "utf8");

  const report = (): ResolvedConfigReport =>
    resolveConfigReport(loadPaddockConfig({ createDataDir: false }));

  const field = (r: ResolvedConfigReport, key: string): ResolvedConfigField => {
    const f = r.fields.find((x) => x.key === key);
    if (!f) throw new Error(`no such field: ${key}`);
    return f;
  };

  it("reports the profile for a posture key and the code default for everything else", () => {
    const r = report();
    expect(r.configFileExists).toBe(false);
    expect(r.profile).toEqual({ name: "balanced", source: "default" });

    // A posture key: the profile IS its default, so saying "default" would hide
    // the fact that another profile would change it.
    expect(field(r, "selfMcpEnabled")).toMatchObject({
      value: true,
      source: "profile",
      origin: "balanced",
    });
    expect(field(r, "claude.instructions")).toMatchObject({ value: "host", source: "profile" });
    // An operational key: no profile has an opinion about it.
    expect(field(r, "driveMode")).toMatchObject({ value: "session", source: "default" });
    expect(field(r, "recovery.maxRetries").source).toBe("default");
  });

  it("reports the value a field falls back to, not a bare null", () => {
    // `models` is undefined in the frozen config and MEANS "offer the whole
    // catalog"; printing null would be precision about the wrong thing.
    expect(field(report(), "models").value).toEqual(
      FIELDS.find((f) => f.key === "models")?.default,
    );
  });

  it("names PADDOCK_PROFILE when the environment picks the profile", () => {
    process.env.PADDOCK_PROFILE = "yolo";
    const r = report();
    expect(r.profile).toEqual({ name: "yolo", source: "env", origin: "PADDOCK_PROFILE" });
    expect(field(r, "browserMcp")).toMatchObject({ value: true, source: "profile", origin: "yolo" });
  });

  it("names the config file when the file picks the profile", () => {
    writeConfig("profile: paranoid\n");
    const r = report();
    expect(r.profile.source).toBe("file");
    expect(r.profile.name).toBe("paranoid");
    expect(field(r, "selfMcpEnabled").value).toBe(false);
  });

  /**
   * `resolveProfileName` falls back rather than failing the boot, which is right
   * for a boot and useless for a diagnostic — the typo would simply vanish and
   * the operator would be left wondering why `yolo` did nothing. Note also what
   * this pins: a bad `PADDOCK_PROFILE` does NOT fall through to the file's value.
   */
  it("surfaces a profile name that is not one of the three", () => {
    writeConfig("profile: yolo\n");
    process.env.PADDOCK_PROFILE = "paranoyd";
    const r = report();
    expect(r.profile.name).toBe("balanced");
    expect(r.profile.source).toBe("default");
    expect(r.profile.unrecognised).toEqual({ value: "paranoyd", origin: "PADDOCK_PROFILE" });
  });

  it("reports a key the config file sets", () => {
    writeConfig("driveMode: batch\nbrand:\n  name: QA Rig\n");
    const r = report();
    expect(field(r, "driveMode")).toMatchObject({ value: "batch", source: "file" });
    expect(field(r, "brand.name")).toMatchObject({ value: "QA Rig", source: "file" });
    expect(field(r, "brand.logo").source).toBe("default");
  });

  /**
   * The precedence wrinkle #878 introduces, and the reason a reader needs this
   * command: an individual FILE key beats `PADDOCK_PROFILE` in the environment,
   * inverting Paddock's otherwise universal env-beats-file rule.
   */
  it("shows a file key beating PADDOCK_PROFILE, and an env var beating the file", () => {
    writeConfig("claude:\n  hooks: host\n  mcpServers: own\n");
    process.env.PADDOCK_PROFILE = "paranoid";
    process.env.PADDOCK_CLAUDE_MCP_SERVERS = "host";
    const r = report();

    expect(field(r, "claude.hooks")).toMatchObject({ value: "host", source: "file" });
    expect(field(r, "claude.transcripts")).toMatchObject({ source: "profile", origin: "paranoid" });
    expect(field(r, "claude.mcpServers")).toMatchObject({
      value: "host",
      source: "env",
      origin: "PADDOCK_CLAUDE_MCP_SERVERS",
      shadowedFileValue: "own",
    });
  });

  it("reports a file value that an environment variable makes inert", () => {
    writeConfig("logLevel: debug\n");
    process.env.LOG_LEVEL = "warn";
    try {
      const f = field(report(), "logLevel");
      expect(f).toMatchObject({ value: "warn", source: "env", shadowedFileValue: "debug" });
    } finally {
      delete process.env.LOG_LEVEL;
    }
  });

  /**
   * The self-MCP cascade: write implies read, so `selfMcpEnabled: false` collapses
   * `selfMcpWriteEnabled` whatever the file says. The file value is real and has
   * no effect, which is exactly the state worth naming.
   */
  it("reports a file value another key's cascade makes inert", () => {
    writeConfig("selfMcpEnabled: false\nselfMcpWriteEnabled: true\n");
    const f = field(report(), "selfMcpWriteEnabled");
    expect(f.value).toBe(false);
    expect(f.source).not.toBe("file");
    expect(f.shadowedFileValue).toBe(true);
  });

  it("does not mistake boot normalisation for a value that failed to apply", () => {
    // A path is canonicalised and a scalar is stringified before parsing; neither
    // is a divergence, and reporting one would cry wolf on a working file.
    writeConfig(`port: "7300"\nprojectsRoot: ${path.join(dataDir, "elsewhere")}\n`);
    const r = report();
    expect(field(r, "port")).toMatchObject({ value: 7300, source: "file" });
    expect(field(r, "port").shadowedFileValue).toBeUndefined();
    expect(field(r, "projectsRoot").source).toBe("file");
    expect(field(r, "projectsRoot").shadowedFileValue).toBeUndefined();
  });

  it("carries the sensitive flag so a caller can decide what to print", () => {
    writeConfig("transcription:\n  endpoint: https://user:s3cr3t@whisper.example/v1\n");
    const f = field(report(), "transcription.endpoint");
    expect(f.sensitive).toBe(true);
    expect(f.value).toContain("s3cr3t");
  });

  /**
   * Inspecting an instance must not bring one into being. Without this, running
   * the command on a machine that has never started Paddock leaves an empty
   * `~/.paddock` behind and the first-run welcome never prints again.
   */
  it("does not create the data dir it reports on", async () => {
    const absent = path.join(dataDir, "never-created");
    process.env.PADDOCK_DATA_DIR = absent;
    expect(resolveConfigReport(loadPaddockConfig({ createDataDir: false })).dataDir).toBe(absent);
    expect(fs.existsSync(absent)).toBe(false);
    // The default is unchanged for every caller that goes on to run something.
    loadPaddockConfig();
    expect(fs.existsSync(absent)).toBe(true);
  });
});

// --- rendering --------------------------------------------------------------

function makeReport(over: Partial<ResolvedConfigReport> = {}): ResolvedConfigReport {
  const fields: ResolvedConfigField[] = [
    { key: "driveMode", group: "capabilities", label: "Drive mode", type: "enum", value: "session", source: "default", sensitive: false },
    { key: "selfMcpEnabled", group: "capabilities", label: "Self-MCP", type: "boolean", value: true, source: "profile", origin: "balanced", sensitive: false },
    { key: "brand.name", group: "branding", label: "Name", type: "string", value: "QA Rig", source: "file", origin: "/tmp/i/paddock.config.yaml", sensitive: false },
    { key: "logLevel", group: "logging", label: "Log level", type: "enum", value: "warn", source: "env", origin: "LOG_LEVEL", sensitive: false, shadowedFileValue: "debug" },
    { key: "transcription.endpoint", group: "transcription", label: "Endpoint", type: "string", value: "https://user:s3cr3t@whisper.example/v1", source: "file", origin: "/tmp/i/paddock.config.yaml", sensitive: true },
  ];
  return {
    dataDir: "/tmp/i",
    configPath: "/tmp/i/paddock.config.yaml",
    configFileExists: true,
    profile: { name: "balanced", source: "default" },
    fields,
    ...over,
  };
}

describe("paddock config show: rendering (#878)", () => {
  it("summarises only the decisions someone actually made", () => {
    const out = formatSummary(makeReport());
    expect(out).toContain("Set in the config file");
    expect(out).toContain("brand.name");
    expect(out).toContain("LOG_LEVEL");
    // The point of the default view: values nobody chose are not in it.
    expect(out).not.toContain("driveMode");
    expect(out).not.toContain("selfMcpEnabled");
    expect(out).toContain("Everything else follows the balanced profile");
    expect(out).toContain("paddock config show --resolved");
  });

  it("says so plainly when there is no config file", () => {
    const out = formatSummary(
      makeReport({ configFileExists: false, fields: makeReport().fields.filter((f) => f.source !== "file") }),
    );
    expect(out).toContain("(not present)");
    expect(out).toContain("(no config file)");
  });

  it("tells an operator when the file they edited is not in effect", () => {
    for (const out of [formatSummary(makeReport()), formatResolved(makeReport(), GROUPS, false)]) {
      expect(out).toContain("Set in the config file but NOT in effect");
      expect(out).toContain("file says debug — LOG_LEVEL wins for the same key");
    }
  });

  it("prints every field with its layer, and distinguishes profile from default", () => {
    const out = formatResolved(makeReport(), GROUPS, false);
    expect(out).toMatch(/driveMode\s+session\s+default/);
    expect(out).toMatch(/selfMcpEnabled\s+true\s+profile \(balanced\)/);
    expect(out).toMatch(/brand\.name\s+QA Rig\s+file/);
    expect(out).toMatch(/logLevel\s+warn\s+env LOG_LEVEL/);
  });

  it("legends only the layers that are actually present", () => {
    const only = makeReport({ fields: makeReport().fields.filter((f) => f.source === "default") });
    const out = formatResolved(only, GROUPS, false);
    expect(out).toContain("Paddock's built-in default");
    expect(out).not.toContain("profile (balanced)");
    expect(out).not.toContain("env NAME");
  });

  it("hides a sensitive value by default and reveals it on request", () => {
    const hidden = formatResolved(makeReport(), GROUPS, false);
    expect(hidden).not.toContain("s3cr3t");
    expect(hidden).toContain("(hidden)");
    // Provenance survives redaction: the row still says where to change it.
    expect(hidden).toMatch(/transcription\.endpoint\s+\(hidden\)\s+file/);

    const shown = formatResolved(makeReport(), GROUPS, true);
    expect(shown).toContain("s3cr3t");
  });

  it("redacts in JSON too — the flag is the only way through", () => {
    const redacted = JSON.parse(toJson(makeReport(), false)) as {
      fields: (ResolvedConfigField & { redacted?: boolean })[];
    };
    const endpoint = redacted.fields.find((f) => f.key === "transcription.endpoint");
    expect(endpoint).toMatchObject({ value: null, redacted: true, source: "file" });
    expect(toJson(makeReport(), false)).not.toContain("s3cr3t");
    expect(toJson(makeReport(), true)).toContain("s3cr3t");
  });

  it("reports an unrecognised profile name in the header", () => {
    const out = formatSummary(
      makeReport({
        profile: {
          name: "balanced",
          source: "default",
          unrecognised: { value: "paranoyd", origin: "PADDOCK_PROFILE" },
        },
      }),
    );
    expect(out).toContain('PADDOCK_PROFILE names "paranoyd"');
    expect(out).toContain("fell back to balanced");
  });
});

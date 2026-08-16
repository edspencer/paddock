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
import {
  buildEjectPlan,
  formatEjectPlan,
  formatResolved,
  formatSummary,
  toJson,
} from "../../src/cli/config.js";
import {
  FIELDS,
  GROUPS,
  type ResolvedConfigField,
  type ResolvedConfigReport,
  resolveConfigReport,
  writeInstanceConfig,
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
    { key: "driveMode", group: "capabilities", label: "Drive mode", type: "enum", value: "session", source: "default", sensitive: false, ejectable: true },
    { key: "selfMcpEnabled", group: "capabilities", label: "Self-MCP", type: "boolean", value: true, source: "profile", origin: "balanced", sensitive: false, ejectable: true },
    { key: "brand.name", group: "branding", label: "Name", type: "string", value: "QA Rig", source: "file", origin: "/tmp/i/paddock.config.yaml", sensitive: false, ejectable: true },
    { key: "logLevel", group: "logging", label: "Log level", type: "enum", value: "warn", source: "env", origin: "LOG_LEVEL", sensitive: false, ejectable: true, shadowedFileValue: "debug" },
    { key: "transcription.endpoint", group: "transcription", label: "Endpoint", type: "string", value: "https://user:s3cr3t@whisper.example/v1", source: "file", origin: "/tmp/i/paddock.config.yaml", sensitive: true, ejectable: false },
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

// --- eject ------------------------------------------------------------------

describe("paddock config eject: grammar (#878)", () => {
  it("parses the eject action and its flags", () => {
    expect(parseCommand(["config", "eject"])).toEqual({
      verb: "config",
      action: "eject",
      opts: parseArgs([]),
    });
    const cmd = parseCommand([
      "config",
      "eject",
      "--write",
      "--include-env",
    ]) as Extract<Command, { verb: "config" }>;
    expect(cmd.opts.write).toBe(true);
    expect(cmd.opts.includeEnv).toBe(true);
  });

  /** Same reason the show flags are optional: `parseArgs([])` is asserted structurally. */
  it("leaves the eject flags absent when they are not given", () => {
    expect(parseArgs([])).not.toHaveProperty("write");
    expect(parseArgs([])).not.toHaveProperty("includeEnv");
  });

  it("names eject among the actions when one is misspelled", () => {
    expect(() => parseCommand(["config", "ejcet"])).toThrow(/Expected one of: show, eject/);
  });
});

describe("buildEjectPlan: what gets frozen, and what deliberately does not (#878)", () => {
  const plan = (over: Partial<ResolvedConfigReport> = {}, includeEnv = false) =>
    buildEjectPlan(makeReport(over), includeEnv);

  it("freezes profile- and default-sourced values, and says which layer each came from", () => {
    const p = plan();
    expect(p.entries.map((e) => e.key)).toEqual(["driveMode", "selfMcpEnabled"]);
    expect(p.entries[1]).toMatchObject({ source: "profile", origin: "balanced", action: "add" });
  });

  /**
   * The load-bearing refusal. An env var BEATS the file, so writing its value in
   * changes nothing today and changes the instance the day the variable is
   * unset — a deferred, silent transfer of a decision out of the environment.
   */
  it("skips a value the environment supplies, naming the variable that owns it", () => {
    const p = plan();
    expect(p.entries.find((e) => e.key === "logLevel")).toBeUndefined();
    expect(p.skipped).toContainEqual({ key: "logLevel", reason: "env", origin: "LOG_LEVEL" });
  });

  it("writes env-supplied values only when explicitly asked", () => {
    const p = plan({}, true);
    expect(p.entries.find((e) => e.key === "logLevel")).toMatchObject({
      value: "warn",
      source: "env",
      // The file says `debug` and it is inert; freezing replaces a false claim.
      action: "change",
      fileValue: "debug",
    });
  });

  it("never bulk-writes a sensitive field, flag or no flag", () => {
    for (const p of [plan(), plan({}, true)]) {
      expect(p.entries.find((e) => e.key === "transcription.endpoint")).toBeUndefined();
      expect(p.skipped).toContainEqual({ key: "transcription.endpoint", reason: "sensitive" });
    }
  });

  it("leaves a key the file already sets and already wins with untouched", () => {
    const p = plan();
    expect(p.keptFromFile).toEqual(["brand.name"]);
    expect(p.pairs.find((x) => x.key === "brand.name")).toBeUndefined();
  });

  it("skips an optional nothing has set rather than writing a null", () => {
    const fields = [
      ...makeReport().fields,
      { key: "sweepMinIntervalMs", group: "sweeper", label: "Min sweep", type: "number" as const, value: null, source: "default" as const, sensitive: false, ejectable: true },
    ];
    const p = plan({ fields });
    expect(p.skipped).toContainEqual({ key: "sweepMinIntervalMs", reason: "unset" });
    // `writeInstanceConfig` reads null as DELETE, so emitting one would be wrong
    // as well as meaningless.
    expect(p.pairs.some((x) => x.value === null)).toBe(false);
  });

  /**
   * The argued exception to the env rule. After a full eject `profile:` governs
   * no key that exists — every one is explicit — so writing it cannot change a
   * current value. Its only effect is on a lever added LATER, which without this
   * line would resolve against the built-in default profile rather than the
   * posture actually ejected.
   */
  it("writes profile: first, even when the environment chose it", () => {
    const p = plan({ profile: { name: "yolo", source: "env", origin: "PADDOCK_PROFILE" } });
    expect(p.profile.write).toBe(true);
    expect(p.pairs[0]).toEqual({ key: "profile", value: "yolo" });
  });

  it("does not rewrite profile: when the file already names it", () => {
    const p = plan({ profile: { name: "paranoid", source: "file", origin: "/tmp/i/c.yaml" } });
    expect(p.profile.write).toBe(false);
    expect(p.pairs.find((x) => x.key === "profile")).toBeUndefined();
  });

  /** A typo resolves to the fallback, so eject freezes the posture in effect — and corrects it. */
  it("freezes the profile that actually resolved, not an unrecognised name", () => {
    const p = plan({
      profile: {
        name: "balanced",
        source: "default",
        unrecognised: { value: "paranoyd", origin: "PADDOCK_PROFILE" },
      },
    });
    expect(p.pairs[0]).toEqual({ key: "profile", value: "balanced" });
  });
});

describe("paddock config eject: rendering (#878)", () => {
  it("previews without promising a write, and states the cost", () => {
    const out = formatEjectPlan(buildEjectPlan(makeReport()), GROUPS, false);
    expect(out).toContain("eject preview");
    expect(out).toContain("Would write");
    expect(out).toContain("Nothing was written. Re-run with --write to apply.");
    // #878 requires the tradeoff at the point of use, not only in the docs.
    expect(out).toContain("What you give up");
    expect(out).toContain("stops following Paddock's defaults");
  });

  it("switches tense once the write has happened", () => {
    const out = formatEjectPlan(buildEjectPlan(makeReport()), GROUPS, true);
    expect(out).toContain("Wrote ");
    expect(out).not.toContain("Would write");
    expect(out).not.toContain("Re-run with --write");
  });

  it("explains each refusal where the operator will read it", () => {
    const out = formatEjectPlan(buildEjectPlan(makeReport()), GROUPS, false);
    expect(out).toContain("Not written");
    expect(out).toContain("--include-env");
    expect(out).toMatch(/logLevel\s+LOG_LEVEL/);
    expect(out).toContain("marked sensitive");
  });

  it("never prints a sensitive value, even though the report carries one", () => {
    expect(formatEjectPlan(buildEjectPlan(makeReport()), GROUPS, false)).not.toContain("s3cr3t");
  });

  it("reads as an answer, not an empty write, when there is nothing left to do", () => {
    const fields = makeReport().fields.map((f) =>
      f.ejectable ? { ...f, source: "file" as const } : f,
    );
    const out = formatEjectPlan(
      buildEjectPlan(makeReport({ fields, profile: { name: "balanced", source: "file" } })),
      GROUPS,
      false,
    );
    expect(out).toContain("Nothing to write");
    expect(out).not.toContain("Would write 0");
  });
});

/**
 * The property the whole command rests on: an ejected file resolves to exactly
 * what the instance resolved before it was written. Run through the REAL loader
 * and the REAL writer against a throwaway data dir, because a hand-built report
 * could not catch the failure that matters — a key written under a path the
 * loader does not actually read, which would silently revert to its default.
 */
describe("eject round-trip: the file resolves to what it froze (#878)", () => {
  let dataDir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(async () => {
    dataDir = await makeTmpDir("paddock-config-eject-");
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

  const configPath = (): string => path.join(dataDir, "paddock.config.yaml");
  const report = (): ResolvedConfigReport =>
    resolveConfigReport(loadPaddockConfig({ createDataDir: false }));
  const values = (r: ResolvedConfigReport): Record<string, unknown> =>
    Object.fromEntries(r.fields.map((f) => [f.key, f.value]));

  /** Eject for real, the way `runConfig` does it. */
  const eject = (includeEnv = false): void => {
    const plan = buildEjectPlan(report(), includeEnv);
    writeInstanceConfig(configPath(), plan.pairs);
  };

  for (const profile of ["paranoid", "balanced", "yolo"] as const) {
    it(`preserves every effective value under ${profile}`, () => {
      process.env.PADDOCK_PROFILE = profile;
      const before = values(report());
      eject();

      // Drop the variable that chose the posture: the file must now stand on
      // its own. This is what the `profile:` line and the explicit posture keys
      // are FOR, and nothing else in the suite would notice if it regressed.
      delete process.env.PADDOCK_PROFILE;
      const after = report();
      expect(values(after)).toEqual(before);
      expect(after.profile).toMatchObject({ name: profile, source: "file" });
    });
  }

  it("moves the posture levers from the profile layer into the file", () => {
    const before = report();
    expect(before.fields.filter((f) => f.source === "profile").length).toBeGreaterThan(0);
    eject();
    const after = report();
    expect(after.fields.filter((f) => f.source === "profile")).toEqual([]);
    expect(after.fields.filter((f) => f.source === "file").length).toBeGreaterThan(10);
  });

  it("is idempotent — a second eject has nothing left to write", () => {
    eject();
    const once = fs.readFileSync(configPath(), "utf8");
    expect(buildEjectPlan(report()).pairs).toEqual([]);
    eject();
    expect(fs.readFileSync(configPath(), "utf8")).toBe(once);
  });

  it("preserves comments and keys Paddock does not manage", () => {
    fs.writeFileSync(
      configPath(),
      "# hand-written\nprofile: paranoid\n\n# mine, not Paddock's\nmyOwnNote: keep me\n",
      "utf8",
    );
    const before = values(report());
    eject();
    const raw = fs.readFileSync(configPath(), "utf8");
    expect(raw).toContain("# hand-written");
    expect(raw).toContain("# mine, not Paddock's");
    expect(raw).toContain("myOwnNote: keep me");
    expect(values(report())).toEqual(before);
  });

  /**
   * An env var still beats the file afterwards, so skipping it cannot change
   * what resolves — which is what makes the refusal safe rather than merely
   * defensible. Pinned because the opposite (writing it) would ALSO pass a
   * naive round-trip check, and only diverge once the variable went away.
   */
  it("leaves an env-supplied value out of the file, without changing what resolves", () => {
    process.env.PADDOCK_BRAND_NAME = "QA Rig";
    const before = values(report());
    eject();
    expect(fs.readFileSync(configPath(), "utf8")).not.toContain("QA Rig");
    expect(values(report())).toEqual(before);

    // And with the variable gone, the file does NOT assert the env's value.
    delete process.env.PADDOCK_BRAND_NAME;
    expect(report().fields.find((f) => f.key === "brand.name")?.value).toBe("Paddock");
  });

  it("writes an env-supplied value when asked, and then it survives the variable", () => {
    process.env.PADDOCK_BRAND_NAME = "QA Rig";
    eject(true);
    delete process.env.PADDOCK_BRAND_NAME;
    expect(report().fields.find((f) => f.key === "brand.name")).toMatchObject({
      value: "QA Rig",
      source: "file",
    });
  });

  it("never writes a sensitive value, and leaves the file's own copy alone", () => {
    fs.writeFileSync(
      configPath(),
      "transcription:\n  mode: remote\n  endpoint: https://user:s3cr3t@whisper.example/v1\n",
      "utf8",
    );
    const before = values(report());
    eject();
    const raw = fs.readFileSync(configPath(), "utf8");
    expect(raw.match(/s3cr3t/g)).toHaveLength(1); // the operator's line, untouched
    expect(values(report())).toEqual(before);
  });

  /** No `dataDir:` self-reference, no port — an ejected file has to stay portable. */
  it("writes no machine-specific binding", () => {
    eject();
    const raw = fs.readFileSync(configPath(), "utf8");
    for (const key of ["dataDir", "projectsRoot", "stateDir", "webDist", "port", "host"]) {
      expect(raw).not.toContain(`${key}:`);
    }
    expect(raw).not.toContain(dataDir);
  });

  it("replaces a file value that is not in effect with the one that is", () => {
    // The self-MCP cascade: write implies read, so this `true` is inert.
    fs.writeFileSync(configPath(), "selfMcpEnabled: false\nselfMcpWriteEnabled: true\n", "utf8");
    const entry = buildEjectPlan(report()).entries.find((e) => e.key === "selfMcpWriteEnabled");
    expect(entry).toMatchObject({ value: false, action: "change", fileValue: true });
    eject();
    expect(report().fields.find((f) => f.key === "selfMcpWriteEnabled")).toMatchObject({
      value: false,
      source: "file",
    });
  });
});

/**
 * Config profiles (#878) — the posture presets and how they resolve.
 *
 * Two of these tests are load-bearing beyond their own assertion:
 *
 * - **"paranoid is exactly the legacy defaults"** pins the promise that choosing
 *   `paranoid` is a no-op for anyone who was relying on paddock's historical
 *   code defaults. It compares against the `DEFAULT_*` constants the lever
 *   modules still export, so if one of those moves and the profile does not, the
 *   promise breaks loudly here rather than quietly in someone's instance.
 * - **"every profile covers exactly the posture surface"** is the forward-looking
 *   one from the issue: when a new capability lever is added, this fails until
 *   all three profiles declare a value for it. Without it a new toggle just gets
 *   a code default and the postures silently drift out of date.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  PROFILES,
  PROFILE_NAMES,
  POSTURE_KEYS,
  DEFAULT_PROFILE,
  isKnownProfile,
  resolveProfileName,
} from "../../src/profiles.js";
import { loadPaddockConfig } from "../../src/config.js";
import { buildInstanceConfig } from "../../src/instance-config.js";
import { DEFAULT_MAX_SPAWN_DEPTH } from "../../src/spawn-capability.js";
import { DEFAULT_TRANSCRIPTS_MODE } from "../../src/transcripts.js";
import { DEFAULT_CREDENTIALS_MODE } from "../../src/claude-credentials.js";
import { DEFAULT_INSTRUCTIONS_MODE } from "../../src/claude-instructions.js";
import { DEFAULT_HOOKS_MODE } from "../../src/claude-settings.js";
import { DEFAULT_MCP_SERVERS_MODE } from "../../src/claude-mcp.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

describe("profiles: the posture surface", () => {
  it("every profile covers exactly the posture surface — no more, no less", () => {
    const expected = [...POSTURE_KEYS].sort();
    for (const name of PROFILE_NAMES) {
      expect(Object.keys(PROFILES[name]).sort(), `profile ${name}`).toEqual(expected);
    }
  });

  it("paranoid is exactly paddock's legacy code defaults (choosing it is a no-op)", () => {
    expect(PROFILES.paranoid).toEqual({
      transcripts: DEFAULT_TRANSCRIPTS_MODE,
      credentials: DEFAULT_CREDENTIALS_MODE,
      instructions: DEFAULT_INSTRUCTIONS_MODE,
      hooks: DEFAULT_HOOKS_MODE,
      mcpServers: DEFAULT_MCP_SERVERS_MODE,
      maxSpawnDepth: DEFAULT_MAX_SPAWN_DEPTH,
      selfMcpEnabled: false,
      selfMcpWriteEnabled: false,
      selfMcpProjectsEnabled: false,
      scheduleMutationEnabled: false,
      hooksMcpEnabled: false,
      browserMcp: false,
    });
  });

  it("capability is monotonic: anything on in paranoid stays on in balanced and yolo", () => {
    // Not a style rule — a profile that turned a capability OFF as you moved up
    // the ladder would make "more permissive" meaningless. `credentials: host`
    // in paranoid is the one that makes this non-trivial: it must not regress to
    // `own` in the profiles above it.
    for (const key of POSTURE_KEYS) {
      if (key === "maxSpawnDepth") {
        expect(PROFILES.balanced.maxSpawnDepth).toBeGreaterThanOrEqual(
          PROFILES.paranoid.maxSpawnDepth,
        );
        expect(PROFILES.yolo.maxSpawnDepth).toBeGreaterThanOrEqual(
          PROFILES.balanced.maxSpawnDepth,
        );
        continue;
      }
      const rank = (v: string | boolean | number) => (v === "host" || v === true ? 1 : 0);
      expect(rank(PROFILES.balanced[key]), `${key}: balanced vs paranoid`).toBeGreaterThanOrEqual(
        rank(PROFILES.paranoid[key]),
      );
      expect(rank(PROFILES.yolo[key]), `${key}: yolo vs balanced`).toBeGreaterThanOrEqual(
        rank(PROFILES.balanced[key]),
      );
    }
  });

  it("yolo leaves bind and auth alone — they are not posture keys", () => {
    // The guardrail from #878: "yolo" must never quietly become "yolo, reachable
    // from the whole network". Asserted as absence from the surface, so adding
    // one to a profile fails here as well as in the coverage test.
    for (const k of ["host", "port", "auth", "dangerouslyAllowOpen", "dataDir"]) {
      expect(POSTURE_KEYS as readonly string[]).not.toContain(k);
    }
  });
});

describe("profiles: resolveProfileName", () => {
  it("defaults to balanced when neither file nor env says anything", () => {
    expect(resolveProfileName(undefined, {})).toBe("balanced");
    expect(DEFAULT_PROFILE).toBe("balanced");
  });

  it("reads the file value, case-insensitively, and trims it", () => {
    expect(resolveProfileName("yolo", {})).toBe("yolo");
    expect(resolveProfileName("  PARANOID  ", {})).toBe("paranoid");
  });

  it("PADDOCK_PROFILE overrides the file value", () => {
    expect(resolveProfileName("paranoid", { PADDOCK_PROFILE: "yolo" })).toBe("yolo");
  });

  it("an unknown name falls back to the default rather than failing the boot", () => {
    // The fallback direction is safe here in a way it is not for a single lever:
    // a typo can only ever land on the same posture a config-less instance
    // already has, never on `yolo`.
    expect(resolveProfileName("balanaced", {})).toBe("balanced");
    expect(resolveProfileName("", { PADDOCK_PROFILE: "YOLO!" })).toBe("balanced");
    expect(isKnownProfile("strict")).toBe(false);
  });
});

describe("profiles: resolution through loadPaddockConfig (#878)", () => {
  // Every var that can reach an assertion below — including the bind/auth ones,
  // which are NOT posture keys but which the "yolo leaves them alone" test reads.
  // A dev box that exports `HOST` or `PADDOCK_AUTH_MODE` for its own server (this
  // one does) otherwise fails that test for a reason unrelated to the diff.
  const ENV_KEYS = [
    "PADDOCK_DATA_DIR",
    "PADDOCK_CONFIG",
    "PADDOCK_PROFILE",
    "HOST",
    "PADDOCK_HOST",
    "PADDOCK_AUTH_MODE",
    "PADDOCK_DANGEROUSLY_ALLOW_OPEN",
    "PADDOCK_CLAUDE_TRANSCRIPTS",
    "PADDOCK_CLAUDE_CREDENTIALS",
    "PADDOCK_CLAUDE_INSTRUCTIONS",
    "PADDOCK_CLAUDE_HOOKS",
    "PADDOCK_CLAUDE_MCP_SERVERS",
    "PADDOCK_MAX_SPAWN_DEPTH",
    "PADDOCK_SELF_MCP",
    "PADDOCK_SELF_MCP_WRITE",
    "PADDOCK_SELF_MCP_PROJECTS",
    "PADDOCK_SCHEDULE_MUTATION",
    "PADDOCK_HOOKS_MCP",
    "PADDOCK_BROWSER_MCP",
  ];

  let dataDir: string;
  let saved: Record<string, string | undefined>;

  const writeConfig = (body: string): string => {
    const p = path.join(dataDir, "paddock.config.yaml");
    fs.writeFileSync(p, body, "utf8");
    return p;
  };

  beforeEach(async () => {
    dataDir = await makeTmpDir("paddock-profile-");
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

  it("no config and no env resolves the balanced posture (#878 default flip)", () => {
    const cfg = loadPaddockConfig();
    expect(cfg.profile).toBe("balanced");
    expect(cfg.claude).toEqual({
      transcripts: "host",
      credentials: "host",
      instructions: "host",
      hooks: "own",
      mcpServers: "host",
    });
    expect(cfg.selfMcpEnabled).toBe(true);
    expect(cfg.selfMcpWriteEnabled).toBe(false);
    expect(cfg.maxSpawnDepth).toBe(1);
    expect(cfg.browserMcp).toBe(false);
  });

  it("profile: paranoid restores the pre-#878 behaviour exactly", () => {
    writeConfig("profile: paranoid\n");
    const cfg = loadPaddockConfig();
    expect(cfg.profile).toBe("paranoid");
    expect(cfg.claude).toEqual({
      transcripts: "own",
      credentials: "host",
      instructions: "own",
      hooks: "own",
      mcpServers: "own",
    });
    expect(cfg.selfMcpEnabled).toBe(false);
    expect(cfg.hooksMcpEnabled).toBe(false);
    expect(cfg.scheduleMutationEnabled).toBe(false);
    expect(cfg.browserMcp).toBe(false);
    expect(cfg.maxSpawnDepth).toBe(1);
  });

  it("profile: yolo turns the whole posture on, and still leaves bind/auth alone", () => {
    writeConfig("profile: yolo\n");
    const cfg = loadPaddockConfig();
    expect(cfg.claude.hooks).toBe("host");
    expect(cfg.selfMcpEnabled).toBe(true);
    expect(cfg.selfMcpWriteEnabled).toBe(true);
    expect(cfg.selfMcpProjectsEnabled).toBe(true);
    expect(cfg.scheduleMutationEnabled).toBe(true);
    expect(cfg.hooksMcpEnabled).toBe(true);
    expect(cfg.browserMcp).toBe(true);
    expect(cfg.maxSpawnDepth).toBe(2);
    // The guardrail, asserted on the resolved config and not just the preset.
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.auth.mode).toBe("none");
    expect(cfg.dangerouslyAllowOpen).toBe(false);
  });

  it("PADDOCK_PROFILE overrides the file's profile key", () => {
    writeConfig("profile: paranoid\n");
    process.env.PADDOCK_PROFILE = "yolo";
    expect(loadPaddockConfig().profile).toBe("yolo");
  });

  it("an individual FILE key beats PADDOCK_PROFILE — specific beats general", () => {
    // The deliberate inversion of this codebase's env-beats-file rule, and the
    // case most likely to surprise: a container sets the profile in env, a
    // mounted file names one lever. The named lever wins; everything the file is
    // silent about still comes from the env profile.
    writeConfig("claude:\n  hooks: host\n");
    process.env.PADDOCK_PROFILE = "paranoid";
    const cfg = loadPaddockConfig();
    expect(cfg.profile).toBe("paranoid");
    expect(cfg.claude.hooks).toBe("host");
    // ...and the levers the file did NOT mention still follow paranoid.
    expect(cfg.claude.transcripts).toBe("own");
    expect(cfg.selfMcpEnabled).toBe(false);
  });

  it("an individual ENV var still beats the same key in the file", () => {
    // Env-beats-file is untouched for the SAME key — only profile-vs-key inverts.
    writeConfig("profile: yolo\nclaude:\n  hooks: host\n");
    process.env.PADDOCK_CLAUDE_HOOKS = "own";
    expect(loadPaddockConfig().claude.hooks).toBe("own");
  });

  it("an explicit selfMcpEnabled: false under yolo collapses write and projects too", () => {
    // The #467 cascade, exercised against a profile rather than a bare config:
    // the three self-MCP gates AND together, so overriding the outermost one has
    // to take the inner two down with it.
    writeConfig("profile: yolo\nselfMcpEnabled: false\n");
    const cfg = loadPaddockConfig();
    expect(cfg.selfMcpEnabled).toBe(false);
    expect(cfg.selfMcpWriteEnabled).toBe(false);
    expect(cfg.selfMcpProjectsEnabled).toBe(false);
    // A sibling capability outside the cascade is untouched — the control.
    expect(cfg.scheduleMutationEnabled).toBe(true);
  });

  it("an unknown profile name in the file boots on the default posture", () => {
    writeConfig("profile: strict\n");
    const cfg = loadPaddockConfig();
    expect(cfg.profile).toBe("balanced");
    expect(cfg.selfMcpEnabled).toBe(true);
  });

  it("the Config screen reports the PROFILE's default, and sees no pending restart", () => {
    // `default` on the instance-config DTO is what the screen shows as "the
    // default" AND what pendingRestart is computed against. A file that simply
    // omits a posture key agrees with the profile, so it must not read as a
    // pending change — which a hardcoded `default: false` would.
    writeConfig("profile: yolo\n");
    const dto = buildInstanceConfig(loadPaddockConfig());
    const field = (key: string) =>
      dto.groups.flatMap((g) => g.fields).find((f) => f.key === key)!;

    expect(field("selfMcpEnabled").default).toBe(true);
    expect(field("maxSpawnDepth").default).toBe(2);
    expect(field("claude.hooks").default).toBe("host");
    expect(dto.restartRequired).toBe(false);
    expect(field("selfMcpEnabled").pendingRestart).toBe(false);

    // The control: a non-posture field still reports its own static default.
    expect(field("nativeSystemPrompt").default).toBe(true);
  });

  it("PADDOCK_BROWSER_MCP keeps its literal-'1' semantics over a profile", () => {
    // The one lever whose env var does not use the 1/true/yes convention: any
    // other set value disables. `true` must still mean OFF, even under yolo.
    writeConfig("profile: yolo\n");
    process.env.PADDOCK_BROWSER_MCP = "true";
    expect(loadPaddockConfig().browserMcp).toBe(false);
    process.env.PADDOCK_BROWSER_MCP = "1";
    expect(loadPaddockConfig().browserMcp).toBe(true);
  });
});

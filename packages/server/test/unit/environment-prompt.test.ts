/**
 * The environment system prompt (issue #635) — the small append that tells a
 * keeper it renders into a browser as GFM rather than into a terminal.
 *
 * Three layers are covered here, because the failure modes are different at each:
 *
 *  1. **Resolution** (`loadPaddockConfig`) — env over file over built-in, where
 *     "blank" is a MEANING (opt out) and not an absence. Every other key in
 *     config.ts folds blank to its default; this one must not.
 *  2. **Round-trip** (`validatePatch` + `writeInstanceConfig` + reload) — an
 *     operator's text goes through YAML and must come back byte-for-byte,
 *     including colons, quotes, backticks, trailing newlines and non-ASCII.
 *  3. **Delivery** (`HerdctlService`) — the resolved text is handed to herdctl as
 *     `systemPromptAppend` on EVERY turn path, and is omitted entirely when the
 *     instance opted out.
 *
 * Layer 3 is the one that matters: a field that saves but never reaches the model
 * is the exact bug this issue exists to fix. The end-to-end proof that it reaches
 * the spawned process argv lives in `test/integration/environment-prompt.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadPaddockConfig, type PaddockConfig } from "../../src/config.js";
import { DEFAULT_ENVIRONMENT_PROMPT } from "../../src/environment-prompt.js";
import {
  buildInstanceConfig,
  validatePatch,
  writeInstanceConfig,
  InstanceConfigError,
  FIELDS,
} from "../../src/instance-config.js";
import { HerdctlService } from "../../src/herdctl.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

const TOUCHED = ["PADDOCK_CONFIG", "PADDOCK_ENVIRONMENT_PROMPT", "PADDOCK_DATA_DIR"];

describe("environment prompt (#635)", () => {
  let dataDir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(async () => {
    dataDir = await makeTmpDir("paddock-envprompt-");
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

  const writeYaml = (body: string) => {
    const p = path.join(dataDir, "paddock.config.yaml");
    fs.writeFileSync(p, body, "utf8");
    process.env.PADDOCK_CONFIG = p;
    return p;
  };

  // --- 1. resolution --------------------------------------------------------

  describe("resolution (env > file > built-in)", () => {
    it("defaults to the built-in prompt when nothing is set", () => {
      expect(loadPaddockConfig().environmentPrompt).toBe(DEFAULT_ENVIRONMENT_PROMPT);
    });

    it("the built-in prompt states the two audited rules", () => {
      // Not a prose assertion — these are the two findings the issue's evidence
      // pass justified, and a silent edit that drops one should fail loudly.
      expect(DEFAULT_ENVIRONMENT_PROMPT).toContain("mcp__paddock__send_file");
      expect(DEFAULT_ENVIRONMENT_PROMPT).toContain("#123");
      expect(DEFAULT_ENVIRONMENT_PROMPT).toContain("GitHub-Flavored");
    });

    it("a file value replaces the built-in prompt", () => {
      writeYaml("environmentPrompt: Be brief.\n");
      expect(loadPaddockConfig().environmentPrompt).toBe("Be brief.");
    });

    it("an EMPTY file value opts out — it does not fall back to the default", () => {
      writeYaml('environmentPrompt: ""\n');
      expect(loadPaddockConfig().environmentPrompt).toBe("");
    });

    it("env beats the file", () => {
      writeYaml("environmentPrompt: from-file\n");
      process.env.PADDOCK_ENVIRONMENT_PROMPT = "from-env";
      expect(loadPaddockConfig().environmentPrompt).toBe("from-env");
    });

    it("a DEFINED-but-blank env var is the env-level opt-out, even over a file value", () => {
      writeYaml("environmentPrompt: from-file\n");
      process.env.PADDOCK_ENVIRONMENT_PROMPT = "";
      expect(loadPaddockConfig().environmentPrompt).toBe("");
    });

    it("a bare `environmentPrompt:` (YAML null) is ignored rather than stringified", () => {
      // `String(null)` would be the literal text "null" — never what an operator
      // meant by leaving the key dangling.
      writeYaml("environmentPrompt:\n");
      expect(loadPaddockConfig().environmentPrompt).toBe(DEFAULT_ENVIRONMENT_PROMPT);
    });

    it("keeps whitespace verbatim — no trimming", () => {
      process.env.PADDOCK_ENVIRONMENT_PROMPT = "  padded  \n";
      expect(loadPaddockConfig().environmentPrompt).toBe("  padded  \n");
    });
  });

  // --- 2. the settings surface + YAML round-trip ----------------------------

  describe("instance-config surface", () => {
    const spec = FIELDS.find((f) => f.key === "environmentPrompt")!;

    it("is an editable capabilities field rendered as multi-line text", () => {
      expect(spec.group).toBe("capabilities");
      expect(spec.type).toBe("text");
      expect(spec.editable).toBe(true);
      // Shadowing must key on definedness, since blank is the opt-out.
      expect(spec.envShadowWhenDefined).toBe(true);
      expect(spec.default).toBe(DEFAULT_ENVIRONMENT_PROMPT);
    });

    it("reports the effective text as its value, and reports env shadowing", () => {
      const plain = buildInstanceConfig(loadPaddockConfig())
        .groups.flatMap((g) => g.fields)
        .find((f) => f.key === "environmentPrompt")!;
      expect(plain.value).toBe(DEFAULT_ENVIRONMENT_PROMPT);
      expect(plain.envOverridden).toBe(false);

      process.env.PADDOCK_ENVIRONMENT_PROMPT = "";
      const shadowed = buildInstanceConfig(loadPaddockConfig())
        .groups.flatMap((g) => g.fields)
        .find((f) => f.key === "environmentPrompt")!;
      expect(shadowed.value).toBe("");
      // A blank var really does win, so the UI must render it read-only.
      expect(shadowed.envOverridden).toBe(true);
      expect(shadowed.envVar).toBe("PADDOCK_ENVIRONMENT_PROMPT");
    });

    it("accepts an empty string (opt out) and null (restore the default)", () => {
      expect(validatePatch({ environmentPrompt: "" })).toEqual([
        { key: "environmentPrompt", value: "" },
      ]);
      expect(validatePatch({ environmentPrompt: null })).toEqual([
        { key: "environmentPrompt", value: null },
      ]);
    });

    it("does NOT trim — leading/trailing whitespace is prompt content", () => {
      expect(validatePatch({ environmentPrompt: "\n  hi  \n" })).toEqual([
        { key: "environmentPrompt", value: "\n  hi  \n" },
      ]);
    });

    it("rejects a non-string, a NUL byte, and an absurdly long value", () => {
      expect(() => validatePatch({ environmentPrompt: 42 })).toThrow(InstanceConfigError);
      expect(() => validatePatch({ environmentPrompt: "a\0b" })).toThrow(/NUL/);
      expect(() => validatePatch({ environmentPrompt: "x".repeat(32 * 1024 + 1) })).toThrow(
        /at most/,
      );
      // …but the bound is generous enough for any real prompt.
      expect(() => validatePatch({ environmentPrompt: "x".repeat(32 * 1024) })).not.toThrow();
    });

    it("round-trips YAML-hostile text byte-for-byte through the file", () => {
      // Every character class that has ever broken a YAML round-trip, in one
      // value: a key-looking line, colons, both quote flavours, backticks, a
      // leading '#', an em-dash + emoji, a tab, and a trailing newline.
      const hostile = [
        "notAKey: but it looks like one",
        '"quoted" and \'single\' and `backticked`',
        "# not a comment — a heading",
        "a: b: c — 90% ✅ 日本語",
        "\ttab-indented",
        "",
      ].join("\n");

      const configPath = path.join(dataDir, "paddock.config.yaml");
      writeInstanceConfig(configPath, validatePatch({ environmentPrompt: hostile }));
      process.env.PADDOCK_CONFIG = configPath;

      expect(loadPaddockConfig().environmentPrompt).toBe(hostile);
    });

    it("round-trips several KB of text", () => {
      const long = Array.from({ length: 200 }, (_, i) => `line ${i}: ${"lorem ipsum ".repeat(4)}`)
        .join("\n");
      expect(long.length).toBeGreaterThan(10_000);

      const configPath = path.join(dataDir, "paddock.config.yaml");
      writeInstanceConfig(configPath, validatePatch({ environmentPrompt: long }));
      process.env.PADDOCK_CONFIG = configPath;

      expect(loadPaddockConfig().environmentPrompt).toBe(long);
    });

    it("a null patch DELETES the key, restoring the built-in default", () => {
      const configPath = path.join(dataDir, "paddock.config.yaml");
      writeInstanceConfig(configPath, validatePatch({ environmentPrompt: "custom" }));
      process.env.PADDOCK_CONFIG = configPath;
      expect(loadPaddockConfig().environmentPrompt).toBe("custom");

      writeInstanceConfig(configPath, validatePatch({ environmentPrompt: null }));
      expect(fs.readFileSync(configPath, "utf8")).not.toContain("environmentPrompt");
      expect(loadPaddockConfig().environmentPrompt).toBe(DEFAULT_ENVIRONMENT_PROMPT);
    });
  });

  // --- 3. delivery ----------------------------------------------------------

  describe("delivery to the runtime", () => {
    /**
     * A HerdctlService over a fake fleet that records what each turn path asks
     * herdctl for. `openChatSession` rejects on purpose: we only care about the
     * options it was CALLED with, and failing fast keeps the test clear of the
     * stream-consumption machinery that would follow a real session.
     */
    function svcWithRecordingFleet(environmentPrompt: string, nativeSystemPrompt = false) {
      const triggerOpts: Record<string, unknown>[] = [];
      const sessionOpts: Record<string, unknown>[] = [];
      const svc = new HerdctlService({ environmentPrompt, nativeSystemPrompt } as PaddockConfig);
      (svc as unknown as { fleet: unknown }).fleet = {
        trigger: vi.fn(async (_a: string, _s: unknown, o: Record<string, unknown>) => {
          triggerOpts.push(o);
          return { jobId: "j", success: true };
        }),
        openChatSession: vi.fn(async (_a: string, o: Record<string, unknown>) => {
          sessionOpts.push(o);
          throw new Error("stop here — the call is what we're asserting");
        }),
      };
      return { svc, triggerOpts, sessionOpts };
    }

    it("passes the resolved prompt on the batch path when it will be APPENDED", async () => {
      // nativeSystemPrompt: false ⇒ the agent carries its own system_prompt, so
      // core's CLI runtime concatenates the two into one --system-prompt.
      const { svc, triggerOpts } = svcWithRecordingFleet(DEFAULT_ENVIRONMENT_PROMPT, false);
      await svc.chat("keeper-demo", { prompt: "hi" });
      expect(triggerOpts[0].systemPromptAppend).toBe(DEFAULT_ENVIRONMENT_PROMPT);
    });

    it("withholds it on the batch path when it would REPLACE the native preset", async () => {
      // The trap: herdctl's CLI runtime has no --append-system-prompt, and with
      // no agent.system_prompt to concatenate onto it would pass our two-rule
      // note as the agent's ENTIRE system prompt. Losing an environment hint is
      // survivable; losing Claude Code's coding preset is not.
      const { svc, triggerOpts, sessionOpts } = svcWithRecordingFleet(
        DEFAULT_ENVIRONMENT_PROMPT,
        true,
      );
      await svc.chat("keeper-demo", { prompt: "hi" });
      expect(triggerOpts[0].systemPromptAppend).toBeUndefined();

      // …but the SDK/session path (the default, and what every chat uses) is
      // unaffected: it folds the text into the preset's `append` field.
      await svc.chatSession("keeper-demo", { prompt: "hi" });
      expect(sessionOpts[0].systemPromptAppend).toBe(DEFAULT_ENVIRONMENT_PROMPT);
    });

    it("passes the resolved prompt on the session path (chatSession)", async () => {
      const { svc, sessionOpts } = svcWithRecordingFleet(DEFAULT_ENVIRONMENT_PROMPT);
      const res = await svc.chatSession("keeper-demo", { prompt: "hi" });
      expect(res.success).toBe(false); // the fake session refused to open
      expect(sessionOpts[0].systemPromptAppend).toBe(DEFAULT_ENVIRONMENT_PROMPT);
    });

    it("passes the resolved prompt on the slash-command path (runCommand)", async () => {
      const { svc, sessionOpts } = svcWithRecordingFleet(DEFAULT_ENVIRONMENT_PROMPT);
      await svc.runCommand("keeper-demo", { command: "/compact" }).catch(() => undefined);
      expect(sessionOpts[0].systemPromptAppend).toBe(DEFAULT_ENVIRONMENT_PROMPT);
    });

    it("passes a custom override verbatim", async () => {
      const custom = "Speak only in haiku.\n";
      const { svc, sessionOpts } = svcWithRecordingFleet(custom);
      await svc.chatSession("keeper-demo", { prompt: "hi" });
      expect(sessionOpts[0].systemPromptAppend).toBe(custom);
    });

    it("omits the option entirely when the instance opted out", async () => {
      // Not `""` — undefined, so herdctl's `if (options.systemPromptAppend)`
      // leaves the system prompt untouched and the turn is byte-identical to
      // pre-#635 behaviour.
      const { svc, sessionOpts, triggerOpts } = svcWithRecordingFleet("", false);
      await svc.chatSession("keeper-demo", { prompt: "hi" });
      await svc.chat("keeper-demo", { prompt: "hi" });
      expect(sessionOpts[0].systemPromptAppend).toBeUndefined();
      expect(triggerOpts[0].systemPromptAppend).toBeUndefined();
    });
  });
});

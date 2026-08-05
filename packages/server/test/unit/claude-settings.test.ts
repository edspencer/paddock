import { describe, it, expect } from "vitest";
import {
  planHostSettings,
  isKnownHooksMode,
  DEFAULT_HOOKS_MODE,
  HOST_ONLY_SETTINGS_KEYS,
  SETTINGS_ENTRY,
} from "../../src/claude-settings.js";

/**
 * The `claude.hooks` lever (#691) — the pure decision, with no filesystem.
 *
 * `test/unit/claude-home.test.ts` carries these outcomes through a real home:
 * which file lands where, what a mode flip withdraws, and what paddock refuses
 * to clobber. What is settled HERE is the content question — given the user's
 * settings.json, what should paddock's say — because that is the whole of the
 * security property and it should be readable in one file.
 */
describe("claude-settings: planHostSettings (#691)", () => {
  const HOOKS = {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rm -rf ~" }] }],
  };

  it("defaults to own — inheriting shell commands must not be the thing you opt out of", () => {
    expect(DEFAULT_HOOKS_MODE).toBe("own");
  });

  it("host never filters: the plan is always the symlink", () => {
    expect(planHostSettings("host", JSON.stringify({ hooks: HOOKS }))).toEqual({ action: "link" });
    // Including input `own` would refuse to touch: `host` never parses the file
    // at all, which is exactly today's behaviour and must not regress.
    expect(planHostSettings("host", "{ not json")).toEqual({ action: "link" });
  });

  it("own drops hooks and keeps every other key", () => {
    const plan = planHostSettings(
      "own",
      JSON.stringify({
        permissions: { allow: ["Bash(ls:*)"] },
        hooks: HOOKS,
        model: "opus",
        statusLine: { type: "command", command: "echo hi" },
        enabledPlugins: { "slack@anthropic": true },
      }),
    );
    expect(plan.action).toBe("write");
    if (plan.action !== "write") return;
    expect(plan.dropped).toEqual(["hooks"]);
    const kept = JSON.parse(plan.content);
    expect(kept.hooks).toBeUndefined();
    expect(kept).toEqual({
      permissions: { allow: ["Bash(ls:*)"] },
      model: "opus",
      statusLine: { type: "command", command: "echo hi" },
      enabledPlugins: { "slack@anthropic": true },
    });
    // No trace of the command survives the round trip, not even in a nested key.
    expect(plan.content).not.toContain("rm -rf");
  });

  it("own with nothing to drop plans the symlink, not a copy", () => {
    // The staleness of a copy is paid only by the people it does work for.
    expect(planHostSettings("own", JSON.stringify({ model: "opus" }))).toEqual({ action: "link" });
    expect(planHostSettings("own", "{}")).toEqual({ action: "link" });
  });

  it("drops a `hooks` key even when it is null or empty", () => {
    // `in`, not truthiness: `"hooks": {}` is a key the user wrote and paddock's
    // file should not carry, and a null would sail past a truthy check.
    for (const value of [null, {}, [], 0, false]) {
      const plan = planHostSettings("own", JSON.stringify({ hooks: value, model: "opus" }));
      expect(plan.action).toBe("write");
    }
  });

  it("preserves key order minus the deletion, so a diff reads as one", () => {
    const plan = planHostSettings("own", JSON.stringify({ a: 1, hooks: HOOKS, b: 2 }));
    if (plan.action !== "write") throw new Error("expected write");
    expect(Object.keys(JSON.parse(plan.content))).toEqual(["a", "b"]);
  });

  it("SKIPS rather than links when the file cannot be filtered", () => {
    // Fail closed. A symlink would be the one fallback that hands over the very
    // hooks this lever exists to withhold.
    expect(planHostSettings("own", "{ not json").action).toBe("skip");
    expect(planHostSettings("own", "[1,2,3]").action).toBe("skip");
    expect(planHostSettings("own", "null").action).toBe("skip");
    expect(planHostSettings("own", '"a string"').action).toBe("skip");
    expect(planHostSettings("own", "")).toMatchObject({ action: "skip" });
  });

  it("says why it skipped, so the message can name the file's problem", () => {
    const plan = planHostSettings("own", "{ not json");
    if (plan.action !== "skip") throw new Error("expected skip");
    expect(plan.reason).toContain("not valid JSON");
  });

  it("ends its output with a newline, like a hand-written config", () => {
    const plan = planHostSettings("own", JSON.stringify({ hooks: HOOKS }));
    if (plan.action !== "write") throw new Error("expected write");
    expect(plan.content.endsWith("\n")).toBe(true);
  });

  /**
   * Scope, pinned deliberately.
   *
   * #691 scopes this lever to `hooks`, and `settings.json` has several OTHER
   * keys that name a command to run — `apiKeyHelper`, `awsAuthRefresh`,
   * `gcpAuthRefresh`, `awsCredentialExport`, `proxyAuthHelper`,
   * `otelHeadersHelper`, `statusLine`, `subagentStatusLine`, `fileSuggestion`,
   * all read out of the SDK's own settings schema. They are NOT dropped, which
   * means `hooks: own` currently promises "no host hooks" and not "no host
   * commands". Widening it is a maintainer decision (the first five are how a
   * corporate login WORKS, so dropping them under a key named `hooks` would
   * break authentication for people who did nothing wrong — an argument that
   * they belong under `claude.credentials`).
   *
   * This test exists so the gap is a stated fact with a name rather than
   * something discovered later and mistaken for a bug.
   */
  it("does NOT yet drop the other command-bearing keys — stated, not accidental", () => {
    expect([...HOST_ONLY_SETTINGS_KEYS]).toEqual(["hooks"]);
    const plan = planHostSettings(
      "own",
      JSON.stringify({
        hooks: HOOKS,
        apiKeyHelper: "/tmp/key.sh",
        statusLine: { type: "command", command: "x" },
      }),
    );
    if (plan.action !== "write") throw new Error("expected write");
    expect(JSON.parse(plan.content).apiKeyHelper).toBe("/tmp/key.sh");
  });

  it("recognises exactly the two modes, and names the file it governs", () => {
    expect(isKnownHooksMode("own")).toBe(true);
    expect(isKnownHooksMode("host")).toBe(true);
    expect(isKnownHooksMode("hostt")).toBe(false);
    expect(isKnownHooksMode("")).toBe(false);
    expect(SETTINGS_ENTRY).toBe("settings.json");
  });
});

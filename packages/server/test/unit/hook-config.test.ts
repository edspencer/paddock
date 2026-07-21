/**
 * Event-hook config helpers (Epic G / G1).
 *
 * These pure functions are the seam between a project's `project.yaml` hooks and the
 * `hook-<slug>-<name>` herdctl agent each hook registers as: sanitise a hand-edited
 * map (dropping malformed entries so one bad edit can't brick `addAgent`), project a
 * capability set onto the exact herdctl agent tool-config fields, (the surviving shared
 * foundation the unified trigger system reuses).
 */
import { describe, it, expect } from "vitest";
import {
  sanitizeHook,
  sanitizeHooks,
  sanitizeCapabilities,
  hookToAgentToolConfig,
  isValidHookName,
  resolveHooksMcpEnabled,
  mergeHookUpdate,
  HOOK_DEFAULT_MAX_TURNS,
} from "../../src/hook-config.js";

describe("sanitizeHook", () => {
  it("accepts a well-formed onArchive hook with capabilities", () => {
    expect(
      sanitizeHook({
        event: "onArchive",
        capabilities: { allowedTools: ["Bash"], maxTurns: 12 },
        promptFile: "cleanup.md",
        enabled: true,
      }),
    ).toEqual({
      event: "onArchive",
      capabilities: { allowedTools: ["Bash"], maxTurns: 12 },
      promptFile: "cleanup.md",
      enabled: true,
    });
  });

  it("accepts a tool-less hook (no capabilities) with an inline prompt", () => {
    expect(sanitizeHook({ event: "onArchive", prompt: "note the archive" })).toEqual({
      event: "onArchive",
      prompt: "note the archive",
    });
  });

  it("preserves an explicit empty inline prompt and enabled:false", () => {
    expect(sanitizeHook({ event: "onArchive", prompt: "", enabled: false })).toEqual({
      event: "onArchive",
      prompt: "",
      enabled: false,
    });
  });

  it("drops a hook with an unknown/absent event", () => {
    expect(sanitizeHook({ event: "onProjectDelete", prompt: "x" })).toBeNull();
    expect(sanitizeHook({ prompt: "x" })).toBeNull();
    expect(sanitizeHook({ event: 123 })).toBeNull();
    expect(sanitizeHook(null)).toBeNull();
    expect(sanitizeHook("nope")).toBeNull();
    expect(sanitizeHook([])).toBeNull();
  });

  it("trims a promptFile and drops a blank one", () => {
    expect(sanitizeHook({ event: "onArchive", promptFile: "  c.md " })).toEqual({
      event: "onArchive",
      promptFile: "c.md",
    });
    expect(sanitizeHook({ event: "onArchive", promptFile: "   " })).toEqual({
      event: "onArchive",
    });
  });
});

describe("sanitizeCapabilities", () => {
  it("normalises tool lists, permission mode, model and maxTurns", () => {
    expect(
      sanitizeCapabilities({
        allowedTools: ["Bash", "  Read  ", 42, ""],
        deniedTools: ["WebFetch"],
        permissionMode: "acceptEdits",
        model: "  claude-haiku-4-5-20251001 ",
        maxTurns: 8.9,
      }),
    ).toEqual({
      allowedTools: ["Bash", "Read"],
      deniedTools: ["WebFetch"],
      permissionMode: "acceptEdits",
      model: "claude-haiku-4-5-20251001",
      maxTurns: 8,
    });
  });

  it("drops an unknown permission mode and a non-positive maxTurns", () => {
    expect(sanitizeCapabilities({ permissionMode: "yolo", maxTurns: 0 })).toBeUndefined();
    expect(sanitizeCapabilities({ maxTurns: -5 })).toBeUndefined();
  });

  it("returns undefined for empty / non-object", () => {
    expect(sanitizeCapabilities({})).toBeUndefined();
    expect(sanitizeCapabilities(null)).toBeUndefined();
    expect(sanitizeCapabilities([])).toBeUndefined();
  });
});

describe("sanitizeHooks", () => {
  it("keeps good entries and drops malformed ones + bad names", () => {
    const out = sanitizeHooks({
      cleanup: { event: "onArchive", capabilities: { allowedTools: ["Bash"] } },
      broken: { event: "nope" }, // unknown event → dropped
      "bad name": { event: "onArchive" }, // invalid name → dropped
      note: { event: "onArchive", prompt: "hi" },
    });
    expect(Object.keys(out ?? {}).sort()).toEqual(["cleanup", "note"]);
  });

  it("returns undefined when nothing survives / not a map", () => {
    expect(sanitizeHooks(undefined)).toBeUndefined();
    expect(sanitizeHooks({})).toBeUndefined();
    expect(sanitizeHooks({ broken: { event: "nope" } })).toBeUndefined();
    expect(sanitizeHooks([])).toBeUndefined();
  });
});

describe("isValidHookName", () => {
  it("accepts safe names, rejects spaces / traversal / overlong", () => {
    expect(isValidHookName("cleanup")).toBe(true);
    expect(isValidHookName("spin_down.2")).toBe(true);
    expect(isValidHookName("has space")).toBe(false);
    expect(isValidHookName("../evil")).toBe(false);
    expect(isValidHookName("x".repeat(65))).toBe(false);
    expect(isValidHookName("")).toBe(false);
  });
});

describe("resolveHooksMcpEnabled (G5)", () => {
  it("a boolean override wins over the instance default", () => {
    expect(resolveHooksMcpEnabled(true, false)).toBe(true);
    expect(resolveHooksMcpEnabled(false, true)).toBe(false);
  });
  it("an absent override inherits the instance default", () => {
    expect(resolveHooksMcpEnabled(undefined, true)).toBe(true);
    expect(resolveHooksMcpEnabled(undefined, false)).toBe(false);
  });
});

describe("mergeHookUpdate (G5 partial set_hook)", () => {
  const existing = {
    event: "onArchive" as const,
    capabilities: { allowedTools: ["Bash"], maxTurns: 12 },
    prompt: "spin down servers",
    enabled: true,
  };

  it("a brand-new hook (no existing) uses the incoming record + defaults enabled:false", () => {
    expect(mergeHookUpdate(null, { event: "onArchive", prompt: "x" })).toEqual({
      event: "onArchive",
      prompt: "x",
      enabled: false,
    });
  });

  it("honors an explicit enabled on a brand-new hook", () => {
    expect(mergeHookUpdate(undefined, { event: "onArchive", prompt: "x", enabled: true })).toEqual({
      event: "onArchive",
      prompt: "x",
      enabled: true,
    });
  });

  it("preserves capabilities + enabled when an update changes only the prompt (Warren's bug)", () => {
    // The reported failure: edit only the prompt → capabilities must NOT be wiped.
    expect(mergeHookUpdate(existing, { event: "onArchive", prompt: "new prompt" })).toEqual({
      event: "onArchive",
      capabilities: { allowedTools: ["Bash"], maxTurns: 12 },
      prompt: "new prompt",
      enabled: true,
    });
  });

  it("a supplied capabilities set REPLACES the existing one (caller gave a new grant)", () => {
    expect(
      mergeHookUpdate(existing, { event: "onArchive", capabilities: { allowedTools: ["Read"] } }),
    ).toEqual({
      event: "onArchive",
      capabilities: { allowedTools: ["Read"] },
      prompt: "spin down servers",
      enabled: true,
    });
  });

  it("an omitted enabled preserves the existing armed state (doesn't silently disarm)", () => {
    const out = mergeHookUpdate(existing, { event: "onArchive", prompt: "p" });
    expect(out.enabled).toBe(true);
    const out2 = mergeHookUpdate({ ...existing, enabled: false }, { event: "onArchive", prompt: "p" });
    expect(out2.enabled).toBe(false);
  });

  it("carries promptFile through when the existing hook uses one", () => {
    const withFile = { event: "onArchive" as const, promptFile: "cleanup.md", enabled: false };
    expect(mergeHookUpdate(withFile, { event: "onArchive", enabled: true })).toEqual({
      event: "onArchive",
      promptFile: "cleanup.md",
      enabled: true,
    });
  });

  it("switching a file-backed hook to an inline prompt CLEARS the stale promptFile", () => {
    // Warren #2: prompt & promptFile are mutually exclusive (file wins). An inline
    // edit that omits prompt_file must not leave the old file winning.
    const fileHook = { event: "onArchive" as const, promptFile: "cleanup.md", enabled: true };
    const out = mergeHookUpdate(fileHook, { event: "onArchive", prompt: "do it inline" });
    expect(out).toEqual({ event: "onArchive", prompt: "do it inline", enabled: true });
    expect(out.promptFile).toBeUndefined();
  });

  it("switching an inline hook to a promptFile CLEARS the stale inline prompt", () => {
    const inlineHook = { event: "onArchive" as const, prompt: "old inline", enabled: false };
    const out = mergeHookUpdate(inlineHook, { event: "onArchive", promptFile: "cleanup.md" });
    expect(out).toEqual({ event: "onArchive", promptFile: "cleanup.md", enabled: false });
    expect(out.prompt).toBeUndefined();
  });

  it("a capability/enabled-only edit (neither prompt supplied) leaves the prompt source intact", () => {
    const fileHook = { event: "onArchive" as const, promptFile: "cleanup.md", enabled: false };
    const out = mergeHookUpdate(fileHook, {
      event: "onArchive",
      capabilities: { allowedTools: ["Bash"] },
      enabled: true,
    });
    expect(out).toEqual({
      event: "onArchive",
      promptFile: "cleanup.md",
      capabilities: { allowedTools: ["Bash"] },
      enabled: true,
    });
  });
});

describe("hookToAgentToolConfig", () => {
  it("projects a capability set onto herdctl agent fields", () => {
    expect(
      hookToAgentToolConfig({
        allowedTools: ["Bash", "Read"],
        deniedTools: ["WebFetch"],
        permissionMode: "acceptEdits",
        model: "claude-haiku-4-5-20251001",
        maxTurns: 12,
      }),
    ).toEqual({
      allowed_tools: ["Bash", "Read"],
      denied_tools: ["WebFetch"],
      permission_mode: "acceptEdits",
      model: "claude-haiku-4-5-20251001",
      max_turns: 12,
    });
  });

  it("a tool-less hook (no capabilities) gets allowed_tools: [] and the default max_turns", () => {
    expect(hookToAgentToolConfig(undefined)).toEqual({
      allowed_tools: [],
      max_turns: HOOK_DEFAULT_MAX_TURNS,
    });
  });

  it("never inherits a broad toolset — allowed_tools is always set explicitly", () => {
    const out = hookToAgentToolConfig({ permissionMode: "default" });
    expect(out.allowed_tools).toEqual([]);
    expect(out).not.toHaveProperty("model");
    expect(out).not.toHaveProperty("denied_tools");
  });
});

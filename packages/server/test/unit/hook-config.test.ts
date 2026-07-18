/**
 * Event-hook config helpers (Epic G / G1).
 *
 * These pure functions are the seam between a project's `project.yaml` hooks and the
 * `hook-<slug>-<name>` herdctl agent each hook registers as: sanitise a hand-edited
 * map (dropping malformed entries so one bad edit can't brick `addAgent`), project a
 * capability set onto the exact herdctl agent tool-config fields, and resolve a
 * `promptFile` to a safe absolute path under `.paddock/hooks/`.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  sanitizeHook,
  sanitizeHooks,
  sanitizeCapabilities,
  hookToAgentToolConfig,
  hookPromptFileAbsPath,
  isValidHookName,
  HOOK_PROMPT_DIR,
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

describe("hookPromptFileAbsPath", () => {
  const wd = "/tmp/proj";
  const base = path.join(wd, HOOK_PROMPT_DIR);

  it("resolves a bare .md name under .paddock/hooks/", () => {
    expect(hookPromptFileAbsPath(wd, "cleanup.md")).toBe(path.join(base, "cleanup.md"));
    expect(hookPromptFileAbsPath(wd, "sub/deep.md")).toBe(path.join(base, "sub/deep.md"));
  });

  it("rejects traversal, absolute paths, and non-.md files", () => {
    expect(hookPromptFileAbsPath(wd, "../../etc/passwd")).toBeNull();
    expect(hookPromptFileAbsPath(wd, "../secret.md")).toBeNull();
    expect(hookPromptFileAbsPath(wd, "/etc/passwd.md")).toBeNull();
    expect(hookPromptFileAbsPath(wd, "cleanup.txt")).toBeNull();
    expect(hookPromptFileAbsPath(wd, "")).toBeNull();
  });
});

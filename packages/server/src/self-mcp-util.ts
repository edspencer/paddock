/**
 * Pure helpers + numeric caps for the Paddock self-management MCP (issue #214).
 *
 * These are the deliberately-testable primitives the handler factories build on:
 * the `ok`/`fail` result envelopes, `errText` normalisation, the read_chat
 * tail/limit + per-message truncation clamps, and the arg-coercion helpers that
 * tolerate the CLI-runtime MCP transport dropping array-typed args. Several are
 * unit-test-exported and re-exported from `self-mcp.ts` for the public surface.
 */
import type { McpToolCallResult } from "@herdctl/core";
import { MODELS, isKnownModel } from "./models.js";

/** fork_chat_batch: hard cap on how many forks a single fan-out call may spawn. */
export const FORK_BATCH_MAX = 20;

/** read_chat: default and hard-cap on how many trailing messages to return. */
export const READ_CHAT_DEFAULT_LIMIT = 30;
export const READ_CHAT_MAX_LIMIT = 200;
/** read_chat: per-message character cap so one huge message can't flood the result. */
export const READ_CHAT_MAX_TEXT = 2000;

export function ok(payload: unknown): McpToolCallResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

export function fail(text: string): McpToolCallResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Clamp a caller-supplied limit into [1, MAX], defaulting when absent/invalid. */
export function clampLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return READ_CHAT_DEFAULT_LIMIT;
  const n = Math.floor(raw);
  if (n < 1) return 1;
  if (n > READ_CHAT_MAX_LIMIT) return READ_CHAT_MAX_LIMIT;
  return n;
}

/** Truncate a single message's text with an explicit marker. */
export function truncateText(text: string): string {
  if (text.length <= READ_CHAT_MAX_TEXT) return text;
  const omitted = text.length - READ_CHAT_MAX_TEXT;
  return `${text.slice(0, READ_CHAT_MAX_TEXT)}… [truncated ${omitted} chars]`;
}

/**
 * Validate the optional `model` argument on the spawn tools (create_chat /
 * fork_chat / fork_chat_batch, issue #336) against the SAME picker allow-list the
 * web model-picker uses ({@link isKnownModel}). Returns `{}` when absent/blank (the
 * spawned chat inherits the project/box default, the unchanged behaviour), `{ model }`
 * for a recognised id, or an error STRING (listing the valid ids) for a non-blank
 * unknown id — the handler turns that into an `isError` tool result so the agent
 * gets an actionable message rather than a silently-ignored override.
 */
export function resolveModelArg(raw: unknown): { model?: string } | string {
  if (typeof raw !== "string") return {};
  const m = raw.trim();
  if (m.length === 0) return {};
  if (!isKnownModel(m)) {
    return `Error: unknown model "${m}". Valid models: ${MODELS.map((x) => x.id).join(", ")}.`;
  }
  return { model: m };
}

/**
 * Normalize the `prompts` argument to a string array. The CLI-runtime MCP path
 * has proven unreliable at carrying an ARRAY-typed argument to the tool handler
 * (string args work; the array arrives dropped) — so we ALSO accept the list as a
 * string: a JSON array (`["a","b"]`) or newline-separated directives. Returns []
 * when nothing usable is present (handler then reports the required-arg error).
 */
export function coercePrompts(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((p) => (typeof p === "string" ? p : "")).map((p) => p.trim());
  }
  if (typeof raw === "string") {
    const s = raw.trim();
    if (s.length === 0) return [];
    if (s.startsWith("[")) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) {
          return parsed.map((p) => (typeof p === "string" ? p : "")).map((p) => p.trim());
        }
      } catch {
        /* fall through to newline split */
      }
    }
    return s
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
  return [];
}

/**
 * Normalize a tool-list argument (a hook's `allowed_tools`/`denied_tools`) to a
 * string array. Like {@link coercePrompts}, tolerant of the CLI-runtime MCP
 * transport dropping ARRAY-typed args: accepts a real array, a JSON array string,
 * or a comma/newline-separated string (tool names never contain commas). Blanks
 * are dropped; returns [] when nothing usable is present (a tool-less hook).
 */
export function coerceToolList(raw: unknown): string[] {
  const clean = (arr: unknown[]): string[] =>
    arr.map((t) => (typeof t === "string" ? t.trim() : "")).filter((t) => t.length > 0);
  if (Array.isArray(raw)) return clean(raw);
  if (typeof raw === "string") {
    const s = raw.trim();
    if (s.length === 0) return [];
    if (s.startsWith("[")) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return clean(parsed);
      } catch {
        /* fall through to delimiter split */
      }
    }
    return clean(s.split(/[\n,]/));
  }
  return [];
}

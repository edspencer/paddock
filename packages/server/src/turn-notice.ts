/**
 * Turn-notice classification (issue #329)
 *
 * A keeper turn can end without producing a normal assistant reply, and today
 * those endings are INVISIBLE in the UI — the chat just looks dead. Two families:
 *
 *   1. A **synthetic** runtime message. The Claude Code CLI answers a turn it
 *      cannot really run with an assistant message tagged `model:"<synthetic>"`
 *      and `stop_reason:"stop_sequence"`. The most important one on this box is
 *      the shared Max-plan quota: `"You've hit your session limit · resets …"`.
 *      The interleaved `"No response requested."` placeholders are the runtime
 *      declining its own follow-up turns under the limit. `@herdctl/chat`'s
 *      translator DROPS every synthetic message (so no text ever streams), and
 *      `@herdctl/core`'s history parser drops them too — hence the silent stop.
 *
 *   2. A terminal **error result**. The Claude Agent SDK ends a turn with a
 *      `type:"result"` message whose `subtype`/`is_error` mark a failure:
 *      `error_max_turns` (the turn hit its max-turns cap and wrote NOTHING
 *      renderable to the transcript), `error_during_execution`, an API/overload
 *      error, etc.
 *
 * This module turns either signal into a small {@link TurnNotice} DTO that the
 * live path (`ws.ts` per-message inspection) and the history-hydration path
 * (`scanTranscriptNotice`) both surface to the client as a distinct notice turn.
 * Pure + unit-tested; no I/O except {@link scanTranscriptNotice}.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/** Sentinel model the CLI stamps on its synthetic placeholder turns. Mirrors
 *  `@herdctl/chat`'s `SYNTHETIC_MODEL` (kept local to avoid a value import churn). */
export const SYNTHETIC_MODEL = "<synthetic>";

/** The three notice families a dead-ended turn resolves to. */
export type TurnNoticeKind = "usage_limit" | "error" | "max_turns";

/**
 * A surfaced turn-ending condition. `message` is the one-line human summary the
 * banner shows; `resetTime` (usage-limit only) is the parsed "resets …" clause;
 * `retryable` says whether offering a Continue/Retry affordance is safe (a usage
 * limit is NOT retryable — it only clears when the quota resets).
 */
export interface TurnNotice {
  kind: TurnNoticeKind;
  message: string;
  /** Usage-limit only: the reset clause, e.g. `"7:10pm (America/New_York)"`. */
  resetTime?: string;
  /** Optional secondary detail (e.g. the raw SDK error subtype / message). */
  detail?: string;
  /** Whether a Continue/Retry affordance is safe to offer for this notice. */
  retryable: boolean;
}

/** Loosely-typed shape of the fields we read off an SDK message / JSONL entry. */
interface RawMessage {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  success?: boolean;
  message?: { role?: string; model?: string; content?: unknown; stop_reason?: string };
}

/** Flatten an assistant `content` (string, or an array of text blocks) to text. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
        ? (b as { text: string }).text
        : ""))
      .join("");
  }
  return "";
}

/**
 * Classify a synthetic assistant message's text.
 *
 * Returns a `usage_limit` {@link TurnNotice} for a "session/usage limit" message
 * (with the reset clause parsed out), the sentinel `"declined"` for the
 * runtime's own `"No response requested."` (and any other non-limit synthetic —
 * a placeholder the UI should simply suppress, never render), or `null` for
 * empty text.
 */
export function classifySyntheticText(text: string): TurnNotice | "declined" | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // The shared Max-plan quota. Match on "session limit" / "usage limit" rather
  // than the exact string so a reworded CLI message still surfaces.
  if (/\b(session|usage) limit\b/i.test(trimmed) || /hit your .*limit/i.test(trimmed)) {
    const resetTime = /resets?\s+(.+?)\s*$/i.exec(trimmed)?.[1]?.trim() || undefined;
    return {
      kind: "usage_limit",
      message: trimmed,
      ...(resetTime ? { resetTime } : {}),
      retryable: false,
    };
  }
  // "No response requested." and any other synthetic placeholder: not a limit,
  // carries no real output — suppress it (never a chat bubble).
  return "declined";
}

/** Human-readable message for a terminal error `result`'s subtype. */
function errorMessageForSubtype(subtype: string | undefined): { kind: TurnNoticeKind; message: string } {
  if (subtype === "error_max_turns") {
    return {
      kind: "max_turns",
      message: "The keeper reached its turn limit before finishing this turn.",
    };
  }
  return {
    kind: "error",
    message: "The keeper turn failed before producing a reply.",
  };
}

/**
 * Classify a terminal `type:"result"` SDK message. Returns an `error`/`max_turns`
 * {@link TurnNotice} when the result marks a genuine failure, else `null` for a
 * successful turn.
 *
 * The authoritative failure signal is the **subtype** — the SDK's error results
 * always carry an `error_*` subtype (`error_during_execution`, `error_max_turns`,
 * …) — or an explicit `success === false`. This mirrors `@herdctl/core`'s own
 * success computation (`chatSession`: `subtype.startsWith("error") || success ===
 * false`), so Paddock's banner never disagrees with herdctl about whether a turn
 * failed.
 *
 * We DELIBERATELY do NOT treat `is_error === true` as a failure on its own
 * (issue #329 regression): `SDKResultSuccess` is typed `is_error: boolean`, and
 * the runtime stamps `is_error:true` (with `api_error_status`) on a
 * `subtype:"success"` result when the turn RECOVERED from a transient mid-turn
 * API error (e.g. "Connection closed mid-response") and still produced a normal
 * reply. Reading that as a turn failure rendered a false "turn failed" banner
 * directly beneath a perfectly good reply on essentially every session-mode turn.
 * A genuine error always carries an `error_*` subtype, so nothing is lost.
 */
export function classifyResult(result: {
  subtype?: string;
  is_error?: boolean;
  success?: boolean;
}): TurnNotice | null {
  const subtype = typeof result.subtype === "string" ? result.subtype : undefined;
  // A `subtype:"success"` result is a completed turn, full stop. `is_error` only
  // counts as a failure when the runtime gave us NO subtype at all (defensive:
  // some other runtime shape that reports is_error without one).
  const failed =
    (subtype !== undefined && subtype.startsWith("error")) ||
    result.success === false ||
    (subtype === undefined && result.is_error === true);
  if (!failed) return null;
  const { kind, message } = errorMessageForSubtype(subtype);
  return {
    kind,
    message,
    ...(subtype ? { detail: subtype } : {}),
    retryable: true,
  };
}

/** Build a plain `error` notice from a free-text turn-failure message (a thrown
 *  error / a failed `chat:complete` that never reached a `result`). */
export function errorNotice(message: string | undefined): TurnNotice {
  const detail = message?.trim();
  return {
    kind: "error",
    message: "The keeper turn failed before producing a reply.",
    ...(detail ? { detail } : {}),
    retryable: true,
  };
}

/**
 * Classify one raw SDK/JSONL message. Surfaces a {@link TurnNotice} for a
 * synthetic usage-limit assistant message or a terminal error result; returns
 * `null` for everything else — ordinary output, a successful result, and every
 * suppressed synthetic placeholder (`"No response requested."`).
 */
export function noticeFromMessage(m: RawMessage): TurnNotice | null {
  if (m.type === "assistant" && m.message?.model === SYNTHETIC_MODEL) {
    const r = classifySyntheticText(contentText(m.message?.content));
    return r && r !== "declined" ? r : null;
  }
  if (m.type === "result") {
    return classifyResult(m);
  }
  return null;
}

/**
 * Did this streamed message emit REAL assistant prose — a non-synthetic assistant
 * message carrying non-empty **text** content, regardless of `stop_reason`?
 *
 * The live paths (`ws.ts`) OR-accumulate this across every message of a turn (a
 * per-turn `producedReply` flag) so a terminal error/`max_turns` result that
 * arrives AFTER the turn already showed the user real prose does not paint a false
 * "turn failed" banner beneath the answer (issues #380, #394). In session mode the
 * SDK's terminal `result` frame — streamed live but never persisted — can carry an
 * `error_*` subtype / `success:false` even though the turn produced a perfectly
 * good reply; on reload the history path ({@link scanTranscriptNotice}) suppresses
 * the dead-end via its "any real assistant text supersedes the notice" rule, and
 * this predicate lets the live path apply the SAME rule.
 *
 * #394 — why this is TEXT-ANY-STOP_REASON, not text+`end_turn`. The original #380
 * predicate required a SINGLE message with non-empty text AND `stop_reason:
 * "end_turn"`. Long tool-driven turns break both halves: (a) the visible prose
 * usually rides on a message that ALSO makes a tool call → `stop_reason:"tool_use"`
 * (excluded by the old gate), and (b) the terminal `end_turn` message is frequently
 * **thinking-only** (zero text). So `producedReply` never flipped true and the
 * benign terminal error result was surfaced. Keying off ANY non-synthetic assistant
 * text (across all of the turn's messages, no `stop_reason` gate) makes a
 * text+`tool_use` message count and exactly matches `scanTranscriptNotice`, killing
 * the live/history asymmetry.
 *
 * DELIBERATELY text-only (a bare `thinking` block does NOT count): this mirrors the
 * history path — which clears only on real text — so a genuinely empty turn (no
 * assistant text ANYWHERE, e.g. an `error_max_turns` that wrote nothing renderable)
 * still surfaces its error notice.
 */
export function messageProducedReply(m: RawMessage): boolean {
  if (m.type !== "assistant") return false;
  if (m.message?.model === SYNTHETIC_MODEL) return false;
  return contentText(m.message?.content).trim().length > 0;
}

/**
 * Should an already-classified {@link TurnNotice} be dropped because a complete
 * reply already streamed this turn (issue #380)? An `error` / `max_turns`
 * dead-end beneath a good answer is a false alarm — suppress it. A `usage_limit`
 * is NOT suppressed: a session-limit stop is a real dead-end still worth showing
 * even alongside text.
 */
export function suppressNoticeAfterReply(notice: TurnNotice, producedReply: boolean): boolean {
  return producedReply && (notice.kind === "error" || notice.kind === "max_turns");
}

/**
 * Scan a transcript JSONL file for a TRAILING dead-end notice to surface on
 * reload (the history-hydration path). Only the synthetic usage-limit case is
 * recoverable from history: `@herdctl/core` drops synthetic messages when it
 * parses the transcript, and an `error_max_turns` turn writes NOTHING at all —
 * so those are live-only.
 *
 * A usage-limit notice is surfaced only when it is the LAST thing that happened
 * on the transcript: a later real assistant reply (a non-synthetic assistant
 * message with text) means the chat recovered, so any earlier limit is cleared.
 * Returns the trailing notice, or `null`. Never throws (a missing/unreadable
 * file → `null`).
 */
export async function scanTranscriptNotice(filePath: string): Promise<TurnNotice | null> {
  let pending: TurnNotice | null = null;
  try {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: RawMessage;
      try {
        entry = JSON.parse(trimmed) as RawMessage;
      } catch {
        continue;
      }
      if (entry.type !== "assistant") continue;
      const model = entry.message?.model;
      if (model === SYNTHETIC_MODEL) {
        const r = classifySyntheticText(contentText(entry.message?.content));
        if (r && r !== "declined") pending = r; // a usage-limit dead-end
        // a "declined" placeholder neither sets nor clears the pending notice
      } else if (contentText(entry.message?.content).trim().length > 0) {
        // A real assistant reply: the turn was actually answered → clear.
        pending = null;
      }
    }
  } catch {
    return null;
  }
  return pending;
}

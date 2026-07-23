import type { Dispatch, SetStateAction } from "react";
import { type ToolCall } from "../../lib/ws";
import type {
  AttachmentRef,
  HistoryMessage,
  MessageSender,
  SentFile,
  TurnNotice,
} from "../../lib/types";
import { parseAttachments } from "../../lib/attachments";
import {
  isCompactContinuation,
  isLocalCommandCaveat,
  isLocalCommandStdout,
  isTaskNotification,
  localCommandStdout,
  slashCommandEcho,
  taskNotificationStatus,
  taskNotificationSummary,
} from "../../lib/format";
import { sentFileFromToolCall } from "./toolFormatting";

/** One rendered item in the transcript. Assistant boundaries split bubbles. */
export type Turn =
  // `sender` present ⇒ a machine injected this turn (#290); it renders a subtle
  // attribution above the bubble. Absent ⇒ human-typed (no attribution).
  // `attachments` present ⇒ the user attached files (issue #328); they render as
  // thumbnails/chips above the bubble text.
  | {
      kind: "user";
      id: string;
      content: string;
      sender?: MessageSender;
      attachments?: AttachmentRef[];
    }
  | { kind: "assistant"; id: string; content: string; streaming: boolean }
  | { kind: "tool"; id: string; tool: ToolCall }
  | { kind: "file"; id: string; file: SentFile }
  // A `/compact` (or other) slash-command echo, rendered as a compact chip
  // rather than the raw `<command-name>…` XML as a user bubble (issue #106).
  | { kind: "command"; id: string; command: string }
  // The rendered output of a client-local command (`/context`, `/usage`, …),
  // recovered from its `<local-command-stdout>` block and shown as a labeled
  // markdown output block instead of a raw-XML user bubble — or vanishing
  // entirely, which is the default behavior this fixes (issue #158).
  | { kind: "commandOutput"; id: string; content: string }
  // CC's post-compaction continuation summary, rendered as a "conversation
  // compacted" boundary (the summary is revealable) instead of a user bubble,
  // so a compacted chat no longer looks corrupted (issue #106).
  | { kind: "compact"; id: string; summary: string }
  // An internal background-agent `<task-notification>` block, rendered as a
  // subtle system-status line rather than a raw-XML user bubble (issue #181).
  // `status` carries the notification's `<status>` (e.g. completed/killed/
  // stopped) so a KILLED/STOPPED task — the turn-boundary-kill case that leaves a
  // keeper hung (#301) — renders a distinct "keeper is idle" + Continue affordance
  // instead of the neutral pill.
  | { kind: "notification"; id: string; summary: string; status: string | null }
  // A turn that dead-ended without a normal reply (issue #329): a
  // subscription/usage-limit hit, the max-turns cap, or an error. Rendered as a
  // distinct notice banner (with the reset time for a limit, and a Retry
  // affordance where safe) instead of a silently-dead chat.
  | { kind: "notice"; id: string; notice: TurnNotice };

let idCounter = 0;
/**
 * The single transcript-id counter for ChatPane and its transcript modules. Kept
 * as one module-level instance so ids stay unique across the container's live
 * appends and the render-time history fallbacks.
 */
export const nextId = () => `t${++idCounter}`;

// --- transcript reducers -----------------------------------------------------

/** Append streaming assistant text, creating a new streaming bubble if needed. */
export function appendAssistantText(
  set: Dispatch<SetStateAction<Turn[]>>,
  chunk: string,
) {
  set((prev) => {
    const last = prev[prev.length - 1];
    if (last && last.kind === "assistant" && last.streaming) {
      return [
        ...prev.slice(0, -1),
        { ...last, content: last.content + chunk },
      ];
    }
    return [...prev, { kind: "assistant", id: nextId(), content: chunk, streaming: true }];
  });
}

/**
 * Mark every streaming assistant bubble as finished. Clearing all of them (not
 * just the trailing turn) is what lets carets on tool-separated text segments
 * vanish — in a `text → tool → text` turn each text bubble is sealed as its
 * tool call begins, and any stragglers are cleared when the turn completes.
 */
export function sealStreaming(prev: Turn[]): Turn[] {
  if (!prev.some((t) => t.kind === "assistant" && t.streaming)) return prev;
  return prev.map((t) =>
    t.kind === "assistant" && t.streaming ? { ...t, streaming: false } : t,
  );
}

/**
 * Clear the `pending` flag on any in-flight tool rows (#175) that never received
 * a reconciling `chat:tool_call`. Called when a turn ends (complete/error/stop):
 * by then every legitimate completion has already reconciled its row, so any row
 * still pending is orphaned — a lost completion (killed turn) or a tool whose
 * result never reaches the main stream (e.g. a subagent's nested step, which
 * herdctl streams via a separate sidechain session). Settling it stops the
 * spinner from spinning forever; the row renders as a plain finished tool.
 */
export function settlePending(prev: Turn[]): Turn[] {
  if (!prev.some((t) => t.kind === "tool" && t.tool.pending)) return prev;
  return prev.map((t) =>
    t.kind === "tool" && t.tool.pending ? { ...t, tool: { ...t.tool, pending: false } } : t,
  );
}

/**
 * Convert a hydrated history message into a rendered turn, tagged with a
 * caller-resolved `id` (see `historyToTurns`). A `send_file` tool call rebuilds
 * its rich `file` turn (parsing the same output envelope as the live path), so a
 * reload renders identically (issue #112).
 */
export function historyToTurn(m: HistoryMessage, id: string): Turn {
  // A surfaced turn dead-end recovered from the transcript on reload (#329): the
  // server appends a synthetic notice message. Check first — it rides on a
  // `role:"assistant"` shell but must never render as an assistant bubble.
  if (m.notice) {
    return { kind: "notice", id, notice: m.notice };
  }
  if (m.role === "tool" && m.toolCall) {
    const file = sentFileFromToolCall(m.toolCall);
    if (file) return { kind: "file", id, file };
    return { kind: "tool", id, tool: m.toolCall };
  }
  if (m.role === "assistant") {
    return { kind: "assistant", id, content: m.content, streaming: false };
  }
  // A `role:"user"` message may actually be a CC-injected transcript artifact,
  // not something the human typed. Surface these as their own clean markers
  // rather than raw user bubbles (issue #106).
  if (isCompactContinuation(m.content)) {
    return { kind: "compact", id, summary: m.content };
  }
  const command = slashCommandEcho(m.content);
  if (command) {
    return { kind: "command", id, command };
  }
  // A client-local display command (`/context`, `/usage`, …) writes its rendered
  // output as a `<local-command-stdout>` block and a `<local-command-caveat>`
  // framing note (issue #158). Surface the stdout as a labeled output block and
  // drop the caveat — both would otherwise render as raw-XML user bubbles. Route
  // ANY stdout wrapper here (even an empty one) so an empty block collapses to
  // nothing rather than falling through to the raw-XML user-bubble fallback — the
  // last line of defense regardless of which path injected it.
  if (isLocalCommandStdout(m.content)) {
    return { kind: "commandOutput", id, content: localCommandStdout(m.content) ?? "" };
  }
  if (isLocalCommandCaveat(m.content)) {
    // Harness scaffolding with no reader value — collapse to an empty command
    // chip's sibling (a hidden marker); rendered as nothing (see toRenderedTurn).
    return { kind: "commandOutput", id, content: "" };
  }
  // A background-agent `<task-notification>` block (harness metadata, not typed
  // by the human) — a subtle status line instead of a raw-XML bubble (issue #181).
  if (isTaskNotification(m.content)) {
    return {
      kind: "notification",
      id,
      summary: taskNotificationSummary(m.content),
      status: taskNotificationStatus(m.content),
    };
  }
  // A user turn may carry uploaded attachments in a `<paddock-attachments>`
  // wrapper (#328). Strip the block from the visible text and re-render the files
  // as thumbnails/chips (bytes served from the store). Nested inside any preload
  // wrapper, which is intentionally left intact (existing behavior).
  const { attachments, text } = parseAttachments(m.content);
  // A machine-injected user turn (#290) carries a `sender`; a human message does
  // not. Thread it through so the bubble renders "↩ sent by …" / "⏰ scheduled by …".
  return {
    kind: "user",
    id,
    content: text,
    ...(m.sender ? { sender: m.sender } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

/**
 * Build the rendered turns for a reloaded transcript, giving each a STABLE,
 * UNIQUE id derived from the source message's `uuid` (issue #135). The same
 * transcript yields the same ids across reloads, so per-message UI state (e.g. a
 * custom embed height, #136) can be keyed on `turn.id` and persist — unlike the
 * ephemeral render counter, which is reassigned on every render.
 *
 * A single JSONL entry can parse into several messages that SHARE one `uuid` (an
 * assistant entry carrying text + tool_use, or multiple tool_uses — the herdctl
 * `uuid` is a stable anchor, not a unique key). We suffix the 2nd+ message
 * carrying a given uuid with `#<n>` so React keys stay unique while remaining
 * deterministic. A message with no `uuid` (older transcript / pre-uuid core)
 * falls back to the render counter — unique per render, but not reload-stable.
 */
export function historyToTurns(msgs: HistoryMessage[]): Turn[] {
  const seen = new Map<string, number>();
  return msgs
    // A `<task-notification>` folded into its launching background tool block
    // (issue #230) is no longer drawn as a standalone status pill.
    .filter((m) => !m.bgConsumed)
    .map((m) => {
    let id: string;
    if (m.uuid) {
      const n = seen.get(m.uuid) ?? 0;
      seen.set(m.uuid, n + 1);
      id = n === 0 ? m.uuid : `${m.uuid}#${n}`;
    } else {
      id = nextId();
    }
    return historyToTurn(m, id);
  });
}

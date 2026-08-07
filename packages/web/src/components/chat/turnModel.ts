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

/**
 * Cross-cutting per-message metadata surfaced on hover (issue #451): the source
 * message's ISO timestamp and the context-window fill (tokens) as of that point.
 * Both optional — present on reloaded history turns, absent on ephemeral
 * live-streamed turns (which have no stable uuid to anchor fork/revert on).
 */
export interface TurnMeta {
  timestamp?: string;
  contextTokens?: number;
}

/** One rendered item in the transcript. Assistant boundaries split bubbles. */
type TurnBody =
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

export type Turn = TurnBody & TurnMeta;

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

/** The slash command whose echo owns a compaction boundary (see below). */
const COMPACT_COMMAND = "/compact";

/**
 * True for the turns that legitimately sit BETWEEN a compaction boundary and the
 * `/compact` echo that produced it: the `<local-command-caveat>` CC writes just
 * above the command, which renders as nothing (an empty `commandOutput`). Core's
 * JSONL parser normally drops it (`isMeta:true`), so it usually never gets this
 * far — but a caveat that does survive must not defeat the pairing.
 */
function isInvisibleCompactFiller(turn: Turn): boolean {
  return turn.kind === "commandOutput" && turn.content === "";
}

/**
 * Move a compaction boundary chip AFTER the `/compact` echo that produced it
 * (issue #630).
 *
 * Claude Code appends the compaction records at file positions *preceding* the
 * command line, but stamps them with the time compaction *finished* — so the
 * boundary's own timestamp can be minutes LATER than the `/compact` sitting
 * below it. Rendering in file order therefore reads as though the conversation
 * was compacted before anyone asked for it.
 *
 * This is a targeted swap, not a re-sort: only a `compact` turn immediately
 * followed by its `/compact` echo moves, and it moves exactly one slot past it.
 * Everything else — including an auto-compaction with no echo to pair with, and
 * a `/compact` whose compaction never produced a summary — is left in file
 * order. No turn is ever added or dropped.
 */
function orderCompactBoundaries(turns: Turn[]): Turn[] {
  if (!turns.some((t) => t.kind === "compact")) return turns;
  const out: Turn[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.kind !== "compact") {
      out.push(turn);
      continue;
    }
    let j = i + 1;
    while (j < turns.length && isInvisibleCompactFiller(turns[j])) j++;
    const echo = turns[j];
    if (echo?.kind === "command" && echo.command === COMPACT_COMMAND) {
      out.push(...turns.slice(i + 1, j + 1), turn);
      i = j;
    } else {
      out.push(turn);
    }
  }
  return out;
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
  const turns = msgs
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
      // Attach per-message hover metadata (#451): the source timestamp and the
      // context-window fill as of this message. Set on the built turn (both are
      // optional TurnMeta fields, so the discriminated body is unaffected).
      const turn = historyToTurn(m, id);
      turn.timestamp = m.timestamp;
      if (m.contextTokens != null) turn.contextTokens = m.contextTokens;
      return turn;
    });
  // The compaction boundary CC writes ABOVE its own `/compact` echo is put back
  // in the order it happened (issue #630).
  return orderCompactBoundaries(turns);
}

// --- hydration merge (issue #726) --------------------------------------------

/**
 * A content signature for turns that carry no stable id, used to recognise the
 * same event in a REST snapshot and in a live frame. Deliberately narrow: it only
 * has to be good enough to spot a duplicate inside the sub-second window a
 * hydration fetch is in flight, not to identify a turn globally.
 */
function turnSignature(t: Turn): string {
  switch (t.kind) {
    case "user":
      return `user:${t.content}`;
    case "command":
      return `command:${t.command}`;
    case "commandOutput":
      return `commandOutput:${t.content}`;
    case "compact":
      return `compact:${t.summary}`;
    case "notification":
      return `notification:${t.status ?? ""}:${t.summary}`;
    case "notice":
      return `notice:${t.notice.kind}`;
    case "file":
      return `file:${t.file.filename}:${t.file.source}`;
    default:
      return `${t.kind}:${t.id}`;
  }
}

/**
 * Fold the live turns accumulated while a transcript fetch was in flight into the
 * snapshot that fetch returned (issue #726).
 *
 * A remounting pane clears the transcript, fetches it over REST and **replaced**
 * the result wholesale. The socket is attached future-only by design (`lib/ws.ts`:
 * a fresh mount hydrates over REST, so replaying buffered frames would duplicate
 * it), so every frame that arrived between the server READING the transcript and
 * the response reaching the browser was appended to the pane and then thrown away
 * by that replace. The effect's `cancelled` flag guards a newer chat *switch*, not
 * newer *frames*. In the reproduction that cost an entire assistant reply and the
 * tool-result reconciliation behind it: no reply at all, and a Task card stuck on
 * RUNNING until the page was reloaded.
 *
 * The window is the response leg plus the server's post-read work, so it needs
 * ~1s+ of latency to bite — a WAN client or a loaded server, not a dev box. The
 * fix costs nothing on the fast path: when nothing arrived during the fetch,
 * `live` is empty and this returns the snapshot unchanged.
 *
 * Overlap is resolved per kind, always preferring whichever copy knows MORE:
 *  - a tool call matches on `toolUseId` and the two are merged, so a snapshot row
 *    still `pending` picks up the completion the live frame carried;
 *  - an assistant bubble matches by prefix, since the live bubble accumulates the
 *    same text chunk by chunk — the longer one wins;
 *  - everything else matches on a content signature and the snapshot wins.
 *
 * Live turns with no counterpart are appended, in order, after the snapshot: the
 * socket only delivers what is newer than the transcript the snapshot came from.
 */
export function mergeHydratedTurns(snapshot: Turn[], live: Turn[]): Turn[] {
  if (live.length === 0) return snapshot;
  if (snapshot.length === 0) return live;

  const out = [...snapshot];
  // Where each identity currently sits in `out`, so a match can be upgraded in
  // place rather than appended.
  const byToolUseId = new Map<string, number>();
  const bySignature = new Map<string, number>();
  const assistantIdx: number[] = [];
  out.forEach((t, i) => {
    if (t.kind === "tool" && t.tool.toolUseId) byToolUseId.set(t.tool.toolUseId, i);
    else if (t.kind === "assistant") assistantIdx.push(i);
    else bySignature.set(turnSignature(t), i);
  });

  for (const t of live) {
    if (t.kind === "tool" && t.tool.toolUseId) {
      const at = byToolUseId.get(t.tool.toolUseId);
      if (at === undefined) {
        byToolUseId.set(t.tool.toolUseId, out.length);
        out.push(t);
        continue;
      }
      // Same call, two views of it. The history-hydrated row carries the richer
      // enrichment (diffs, sub-agent metadata, per-tool details) and the live row
      // carries the completion the snapshot was taken too early to see, so the
      // live fields are layered ON TOP of the snapshot's rather than replacing it.
      const snap = out[at];
      if (snap.kind !== "tool") continue;
      // `pending` comes from the LIVE row, explicitly: a completion frame carries
      // no `pending` key at all, so spreading it would leave a snapshot row that
      // was read mid-flight stuck on "running" — the second half of #726, and the
      // half a reply-only assertion misses.
      out[at] = { ...snap, tool: { ...snap.tool, ...t.tool, pending: t.tool.pending === true } };
      continue;
    }
    if (t.kind === "assistant") {
      // The live bubble is the same text the transcript holds, accumulated chunk
      // by chunk — so one is a prefix of the other, and the longer one is simply
      // the later view of it.
      const at = assistantIdx.find((i) => {
        const s = out[i];
        return (
          s.kind === "assistant" &&
          (s.content === t.content ||
            s.content.startsWith(t.content) ||
            t.content.startsWith(s.content))
        );
      });
      if (at === undefined) {
        assistantIdx.push(out.length);
        out.push(t);
        continue;
      }
      const snap = out[at];
      if (snap.kind !== "assistant") continue;
      if (t.content.length > snap.content.length) {
        out[at] = { ...snap, content: t.content, streaming: t.streaming };
      }
      continue;
    }
    const sig = turnSignature(t);
    if (bySignature.has(sig)) continue;
    bySignature.set(sig, out.length);
    out.push(t);
  }
  return out;
}

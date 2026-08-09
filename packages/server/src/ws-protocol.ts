/**
 * WebSocket wire protocol + token/usage math (extracted from ws.ts, issue #403).
 *
 * Pure types + pure functions — no closure ties, no store/service dependencies.
 * Holds:
 *   - the client->server and server->client message interfaces + unions,
 *   - the {@link isClientMessage} runtime guard,
 *   - the per-turn usage extraction/fold/resolve helpers.
 *
 * `ws.ts` re-exports every symbol here so external importers (and tests) that
 * `import … from "./ws.js"` continue to resolve unchanged.
 *
 * See ws.ts's module doc comment for the on-the-wire protocol narrative.
 */
import type { SDKMessage } from "@herdctl/core";
import type { TurnNotice } from "./turn-notice.js";

/**
 * Per-turn token usage as observed on the SDK stream, normalized to camelCase.
 * Read defensively from either an assistant message (`m.message.usage`) or the
 * final result message (`m.usage`) — fields are loosely typed in core.
 */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** A model id seen on the SDK stream paired (best-effort) with its usage. */
interface ExtractedUsage {
  usage: TurnUsage | null;
  model: string | null;
  /**
   * True when this usage came from the terminal `type:"result"` SDK message,
   * whose `usage` is a CUMULATIVE per-turn total aggregated across every internal
   * API call (num_turns), not a single context-window snapshot (#398). Such a
   * block must never feed the context-snapshot meter.
   */
  fromResult: boolean;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Defensively extract per-turn usage + model from a raw SDK message. The SDK's
 * `message` is typed `unknown` in core, and the CLI/SDK runtimes shape usage
 * slightly differently, so every field access is guarded.
 *
 * - assistant message: `m.message.usage` (Anthropic usage block) + `m.message.model`.
 * - result message: top-level `m.usage` (same field names). Flagged `fromResult`
 *   because that block is a cumulative per-turn total, not a snapshot (#398).
 *
 * Returns `{ usage: null, model: null, fromResult: false }` when neither is present.
 */
export function extractUsage(m: SDKMessage): ExtractedUsage {
  const raw = m as unknown as {
    type?: string;
    usage?: unknown;
    message?: { usage?: unknown; model?: unknown } | unknown;
  };
  const fromResult = raw.type === "result";

  // Locate the usage block + model from whichever shape this message carries.
  let usageBlock: unknown;
  let model: string | null = null;

  const inner =
    raw.message && typeof raw.message === "object"
      ? (raw.message as { usage?: unknown; model?: unknown })
      : undefined;
  if (inner) {
    if (inner.usage !== undefined) usageBlock = inner.usage;
    if (typeof inner.model === "string") model = inner.model;
  }
  // Result messages (and some shapes) carry usage at the top level.
  if (usageBlock === undefined && raw.usage !== undefined) usageBlock = raw.usage;

  if (usageBlock === undefined || usageBlock === null || typeof usageBlock !== "object") {
    return { usage: null, model, fromResult };
  }

  const u = usageBlock as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
    cache_read_input_tokens?: unknown;
  };
  const usage: TurnUsage = {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheCreationTokens: num(u.cache_creation_input_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
  };
  // A usage block of all-zeros (e.g. a stub) is not informative; treat as none.
  const anyTokens =
    usage.inputTokens || usage.outputTokens || usage.cacheCreationTokens || usage.cacheReadTokens;
  return { usage: anyTokens ? usage : null, model, fromResult };
}

/** The `<synthetic>` model marker CC stamps on placeholder assistant turns. */
const SYNTHETIC_MODEL = "<synthetic>";
/**
 * Bare synthetic placeholders that carry no output worth surfacing — e.g. the
 * "No response requested." turn CC injects after a `/compact` continuation. Only a
 * synthetic message with *substantive* text is a genuine local-command result.
 */
const SYNTHETIC_PLACEHOLDERS = new Set(["No response requested."]);

/**
 * The rendered output of a client-local slash command (`/context`, `/usage`, …) to
 * surface as an assistant note, or null when this SDK message isn't one (issue #158).
 *
 * The interactive TUI renders these locally; a non-interactive SDK session (Paddock's
 * path) instead surfaces the output as EITHER a `type:"system"` / `local_command`
 * entry (its `content` wraps the output in `<local-command-stdout>…`) or a
 * `model:"<synthetic>"` assistant placeholder carrying the text. @herdctl/chat's
 * translator drops both (synthetic messages are skipped; system entries aren't text),
 * so the live command turn would otherwise read as a silent no-op. We recover the text
 * and emit it as an assistant note (mirroring the `compact_boundary` special-case),
 * consistent with the history-path recovery in `localcommand.ts`. Bare placeholders
 * (e.g. `/compact`'s "No response requested.") yield null so they stay quiet. Paddock's
 * own context ring + cost meter remain the primary usage view; this just stops the
 * output vanishing.
 */
export function extractLocalCommandOutput(m: SDKMessage): string | null {
  const raw = m as unknown as {
    type?: string;
    subtype?: string;
    content?: unknown;
    message?: { model?: unknown; content?: unknown } | unknown;
  };
  // Disk/canonical form: a `system` / `local_command` entry wrapping the stdout.
  if (raw.type === "system" && raw.subtype === "local_command") {
    const content = typeof raw.content === "string" ? raw.content : "";
    const inner = /<local-command-stdout>([\s\S]*)<\/local-command-stdout>/.exec(content)?.[1];
    const text = (inner ?? "").trim();
    return text.length > 0 ? text : null;
  }
  // Live/stream form: a synthetic placeholder assistant message carrying the text.
  if (raw.type !== "assistant") return null;
  const inner =
    raw.message && typeof raw.message === "object"
      ? (raw.message as { model?: unknown; content?: unknown })
      : undefined;
  if (!inner || inner.model !== SYNTHETIC_MODEL) return null;
  let text = "";
  if (typeof inner.content === "string") text = inner.content;
  else if (Array.isArray(inner.content)) {
    for (const block of inner.content) {
      const b = block as { type?: unknown; text?: unknown };
      if (b?.type === "text" && typeof b.text === "string") text += b.text;
    }
  }
  text = text.trim();
  if (text.length === 0 || SYNTHETIC_PLACEHOLDERS.has(text)) return null;
  return text;
}

/**
 * The context snapshot a usage block implies: the tokens resident in the model's
 * context window for this turn (fresh input + cache reads + cache creation).
 */
function contextTokensOf(u: TurnUsage): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}

/**
 * Merge two context-snapshot usage blocks, keeping whichever best reflects the
 * context window (issue #165). Only assistant / partial-assistant blocks are ever
 * passed here — the terminal `result` block is folded separately (see
 * {@link foldTurnUsage}), because its usage is cumulative, not a snapshot (#398).
 *
 * Assistant usage grows monotonically through a turn (each round re-reads the
 * cached prefix), so "last assistant" == "max assistant". We still keep the MAX
 * `contextTokens` (input + cacheRead + cacheCreation) defensively: an odd
 * cache-less block can never LOWER the snapshot. `outputTokens` keeps the max
 * seen.
 */
export function pickTurnUsage(prev: TurnUsage | null, next: TurnUsage): TurnUsage {
  if (!prev) return next;
  const chosen = contextTokensOf(next) >= contextTokensOf(prev) ? next : prev;
  return {
    ...chosen,
    outputTokens: Math.max(prev.outputTokens, next.outputTokens),
  };
}

/**
 * Running per-turn usage, keeping the context snapshot and the terminal result's
 * cumulative totals STRICTLY SEPARATE (#398).
 *
 * The `result` SDK message's `usage` (`SDKResultSuccess.usage`) is a cumulative
 * sum across every internal API call in the turn (`num_turns`) — on a long
 * tool-heavy turn it dwarfs any single assistant block. Feeding it into the
 * snapshot (as the old MAX heuristic did) inflated the live context meter (e.g.
 * 828k when the true window was ~292k), only to be corrected on refresh from
 * disk. So we route it to `cumulative` and never let it touch the snapshot.
 */
export interface TurnUsageState {
  /** Context-window snapshot from assistant / partial-assistant messages. */
  snapshot: TurnUsage | null;
  /** Terminal result's cumulative per-turn totals — for cost/output only, never contextTokens. */
  cumulative: TurnUsage | null;
  /** Most recent model id seen paired with usage. */
  model: string | null;
}

/** A fresh, empty per-turn usage accumulator. */
export function initTurnUsage(): TurnUsageState {
  return { snapshot: null, cumulative: null, model: null };
}

/**
 * Fold one raw SDK message into the running usage state. Mirrors exactly what the
 * ws.ts stream loop does, so tests can drive it the same way. Assistant usage
 * accumulates into the context snapshot; the terminal `result` block is stashed
 * separately as the turn's cumulative total (#398).
 */
export function foldTurnUsage(state: TurnUsageState, m: SDKMessage): TurnUsageState {
  const ex = extractUsage(m);
  if (ex.usage) {
    if (ex.fromResult) state.cumulative = ex.usage;
    else state.snapshot = pickTurnUsage(state.snapshot, ex.usage);
  }
  if (ex.model) state.model = ex.model;
  return state;
}

/**
 * Resolve the final per-turn usage emitted on `chat:complete`. `contextTokens`
 * always derives from the snapshot (the true window). The cumulative result block
 * is used only to lift `outputTokens` to the turn's final total, and as a
 * last-resort fallback for context if NO assistant usage was seen this turn (some
 * runtimes emit usage only on the result — there cumulative == the single call).
 */
export function resolveTurnUsage(state: TurnUsageState): TurnUsage | null {
  const base = state.snapshot ?? state.cumulative;
  if (!base) return null;
  return {
    ...base,
    outputTokens: Math.max(base.outputTokens, state.cumulative?.outputTokens ?? 0),
  };
}

// --- client -> server --------------------------------------------------------

export interface ChatSendMessage {
  type: "chat:send";
  payload: {
    /**
     * Workspace key: a project slug. `""` is the ROOT workspace — a present
     * empty string, not an absent value, so test it with `=== undefined`,
     * never for falsiness.
     */
    projectSlug?: string;
    /** Session to resume; null/omitted starts a new chat. */
    sessionId?: string | null;
    message: string;
    /**
     * When true AND this is a NEW chat (sessionId null/omitted) AND the project
     * has an OVERVIEW.md, prepend that overview to the prompt as a delimited
     * context block (issue #1). No-op when no overview exists.
     */
    preloadContext?: boolean;
    /**
     * Optional per-chat model override (a known model id). Unknown/absent ->
     * the workspace's persisted model, else the keeper default. The keeper agent
     * is re-registered at this model before triggering. (§7.)
     */
    model?: string;
    /**
     * Files the user attached in the composer (issue #328). Each references an
     * attachment already uploaded via `POST …/chats/:id/upload` (bytes in the
     * store). The server validates them against the project's effective attachment
     * config, then prepends a `<paddock-attachments>` hint block to the prompt
     * pointing the keeper's `Read` tool at the absolute paths. Project chats only.
     */
    attachments?: Array<{ id: string; filename: string; kind?: string }>;
  };
}

export interface ChatCancelMessage {
  type: "chat:cancel";
  payload: { jobId: string };
}

/**
 * Run a slash command (e.g. `/compact`) in the current chat.
 *
 * Unlike `chat:send`, this drives herdctl's streaming session so the CLI
 * dispatches the command instead of treating the text as a plain prompt. The
 * command acts on the resumed `sessionId`, so `/compact` compacts the real
 * chat history. Output streams back over the same `chat:response` /
 * `chat:tool_call` / `chat:complete` events as a normal turn.
 */
export interface ChatCommandMessage {
  type: "chat:command";
  payload: {
    projectSlug?: string;
    /** Session the command runs against. Required (a command needs a chat). */
    sessionId?: string | null;
    /** The full command text, including the leading slash (e.g. "/compact"). */
    command: string;
  };
}

/**
 * Attach a socket to a session's live stream (issue #54). Sent on (re)connect so
 * a socket that dropped mid-turn can re-attach to the still-running turn and be
 * replayed the frames it missed.
 *
 * `wantReplay` MUST be false on a fresh mount (which also hydrates the transcript
 * over REST) so buffered frames don't duplicate the transcript; it is true only
 * for a genuine reconnect of a socket that was mid-turn, with `lastSeq` = the
 * last per-turn `seq` the client applied (the replay is exactly the gap after it).
 */
export interface ChatSubscribeMessage {
  type: "chat:subscribe";
  payload: {
    projectSlug?: string;
    /** The session to attach to. Required. */
    sessionId: string;
    /** Replay the missed gap of a live turn (reconnect); false = future frames only. */
    wantReplay?: boolean;
    /** Last per-turn `seq` the client applied; the server replays everything after it. */
    lastSeq?: number;
  };
}

/**
 * Store a queued message to be auto-sent when the current turn completes (#197).
 * The client sends this to persist the queue server-side so it survives browser
 * close; the server stores it, checks after turn completion, and auto-sends if
 * present. The web client also keeps a localStorage copy for live editing UX.
 */
export interface ChatSetQueueMessage {
  type: "chat:set_queue";
  payload: {
    projectSlug?: string;
    sessionId?: string | null;
    /** The queued message text, or null/empty to clear. */
    text?: string | null;
    /**
     * OPAQUE identity of this client's queue (#245 stable identity, #736). Minted
     * once when the queue is first created and kept across edits, appends and
     * reloads, so the server can tell (a) this client updating its own queue apart
     * from another client queueing alongside it (#629) and (b) a stale re-assert of
     * an already-drained message apart from a new one — by EQUALITY, never ordering.
     *
     * Absent from an older client, which sends only `ts`; the server folds that
     * into an id.
     */
    qid?: string | null;
    /**
     * Legacy client-stamped enqueue time (#245). Superseded by `qid`: it was used
     * as an ORDERED identity, so one client with a fast clock poisoned the dedup
     * marker and every later queued message on that chat — from any client — was
     * silently destroyed (#736). Still accepted (older clients send it, and it
     * still identifies a message) but only ever compared for equality, and never
     * stored as the enqueue time — the server stamps that itself.
     */
    ts?: number | null;
    /**
     * Files staged in the composer that must ride the queued message (#728).
     *
     * Attachments used to be consumed ONLY by `chat:send`, so a message queued
     * during a live turn left them staged: the tray never cleared and the file
     * silently rode whatever the user sent next — a message they never meant to
     * attach it to. They belong to the queued message, so they travel with it into
     * the shared slot and are sent by the drain.
     *
     * Merged into the slot as a UNION BY ID, never a replace: a write can only
     * ever ADD to what is staged, so one client's `set_queue` cannot silently drop
     * another's file, and a client re-asserting its queue on reload (which by then
     * has an empty tray) is a no-op rather than a wipe. Attachments leave the slot
     * only when it is cleared outright or popped back to a composer.
     */
    attachments?: Array<{ id: string; filename: string; kind?: string }>;
  };
}

/**
 * Manually re-drive a keeper that hung because its background task was killed at
 * the turn boundary (issue #301, Layer 2). The keeper's session stayed ALIVE (see
 * edspencer/herdctl#374) so it's still injectable — this action injects a recovery
 * nudge into it via {@link startAgentTurn}, exactly the message a human sends by
 * hand today to unstick it, but one click and correctly attributed
 * (`sender: { kind: "recovery" }`). Gated server-side on the resolved
 * `recovery.surfaceKilledTask` (per-project override else instance default), so a
 * client can't re-drive when the operator turned Layer 2 off.
 */
export interface ChatContinueMessage {
  type: "chat:continue";
  payload: {
    projectSlug?: string;
    /** The hung keeper session to re-drive. Required (recovery needs a chat). */
    sessionId: string;
  };
}

export interface PingMessage {
  type: "ping";
}

export type ClientMessage =
  | ChatSendMessage
  | ChatCommandMessage
  | ChatCancelMessage
  | ChatSubscribeMessage
  | ChatSetQueueMessage
  | ChatContinueMessage
  | PingMessage;


// --- server -> client --------------------------------------------------------

export interface Routing {
  projectSlug: string;
  sessionId: string | null;
  jobId: string | null;
  /**
   * Per-turn, monotonic sequence number stamped by the SessionHub as the frame
   * is emitted (issue #54). Lets a reconnecting client tell the server the last
   * frame it applied so the exact missed gap can be replayed. Absent on frames
   * not routed through the hub (e.g. chat:error).
   */
  seq?: number;
}

export interface ChatResponseMessage {
  type: "chat:response";
  payload: Routing & { chunk: string };
}

export interface ChatToolCallMessage {
  type: "chat:tool_call";
  payload: Routing & {
    toolName: string;
    inputSummary?: string;
    output: string;
    isError: boolean;
    durationMs?: number;
    /**
     * The originating tool_use id. Lets a client reconcile this completion with
     * the pending row it created on the earlier `chat:tool_start` frame (#175).
     */
    toolUseId?: string;
    // Live sub-agent enrichment (issue #429). Present only on a `Task`/`Agent`
    // completion, recovered from the launch's tool_use input so the card shows the
    // real type/title + stays expandable WITHOUT a refresh (the history-path
    // subagent-join used to be the only source). Duration/cost still fill from the
    // subagent-join on reload (they need the sub-agent's finished transcript).
    subagentType?: string;
    description?: string;
    hasSubagent?: boolean;
  };
}

/**
 * An in-flight tool_use, emitted the moment the tool STARTS — before it runs or
 * produces a result (#175). Lets a client render a pending "running…" row for
 * slow tools (especially subagents that run for minutes), keyed by `toolUseId`,
 * then reconcile it when the matching `chat:tool_call` completion arrives.
 * Sourced from `@herdctl/chat`'s `onToolStart` (v0.6.0+).
 */
export interface ChatToolStartMessage {
  type: "chat:tool_start";
  payload: Routing & {
    toolName: string;
    inputSummary?: string;
    toolUseId?: string;
    /** Subagent attribution: null = main agent, else the spawning Task tool_use id. */
    parentToolUseId: string | null;
    // Live sub-agent enrichment (issue #429). Present only on a `Task`/`Agent`
    // start, recovered from the launch's tool_use input so the pending card shows
    // the real sub-agent type/title + is expandable into its (streaming) steps the
    // instant it launches, instead of the generic "Agent · running" placeholder.
    subagentType?: string;
    description?: string;
    hasSubagent?: boolean;
  };
}

export interface ChatMessageBoundaryMessage {
  type: "chat:message_boundary";
  payload: Routing;
}

/** Per-turn token usage surfaced on chat:complete (camelCase, with the meter math). */
export interface ChatCompleteUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** input + cacheRead + cacheCreation (what the context window holds). */
  contextTokens: number;
  /** getContextLimit(model). */
  contextLimit: number;
}

export interface ChatCompleteMessage {
  type: "chat:complete";
  payload: Routing & {
    success: boolean;
    error?: string;
    /** The model this turn ran on (lastModel ?? effectiveModel). Omitted if unknown. */
    model?: string;
    /** Last per-turn usage observed; omitted (with model) if none was seen. */
    usage?: ChatCompleteUsage;
  };
}

export interface ChatErrorMessage {
  type: "chat:error";
  payload: { projectSlug: string; error: string };
}

/**
 * Tell a re-attaching client to re-hydrate from the transcript instead of a
 * frame replay (issue #54). Emitted only when the missed gap has aged out of the
 * turn's bounded buffer — the rare fallback that trades live-ness for correctness.
 */
export interface ChatResyncMessage {
  type: "chat:resync";
  payload: { projectSlug: string; sessionId: string };
}

/**
 * A session's live-turn status (issues #52/#53). Broadcast to all clients on a
 * turn's start/stop transition, sent as a snapshot to a newly-connected socket,
 * and sent in reply to a `chat:subscribe` for a session with a running turn. It
 * lets a client restore the Stop button + `jobId` for a returning/remounted pane
 * (#52) and drive the in-chat + per-chat-sidebar streaming indicators (#53).
 */
export interface ChatActiveMessage {
  type: "chat:active";
  payload: {
    projectSlug: string;
    sessionId: string;
    /** The running turn's cancellable job id, when known. */
    jobId: string | null;
    running: boolean;
    /**
     * Epoch-ms the running turn began, from the session hub. The hub is the only
     * thing that knows: a job record is written when a turn ENDS, and the
     * transcript's timestamps are the model's rather than the run's. Because the
     * server replays its whole running snapshot to every socket on connect, a
     * client that reloads mid-turn still learns the true start — which is what
     * lets a fleet readout say "running 12:04" instead of restarting at zero on
     * every page load.
     *
     * Optional because a `running: false` frame carries the ENDING turn's start
     * time, which means nothing to a reader — clients discard it there. Optional
     * rather than absent so an older server (which sends no such field) parses
     * against this type unchanged.
     */
    startedAt?: number;
  };
}

/**
 * Notify the client that the queued message was auto-sent by the server (#197).
 * The client clears its localStorage copy of the queued message when it receives
 * this frame, so queued messages don't duplicate if the browser closes before
 * the turn completes.
 */
export interface ChatQueuedFlushedMessage {
  type: "chat:queued_flushed";
  payload: {
    projectSlug: string;
    sessionId: string;
    /**
     * The queued text the server is now auto-sending as a turn (#245). Present
     * when the server actually drained+sent it — the client renders it as the
     * user bubble in-transcript (the drained turn streams only the reply). Absent
     * when the frame is just telling the client to clear a stale/already-sent copy.
     */
    text?: string;
    /**
     * The attachments that rode the drained message (#728), so the client renders
     * the auto-sent user bubble with its files exactly as a live send does. Only
     * present alongside `text` (a clear-only frame carries neither).
     */
    attachments?: Array<{ id: string; filename: string; kind?: string }>;
  };
}

/**
 * The chat's queued message changed (#629). Broadcast to EVERY socket attached to
 * the session whenever the slot is written, so the queue is shared chat state that
 * all clients render identically instead of invisible per-client state.
 *
 * Before this, a queue was only ever written and never announced: a second client
 * queueing on the same chat overwrote the first client's text with no signal to
 * anyone. The first user's chip sat there showing a message that no longer existed,
 * and when the drain finally fired, their transcript rendered — as their own user
 * bubble — a message they had never typed. The slot now MERGES contributions, and
 * this frame is what makes the merge visible.
 */
export interface ChatQueuedStateMessage {
  type: "chat:queued_state";
  payload: {
    projectSlug: string;
    sessionId: string;
    /** The chat's full queued text, or null when the slot is now empty. */
    text: string | null;
    /**
     * The files staged on the slot (#728). Shared exactly like the text is: every
     * attached client renders the same chips, so a file queued on one device is
     * visible on the other rather than being invisible state that surfaces only
     * when the drain sends it. Absent/empty when the slot holds no attachments.
     */
    attachments?: Array<{ id: string; filename: string; kind?: string }>;
    /**
     * The slot's identity. A client adopts it as its own queue id, so its next
     * edit updates this shared slot in place rather than appending beside it.
     */
    qid?: string;
    /**
     * Why the slot changed, when it is worth explaining. `returned` means a user
     * pressed Stop and the message went back to THEIR composer — sent to the
     * other clients so a chip that just vanished from under them has a reason
     * attached, rather than looking like the message evaporated. The client that
     * pressed Stop is excluded from this broadcast; it gets
     * {@link ChatQueuedReturnedMessage} instead.
     */
    reason?: "returned";
  };
}

/**
 * A user pressed Stop, so the message queued behind that turn is handed BACK to
 * them (#751 follow-up). Sent only to the socket that asked to cancel.
 *
 * Stop means "give me control back". Auto-sending the follow-up would have the
 * agent start working again the instant the user stopped it, and holding the
 * message server-side is what stranded it (#627) — so it returns to the composer,
 * where it is visible, editable, and sent only when the user says so.
 *
 * Deliberately NOT `chat:queued_flushed` with a flag: that frame means "this text
 * was sent, render it as the user's bubble", and a returned message is precisely
 * one that was NOT sent. Overloading it risks a phantom user turn in the
 * transcript for a message the agent never received.
 */
export interface ChatQueuedReturnedMessage {
  type: "chat:queued_returned";
  payload: {
    projectSlug: string;
    sessionId: string;
    /** The queued text, for the client to put back in its composer. */
    text: string;
    /**
     * The files that were staged on the slot (#728), for the client to put back in
     * its attachment tray. Stop returns the whole message, not just its prose —
     * dropping the files here would be the same silent loss under a different name,
     * and leaving them on the (now cleared) slot would strand them server-side.
     */
    attachments?: Array<{ id: string; filename: string; kind?: string }>;
  };
}

/**
 * A background task was killed at the turn boundary and the keeper is idle
 * (issue #347). Broadcast LIVE by the recovery engine the moment the kill is
 * detected — the notification is otherwise trapped in the SDK input queue until
 * a later turn flushes it, so without this the "keeper is idle / Continue"
 * affordance only appeared after a manual refresh. The client renders it as the
 * amber killed-task notice inline. Gated server-side on `recovery.surfaceKilledTask`.
 */
export interface ChatKilledTaskMessage {
  type: "chat:killed_task";
  payload: {
    projectSlug: string;
    sessionId: string;
    /** The killed `<task-notification>`'s `<summary>`, or a generic fallback. */
    summary: string;
    /** ISO timestamp of detection — used by the client to dedup replays. */
    timestamp: string;
  };
}

/**
 * A keeper turn dead-ended without a normal reply (issue #329): a synthetic
 * subscription/usage-limit hit, the max-turns cap, or an error (network / API
 * 5xx-overloaded / auth / crash). Emitted INLINE during the turn (session-routed
 * like the other turn frames), so the chat surfaces WHY it stopped instead of
 * looking dead. The client renders it as a distinct notice turn (with the reset
 * time for a usage limit, and a Retry/Continue affordance when `retryable`).
 */
export interface ChatNoticeMessage {
  type: "chat:notice";
  payload: Routing & { notice: TurnNotice };
}

export interface PongMessage {
  type: "pong";
}

export type ServerMessage =
  | ChatResponseMessage
  | ChatToolCallMessage
  | ChatToolStartMessage
  | ChatMessageBoundaryMessage
  | ChatCompleteMessage
  | ChatErrorMessage
  | ChatResyncMessage
  | ChatActiveMessage
  | ChatQueuedFlushedMessage
  | ChatQueuedStateMessage
  | ChatQueuedReturnedMessage
  | ChatKilledTaskMessage
  | ChatNoticeMessage
  | PongMessage;

/**
 * Validate an optional wire list of composer attachment refs (#328/#728). Shared
 * by `chat:send` and `chat:set_queue` — the queue carries the same refs the send
 * does, so it validates them the same way rather than by a second, drifting copy.
 * `undefined` is valid (the field is optional everywhere it appears).
 */
function isAttachmentRefList(v: unknown): boolean {
  if (v === undefined) return true;
  if (!Array.isArray(v)) return false;
  for (const a of v) {
    if (!a || typeof a !== "object") return false;
    const ao = a as Record<string, unknown>;
    if (typeof ao.id !== "string" || typeof ao.filename !== "string") return false;
    if (ao.kind !== undefined && typeof ao.kind !== "string") return false;
  }
  return true;
}

export function isClientMessage(data: unknown): data is ClientMessage {
  if (typeof data !== "object" || data === null) return false;
  const m = data as Record<string, unknown>;
  if (m.type === "ping") return true;
  if (m.type === "chat:cancel") {
    const p = m.payload as Record<string, unknown> | undefined;
    return !!p && typeof p.jobId === "string";
  }
  if (m.type === "chat:send") {
    const p = m.payload as Record<string, unknown> | undefined;
    if (!p || typeof p.message !== "string") return false;
    const slug = p.projectSlug;
    if (typeof slug !== "string") return false;
    if (p.preloadContext !== undefined && typeof p.preloadContext !== "boolean") return false;
    if (p.model !== undefined && typeof p.model !== "string") return false;
    if (!isAttachmentRefList(p.attachments)) return false;
    return p.sessionId === undefined || p.sessionId === null || typeof p.sessionId === "string";
  }
  if (m.type === "chat:command") {
    const p = m.payload as Record<string, unknown> | undefined;
    if (!p || typeof p.command !== "string" || p.command.length === 0) return false;
    const slug = p.projectSlug;
    if (typeof slug !== "string") return false;
    return p.sessionId === undefined || p.sessionId === null || typeof p.sessionId === "string";
  }
  if (m.type === "chat:subscribe") {
    const p = m.payload as Record<string, unknown> | undefined;
    if (!p || typeof p.sessionId !== "string" || p.sessionId.length === 0) return false;
    if (p.wantReplay !== undefined && typeof p.wantReplay !== "boolean") return false;
    if (p.lastSeq !== undefined && typeof p.lastSeq !== "number") return false;
    return true;
  }
  if (m.type === "chat:continue") {
    const p = m.payload as Record<string, unknown> | undefined;
    if (!p || typeof p.sessionId !== "string" || p.sessionId.length === 0) return false;
    const slug = p.projectSlug;
    return typeof slug === "string";
  }
  if (m.type === "chat:set_queue") {
    // NOTE: this case was missing until #245 — every chat:set_queue was rejected
    // as "Unknown message", so the server-side queue (#197) never persisted a
    // thing. That's the deeper reason a queued message could strand: the backstop
    // was never armed. Validate leniently (all payload fields optional bar slug).
    const p = m.payload as Record<string, unknown> | undefined;
    if (!p) return false;
    const slug = p.projectSlug;
    if (typeof slug !== "string") return false;
    if (p.sessionId !== undefined && p.sessionId !== null && typeof p.sessionId !== "string")
      return false;
    if (p.text !== undefined && p.text !== null && typeof p.text !== "string") return false;
    if (p.ts !== undefined && p.ts !== null && typeof p.ts !== "number") return false;
    if (p.qid !== undefined && p.qid !== null && typeof p.qid !== "string") return false;
    // The queued message carries the composer's staged files (#728), validated
    // exactly as `chat:send` validates its own.
    if (!isAttachmentRefList(p.attachments)) return false;
    return true;
  }
  return false;
}

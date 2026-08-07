/**
 * WebSocket chat transport.
 *
 * Protocol (the contract the frontend agent matches):
 *
 *   client -> server:
 *     { type: "chat:send", payload: {
 *         projectSlug: string,        // workspace key: a project slug, or "" for the root
 *         sessionId: string | null,   // resume an existing chat, or null = new
 *         message: string,
 *         preloadContext?: boolean,   // new chat: prepend the project OVERVIEW.md
 *         model?: string,             // per-chat model override (a known model id)
 *     } }
 *     { type: "chat:cancel", payload: { jobId } }   // optional: stop a running turn
 *     { type: "ping" }
 *
 *   server -> client (all carry projectSlug + sessionId + jobId for routing):
 *     { type: "chat:response",         payload: { projectSlug, sessionId, jobId, chunk } }
 *     { type: "chat:tool_call",        payload: { projectSlug, sessionId, jobId,
 *                                                  toolName, inputSummary, output,
 *                                                  isError, durationMs } }
 *     { type: "chat:message_boundary", payload: { projectSlug, sessionId, jobId } }
 *     { type: "chat:complete",         payload: { projectSlug, sessionId, jobId, success, error?,
 *                                                  model?, usage? } }
 *         // model: the model the turn ran on (lastModel ?? effectiveModel).
 *         // usage: { inputTokens, outputTokens, cacheReadTokens,
 *         //          cacheCreationTokens, contextTokens, contextLimit } — the
 *         //          LAST per-turn usage observed; omitted (with model) if none.
 *         //          contextTokens = input + cacheRead + cacheCreation;
 *         //          contextLimit  = getContextLimit(model). Stale-by-one-turn
 *         //          by design (it reflects the just-completed turn's input).
 *     { type: "chat:injected",         payload: { projectSlug, sessionId, jobId,
 *                                                  sender, content, timestamp } }
 *         // A machine-injected user turn (issue #290 Part 2): another chat
 *         // send_message'd / a schedule fired into this session. Emitted so a
 *         // client already viewing the recipient chat renders the injected user
 *         // bubble LIVE (with its sender attribution) instead of only seeing the
 *         // assistant reply and needing a refresh. `sender` is the MessageSender.
 *     { type: "chat:error",            payload: { projectSlug, error } }
 *     { type: "pong" }
 *
 * Streaming is wired for real via HerdctlService.chat()'s onMessage callback
 * (the public trigger API supports it). The SDKMessage -> chat-event translation
 * (assistant text deltas, message boundaries, and paired tool_use -> tool_result
 * calls enriched with input summaries + wall-clock durations) is done by
 * @herdctl/chat's `createSDKMessageHandler` — the shared, transport-agnostic
 * translator every herdctl chat surface uses — so paddock no longer reimplements
 * it (and as of @herdctl/chat@0.4.1 it pairs CLI tool results correctly, so the
 * prior `normalizeForTranslator` shim is gone). We compose it with a tiny wrapper
 * that also captures, from each raw SDK message, the session id and the per-turn
 * usage + model (the translator only exposes text/boundary/tool events).
 */
import { randomUUID } from "node:crypto";
import type { WebSocket } from "@fastify/websocket";
import type {
  SDKMessage,
  RuntimeSession,
  SessionWakeEntry,
  InjectedMcpServerDef,
} from "@herdctl/core";
import { createSDKMessageHandler, type SDKMessage as ChatSDKMessage } from "@herdctl/chat";
import {
  extractSubagentLaunches,
  subagentLaunchFields,
  type SubagentLaunch,
} from "./subagents.js";
import {
  keeperAgentName,
  keeperSlugFromAgent,
} from "./herdctl.js";
import { consumeResumedTurn } from "./resume-drain.js";
import {
  isKnownModel,
  getContextLimit,
  DEFAULT_MODEL,
  isKnownDriveMode,
  type DriveMode,
} from "./models.js";
import { SessionHub, type TurnHandle, type ActiveInfo, type HubSocket } from "./session-hub.js";
import { partsOf } from "./queued-message.js";
import { resolveAttachmentsConfig } from "./attachments-config.js";
import { wrapAttachments, inferAttachmentKind, type PromptAttachment } from "./attachments-hint.js";
import { sendFileServerDef, SEND_FILE_SERVER_KEY } from "./send-file-mcp.js";
import { SELF_MCP_SERVER_KEY } from "./self-mcp.js";
import { HUMAN_ROOT } from "./run-provenance.js";
import { resolveRecoveryConfig } from "./recovery-config.js";
import {
  noticeFromMessage,
  errorNotice,
  messageProducedReply,
  suppressNoticeAfterReply,
  turnEffectivelySucceeded,
  type TurnNotice,
} from "./turn-notice.js";
import { resolveHooksMcpEnabled } from "./hook-config.js";

// --- protocol + usage math (extracted #403) ---------------------------------
// The wire protocol (message interfaces + unions + `isClientMessage`) and the
// per-turn token/usage helpers now live in ws-protocol.ts. Re-export the whole
// surface so external importers (and tests) that `import … from "./ws.js"`
// resolve unchanged, then pull in the handful this module uses directly.
export * from "./ws-protocol.js";
import type { ChatHandlerDeps } from "./ws-context.js";
// forkKickoffPrompt + buildSelfMcpServerDef now live in ws-self-mcp.ts; re-export
// forkKickoffPrompt so external importers (and its test) resolve it via ws.js.
export { forkKickoffPrompt } from "./ws-self-mcp.js";
import { buildSelfMcpServerDef } from "./ws-self-mcp.js";
import { makeTurnEngine, isSidechainMessage } from "./ws-turn.js";
// RECOVERY_NUDGE now lives in ws-turn.ts; re-export so its test resolves via ws.js.
export { RECOVERY_NUDGE } from "./ws-turn.js";
import {
  extractLocalCommandOutput,
  initTurnUsage,
  foldTurnUsage,
  resolveTurnUsage,
  isClientMessage,
  type TurnUsageState,
  type ChatSendMessage,
  type ChatCommandMessage,
  type ChatSubscribeMessage,
  type ChatSetQueueMessage,
  type ChatContinueMessage,
  type Routing,
  type ChatCompleteUsage,
  type ChatActiveMessage,
  type ServerMessage,
} from "./ws-protocol.js";



/**
 * Register the /ws route handler. Pure transport: it validates messages,
 * resolves the target agent, and streams a real trigger back to the socket.
 */
// Server-side keepalive: how often to ping each client and, if the previous
// ping went unanswered, reap the dead socket. Protocol-level ping frames also
// keep intermediaries (proxies/NAT) from evicting an otherwise-idle connection.
// See issue #46.
const SERVER_PING_INTERVAL_MS = 30_000;

// Separator in a composite in-memory key; a NUL can't occur in an agent name or
// a UUID. Spelled as an escape, never a raw 0x00 byte — a literal NUL makes
// ripgrep/grep treat this file as binary and skip it during directory traversal
// (silently, exit 1, indistinguishable from "no matches"). See issue #570.
const KEY_SEP = "\u0000";


/**
 * Cap on a single queued message. The sidecar is rewritten in full on every queue
 * mutation and the text is persisted verbatim, so an unbounded queue is a cheap
 * way to bloat the data dir (a 2 MB `chat:set_queue` was accepted as-is). Well
 * above any hand-typed follow-up, including a pasted stack trace.
 */
const MAX_QUEUED_CHARS = 100_000;

/**
 * The opaque identity of the client queue a `chat:set_queue` belongs to (#736).
 *
 * Whatever the client supplies is used for EQUALITY ONLY — never compared as a
 * clock — so a skewed clock can't poison anything. A legacy client sends only the
 * enqueue `ts`, which is folded into an id (still a perfectly good per-client
 * identity, just no longer an ordering). A client that sends neither gets a fresh
 * id, so its queue is always treated as new: with nothing stable to match on, the
 * safe failure is to send the message rather than to discard it.
 */
function queueIdOf(payload: { qid?: string | null; ts?: number | null }): string {
  if (typeof payload.qid === "string" && payload.qid.length > 0) return payload.qid;
  if (typeof payload.ts === "number") return `ts:${payload.ts}`;
  return `anon:${randomUUID()}`;
}

export function makeChatHandler(deps: ChatHandlerDeps) {
  // ONE hub shared across every socket this handler serves: it tracks each
  // session's in-flight turn and fans its frames out to whichever socket(s) are
  // currently attached, so a turn survives the death of the socket that started
  // it (issue #54). See session-hub.ts.
  const hub = new SessionHub();

  // Per-session marker of the queued messages the server has already drained
  // (#245), keyed `agent \0 sessionId`. Lets a drain skip a message it already
  // sent — e.g. a stale localStorage copy a reloaded client re-asserts — instead
  // of double-sending. In-memory (shared across this handler's sockets); a rare
  // double-send only survives a server restart, when the persisted store is
  // already empty anyway.
  //
  // A queued message's identity is the (queue id, text) TUPLE, matched by
  // EQUALITY (#628/#736). The client KEEPS one queue id when APPENDING to an
  // existing queue (#245 stable identity), so "same id, different text" is a
  // genuinely new message — deduping on the id alone would silently destroy the
  // appended text.
  //
  // This used to be a (ts, text) tuple with an ORDERING rule on top: anything
  // older than the last flushed ts was "stale by construction, timestamps being
  // monotonic". They are monotonic within ONE client — but the ts came from
  // whichever browser queued the message, so a single client with a fast clock
  // parked the marker in the future and every subsequent queued message on that
  // chat, from ANY client, was silently destroyed until wall-clock time caught up
  // (#736). Equality assumes nothing about clocks, so the ordering rule is gone;
  // in exchange every flushed id has to be remembered rather than just the newest.
  //
  // Bounded on both axes: MAX_FLUSHED_SESSIONS chats, MAX_FLUSHED_IDS ids each,
  // oldest evicted first (insertion-ordered Maps). Overflow can only cost a rare
  // double-send of a re-asserted message, the same exposure a server restart has.
  const lastFlushed = new Map<string, Map<string, Set<string>>>();
  const MAX_FLUSHED_SESSIONS = 512;
  const MAX_FLUSHED_IDS = 32;
  const MAX_FLUSHED_TEXTS = 8;

  /** This session's flushed-parts ledger (id -> the texts flushed under it). */
  const flushedLedger = (markerKey: string): Map<string, Set<string>> => {
    let m = lastFlushed.get(markerKey);
    if (!m) {
      m = new Map();
      lastFlushed.set(markerKey, m);
      if (lastFlushed.size > MAX_FLUSHED_SESSIONS) {
        lastFlushed.delete(lastFlushed.keys().next().value as string);
      }
    }
    return m;
  };

  /** Record one flushed part, trimming the oldest entries past the bounds. */
  const rememberFlushed = (ledger: Map<string, Set<string>>, id: string, text: string): void => {
    let texts = ledger.get(id);
    if (!texts) {
      texts = new Set();
      ledger.set(id, texts);
      if (ledger.size > MAX_FLUSHED_IDS) ledger.delete(ledger.keys().next().value as string);
    }
    texts.add(text);
    if (texts.size > MAX_FLUSHED_TEXTS) texts.delete(texts.values().next().value as string);
  };

  // Every currently-connected socket, so a turn's start/stop transition can be
  // broadcast to all clients — powering the per-chat sidebar streaming dots that
  // must update even for chats whose pane isn't mounted (issue #53).
  const clients = new Set<WebSocket>();
  const activeFrame = (info: ActiveInfo): ChatActiveMessage => ({
    type: "chat:active",
    payload: {
      projectSlug: info.projectSlug,
      sessionId: info.sessionId,
      jobId: info.jobId,
      running: info.running,
    },
  });
  hub.onActive = (info) => {
    const data = JSON.stringify(activeFrame(info));
    for (const c of clients) {
      if (c.readyState === c.OPEN) {
        try {
          c.send(data);
        } catch {
          /* a socket that throws on send is effectively gone */
        }
      }
    }
  };

  // Drive scheduler-fired session wakes onto the hub (Paddock#111 gap 3). When a
  // keeper scheduled a `ScheduleWakeup` / `/loop`, herdctl reaps the idle session
  // and later resumes it at fire time, handing us the live (managed) session with
  // NO client watching. We stream it exactly like a human turn — same translator,
  // same hub — so the autonomous work lands in the transcript, drives the sidebar
  // streaming dot (via `hub.onActive`), and is replayable by a client that opens
  // the chat later. We do NOT close the session: it's managed, so the reaper tears
  // it down when it goes idle again (and re-captures any fresh wakeups).
  deps.herdctl.onSessionWake(async (session: RuntimeSession, entry: SessionWakeEntry) => {
    // Only KEEPER agents own chats. A wake from a sweeper/trigger/hook agent has
    // no chat to drive, so there is nothing to route.
    const slug = keeperSlugFromAgent(entry.agent);
    // `null` = not a keeper. `""` = the ROOT workspace's own key, so this must
    // stay an explicit null check or every root chat's wake is dropped.
    if (slug === null) return;
    let resolvedSession: string | null = entry.sessionId ?? null;
    const turn: TurnHandle = hub.startTurn(slug, null, entry.sessionId);
    // #353: DON'T stamp a creation origin here. A session wake is a *resume*, not
    // a *creation* — `onSessionWake` only ever resumes an already-existing chat
    // (a human's, or a spawn's, that armed a `ScheduleWakeup`/`/loop`), it never
    // creates one. Genuinely schedule-*created* chats are already stamped
    // `scheduled` at creation by `fireTriggerForProject` → `startAgentTurn`, so
    // dropping the wake stamp loses nothing for them. The old
    // `stampIfAbsent(SCHEDULED_ROOT)` here was a category error: a chat that
    // predates provenance stamping (empty slot) and later arms a ScheduleWakeup
    // would get falsely labelled `scheduled` on its first wake — mislabelling a
    // human-rooted chat. Leaving a legacy/blank chat unstamped renders no badge
    // (the correct outcome for a human chat) instead of a wrong one.
    const routing = (): Routing => ({
      projectSlug: slug,
      sessionId: resolvedSession,
      jobId: turn.jobId,
    });
    // #429: sub-agent launches recovered live from the tool_use input, keyed by
    // toolUseId, so the wake turn's launching card renders enriched + expandable
    // without a refresh (see subagentLaunchFields).
    const wakeLaunches = new Map<string, SubagentLaunch>();
    const translate = createSDKMessageHandler({
      onText: (chunk) => {
        if (chunk) turn.emit({ type: "chat:response", payload: { ...routing(), chunk } });
      },
      onBoundary: () => {
        turn.emit({ type: "chat:message_boundary", payload: routing() });
      },
      onToolStart: (start) => {
        turn.emit({
          type: "chat:tool_start",
          payload: {
            ...routing(),
            toolName: start.toolName,
            inputSummary: start.inputSummary,
            toolUseId: start.toolUseId,
            parentToolUseId: start.parentToolUseId,
            ...subagentLaunchFields(wakeLaunches, start.toolName, start.toolUseId),
          },
        });
      },
      onToolCall: (call) => {
        turn.emit({
          type: "chat:tool_call",
          payload: {
            ...routing(),
            toolName: call.toolName,
            inputSummary: call.inputSummary,
            output: call.output,
            isError: call.isError,
            durationMs: call.durationMs,
            toolUseId: call.toolUseId,
            ...subagentLaunchFields(wakeLaunches, call.toolName, call.toolUseId),
          },
        });
      },
    });
    // #329: surface a dead-end (usage limit / max-turns / error) on this wake
    // turn too, at most once. Same rationale as the interactive path.
    // #380/#394: once the turn has shown the user real prose, an error/max_turns
    // dead-end is a false alarm — suppress it (matching the history path).
    // `wakeProducedReply` is OR-accumulated across every message (a tool-heavy
    // turn's prose rides on a `tool_use` message, not the terminal one). A
    // `usage_limit` still surfaces.
    let wakeNoticeEmitted = false;
    let wakeProducedReply = false;
    const emitWakeNotice = (notice: TurnNotice): void => {
      if (wakeNoticeEmitted) return;
      if (suppressNoticeAfterReply(notice, wakeProducedReply)) return;
      wakeNoticeEmitted = true;
      turn.emit({ type: "chat:notice", payload: { ...routing(), notice } });
    };
    // Per-message wake handling, shared by the fast path and the drain path.
    const onWakeSessionId = (id: string): void => {
      resolvedSession = id;
      turn.setSession(id);
      // #353: no provenance stamp on wake — see the note at the top of this
      // handler. A resume must never write a creation origin.
    };
    const onWakeMessage = async (m: SDKMessage): Promise<void> => {
      // A sub-agent's nested steps never render top-level ({@link isSidechainMessage}).
      if (isSidechainMessage(m)) return;
      if (messageProducedReply(m as Parameters<typeof messageProducedReply>[0]))
        wakeProducedReply = true;
      const notice = noticeFromMessage(m as Parameters<typeof noticeFromMessage>[0]);
      if (notice) emitWakeNotice(notice);
      // #429: recover any Task/Agent launch before translate fires onToolStart.
      for (const l of extractSubagentLaunches(m)) wakeLaunches.set(l.toolUseId, l);
      await translate(m as unknown as ChatSDKMessage);
    };
    try {
      // Resume self-interrupt fix. A woken session that still holds a stale
      // async-input backlog replays it as its OWN turn ahead of the wake turn; the
      // old break-after-first-result then closed the CLI on the backlog turn's
      // result, killing the wake turn. A wake is always a resume, so consume with
      // the queue-drain break rule — break on a `result` only once the async queue
      // has drained (after the LAST/real wake turn). No backlog → breaks after the
      // first result (fast). See ./resume-drain.ts.
      if (entry.sessionId) {
        await consumeResumedTurn(session, {
          residueProbe: () => deps.herdctl.residueDepthFor(entry.agent, entry.sessionId as string),
          onMessage: onWakeMessage,
          onSessionId: onWakeSessionId,
          log: (msg) =>
            // eslint-disable-next-line no-console
            console.log(`[resume-drain] wake ${entry.agent} (${entry.sessionId}): ${msg}`),
        });
      } else {
        for await (const m of session.messages) {
          if (m.session_id) onWakeSessionId(m.session_id);
          await onWakeMessage(m as SDKMessage);
          if (m.type === "result") break;
        }
      }
      turn.emit({
        type: "chat:complete",
        payload: { ...routing(), sessionId: resolvedSession, success: true },
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      emitWakeNotice(errorNotice(error));
      turn.emit({ type: "chat:complete", payload: { ...routing(), success: false, error } });
    } finally {
      turn.end();
    }
    // Post-wake curation sweep, same as a human turn. Fires for EVERY workspace,
    // the root included (its sweeper is `sweeper-_root`, registered at boot) — the
    // emit is unconditional and skips nothing. T5: routed through the `afterTurn`
    // event so the folded-in curator dispatches once.
    emitAfterTurn(slug, resolvedSession ?? null);
  });

  // Turn-execution engine (ws-turn.ts, #403): the mutually-recursive core —
  // trigger cluster, self-MCP injection context, per-turn injected-MCP builders +
  // wake cache, the shared startAgentTurn engine, and Layer-2/3 recovery. Relocated
  // as one scope so its cross-references stay intact; the socket layer below
  // consumes the returned surface.
  const engine = makeTurnEngine({ deps, hub });
  const {
    startAgentTurn,
    wakeInjection,
    selfMcpCtx,
    injectRecoveryNudge,
    recoveryEngine,
    emitAfterTurn,
    composePreloadedPrompt,
    fireTrigger,
    makeBackgroundTurnSink,
  } = engine;

  /**
   * Build the chat operations for ONE connection: the handlers behind every
   * client frame, plus the queue drain they share.
   *
   * A factory rather than plain closures inside {@link handle} because the drain
   * has to run with NO socket at all (#627). A turn started by a trigger, a
   * scheduler wake or a spawn has no originating connection, and a queued
   * follow-up must still go out when it ends — so `socket` is nullable and the
   * ops are built once, socket-less, for those paths (see `headlessOps` below).
   * A socket-less send is a no-op: everything a client needs to see travels over
   * the hub, which fans out to every socket attached to the session.
   */
  const makeChatOps = (socket: HubSocket | null, send: (m: ServerMessage) => void) => {
    /**
     * Manual keeper recovery (issue #301, Layer 2). Re-drive a hung keeper whose
     * background task was killed at the turn boundary by injecting the recovery
     * nudge into its still-alive session via {@link startAgentTurn} — the same
     * workhorse the self-MCP `send_message` / schedule fires use, so the injected
     * turn streams live, lists in the sidebar, and is attributable
     * (`sender: recovery`). Server-authoritative gate: no-op unless the resolved
     * `recovery.surfaceKilledTask` is on for this project, so a stale/rogue client
     * can't re-drive when the operator disabled Layer 2.
     */
    const onChatContinue = async (msg: ChatContinueMessage): Promise<void> => {
      // `""` addresses the ROOT workspace, so only a MISSING key is a no-op.
      const slug = msg.payload.projectSlug;
      if (slug === undefined || slug === null) return;
      const sessionId = msg.payload.sessionId;
      if (!sessionId) return;
      let project: Awaited<ReturnType<typeof deps.projects.get>>;
      try {
        project = await deps.projects.get(slug);
      } catch {
        return; // unknown project — nothing to recover
      }
      // Gate on the resolved Layer 2 flag (per-project override else instance).
      const recovery = resolveRecoveryConfig(project.recovery, deps.cfg.recovery);
      if (!recovery.surfaceKilledTask) return;
      // Re-drive via the shared recovery path (also used by Layer 3 auto-recovery).
      await injectRecoveryNudge(project, sessionId).catch((err) => {
        send({
          type: "chat:error",
          payload: { projectSlug: slug, error: `Recovery failed: ${String(err)}` },
        });
      });
    };

    const onSubscribe = (msg: ChatSubscribeMessage): void => {
      if (!socket) return; // the socket-less ops never receive client frames
      const { sessionId, wantReplay, lastSeq } = msg.payload;
      const result = hub.attach(sessionId, socket, {
        wantReplay: wantReplay === true,
        afterSeq: typeof lastSeq === "number" ? lastSeq : -1,
      });
      if (result.status === "resync") {
        send({
          type: "chat:resync",
          payload: { projectSlug: result.projectSlug, sessionId },
        });
      }
      // Tell a (re)attaching pane whether its session has a live turn, so a chat
      // the user navigated back to restores its Stop button + jobId and streaming
      // indicator immediately — not only once the next frame happens to arrive
      // (issues #52/#53).
      const active = hub.activeInfo(sessionId);
      if (active) send(activeFrame(active));
    };

    // Server-authoritative queue drain (#245): auto-send a persisted queued
    // message as the next turn, exactly once. Called (a) whenever a turn ends —
    // through the hub, so EVERY turn path drains (#627) — and (b) when a queue is
    // set while the session is idle, i.e. a queue that arrived (e.g. via the
    // reconnect outbox) after the turn it was meant to follow already ended.
    // `take` makes the read+clear atomic so two concurrent drains can never both
    // send it; the flushed-parts ledger skips what was already drained (a stale
    // client re-assert on reload) so it isn't sent twice.
    const drainQueue = async (slug: string, sessionId: string): Promise<void> => {
      if (!deps.queuedMessage) return;
      // Another turn is already live on this session (a drain racing a fresh send,
      // or a turn ending while its successor has started). Leave the queue for
      // that turn's own end — sending now would interleave two turns.
      if (hub.isRunning(sessionId)) return;
      const agent = keeperAgentName(slug);
      const queued = await deps.queuedMessage.take(agent, sessionId).catch(() => null);
      if (!queued?.text) return;
      const ledger = flushedLedger(`${agent}${KEY_SEP}${sessionId}`);
      // Have we already sent this? (#628/#736.)
      //
      // Identity is the (id, text) TUPLE, matched by EQUALITY, against every
      // identity the slot has been known by — so a client re-asserting its stored
      // copy on reload is recognised whether it holds the id it sent or the slot
      // version the server broadcast back.
      //
      // It used to be a (ts, text) tuple with an ORDERING rule on top: "older than
      // the last flush ⇒ stale by construction, timestamps being monotonic". They
      // are monotonic within one client, but the ts came from whichever BROWSER
      // queued the message — so a single client with a fast clock left the marker
      // five minutes in the future, and every later queued message on that chat,
      // from any client, was taken, classified already-flushed, deleted and never
      // sent, until wall-clock time caught up (#736). Equality assumes nothing
      // about clocks. An APPEND keeps its identity with LONGER text (#245), so it
      // still reads as a genuinely new message and is sent — #628, unchanged.
      const parts = partsOf(queued);
      const stale = parts.some((p) => ledger.get(p.id)?.has(p.text));
      const text = stale ? "" : queued.text;
      // Tell every attached client (origin + reconnected sockets) to clear its copy
      // of this message. When we're really sending it, carry the text so the client
      // renders the sent bubble in-transcript; on a stale re-assert we only clear.
      hub.broadcast(sessionId, {
        type: "chat:queued_flushed",
        payload: {
          projectSlug: slug,
          sessionId,
          ...(text ? { text } : {}),
        },
      });
      if (!text) return;
      // Every identity this slot carried is now flushed, so a re-assert from any
      // client that held one of them is recognised rather than sent again.
      for (const p of parts) rememberFlushed(ledger, p.id, p.text);
      // Broadcast the flush frame BEFORE kicking the turn so the user bubble renders
      // above the reply. Run it detached, like a human send. A leading-slash queued
      // message is a slash command (e.g. "/compact"): route it through the command
      // path so the CLI dispatches it — matching how the composer sends one live.
      if (text.startsWith("/")) {
        void onChatCommand({
          type: "chat:command",
          payload: { projectSlug: slug, command: text, sessionId },
        });
      } else {
        void onChatSend({
          type: "chat:send",
          payload: { projectSlug: slug, sessionId, message: text },
        });
      }
    };

    const onSetQueue = async (msg: ChatSetQueueMessage): Promise<void> => {
      if (!deps.queuedMessage) return; // feature disabled
      // `""` addresses the ROOT workspace, so only a MISSING key is a no-op.
      const slug = msg.payload.projectSlug as string | undefined;
      if (slug === undefined || slug === null) return;
      const sessionId = msg.payload.sessionId ?? null;
      const text = msg.payload.text ?? null;
      // Every chat belongs to a workspace keeper.
      const agent = keeperAgentName(slug);
      if (!sessionId) {
        // New chat: queue isn't stored until the session id exists. The client
        // re-asserts it (same qid) once the id resolves, so it persists then.
        return;
      }
      // Store or clear the queued message.
      if (text && text.trim().length > 0) {
        // A queued message is persisted verbatim and the whole sidecar is rewritten
        // on every mutation, so an unbounded one is a cheap way to bloat the data
        // dir. Refuse it loudly rather than silently truncating the user's text.
        if (text.length > MAX_QUEUED_CHARS) {
          send({
            type: "chat:error",
            payload: {
              projectSlug: slug,
              error: `Queued message is too long (${text.length} characters; the limit is ${MAX_QUEUED_CHARS}).`,
            },
          });
          return;
        }
        // Merge into the chat's single slot rather than overwriting it (#629). The
        // id the client wrote under says which this is: a client editing the slot
        // it can currently see (replace) or one that queued without knowing what
        // was already there (append). The old unconditional overwrite destroyed the
        // first client's message with no signal to anyone — and then rendered it,
        // in that client's own transcript, as a user bubble they never typed.
        const next = await deps.queuedMessage
          .upsert(agent, sessionId, { id: queueIdOf(msg.payload), text }, Date.now(), randomUUID)
          .catch(() => undefined);
        // The queue is shared chat state, so announce it: every attached client
        // renders the same slot, and echoing `qid` back on its next write is how a
        // client proves it is editing the slot as it stands rather than replacing
        // someone else's text with its own.
        if (next !== undefined) {
          hub.broadcast(sessionId, {
            type: "chat:queued_state",
            payload: {
              projectSlug: slug,
              sessionId,
              text: next?.text ?? null,
              ...(next?.id ? { qid: next.id } : {}),
            },
          });
        }
        // If no turn is running, this queue arrived after the turn it was meant to
        // follow already ended — drain it now rather than wait for a completion
        // that won't come (the reported stranding bug, #245).
        if (!hub.isRunning(sessionId)) await drainQueue(slug, sessionId);
      } else {
        // A clear wipes the WHOLE slot, including another client's contribution:
        // with the state broadcast the chip is shared, so clearing it is a
        // deliberate act on something the user can actually see.
        await deps.queuedMessage.set(agent, sessionId, null).catch(() => undefined);
        hub.broadcast(sessionId, {
          type: "chat:queued_state",
          payload: { projectSlug: slug, sessionId, text: null },
        });
      }
    };

    const onChatSend = async (msg: ChatSendMessage): Promise<void> => {
      const slug = msg.payload.projectSlug as string;
      const { message, sessionId, preloadContext, attachments: sentAttachments } = msg.payload;
      const isNewChat = sessionId === undefined || sessionId === null;
      // A genuine human message resets this session's Layer 3 recovery guard (issue
      // #301) and cancels any in-flight watch, so the retry cap counts auto re-drives
      // BETWEEN human messages and a later real hang is recovered fresh.
      if (sessionId) recoveryEngine.onHumanMessage(sessionId);
      let jobId: string | null = null;
      let resolvedSession: string | null = sessionId ?? null;
      // One-shot guard: a brand-new chat is attributed to its agent the instant
      // its session id first streams back, so it lists in the sidebar mid-turn
      // instead of only after the turn completes (issue #100). Resumed chats are
      // already attributed, so this only runs for a new chat.
      let attributed = false;
      // Track this turn in the session hub so its frames fan out to whichever
      // socket(s) are attached — not just this one — and a reconnecting client
      // can re-attach + replay the missed gap (issue #54). A resumed chat's id is
      // known now (re-attachable from frame 0); a new chat registers once the id
      // arrives mid-stream (see turn.setSession below).
      const turn: TurnHandle = hub.startTurn(slug, socket, sessionId ?? null);
      // Per-turn usage + model captured off the SDK stream (last non-null wins).
      // Held on a mutable record (not bare `let`s) so the values assigned inside
      // the streaming callback are visible to control-flow analysis afterwards.
      const seen: TurnUsageState = initTurnUsage();
      // The model the turn will run on; resolved below once we know the target.
      let effectiveModel: string = DEFAULT_MODEL;
      // How this turn is driven (Paddock#111): the global default unless the
      // workspace overrides it (resolved in the workspace branch below).
      let driveMode: DriveMode = deps.cfg.driveMode;
      // The agent's working directory, so the send_file tool can resolve a real
      // `file_path` (and sandbox it). Resolved alongside the agent below.
      let sendFileWorkingDir: string | undefined;

      const routing = (): Routing => ({
        projectSlug: slug,
        sessionId: resolvedSession,
        jobId,
      });

      // #329: surface a turn dead-end (usage limit / max-turns / error) inline, at
      // most once per turn — a synthetic session-limit reply repeats several times,
      // and a failed turn can carry both an error `result` and a `success:false`
      // completion. Emit the first, suppress the rest.
      let noticeEmitted = false;
      // #380: whether a COMPLETE assistant reply already streamed this turn. In
      // session mode the SDK's terminal `result` (streamed live, never persisted)
      // can carry an `error_*` subtype / `success:false` AFTER a good `end_turn`
      // reply, painting a false "turn failed" banner beneath the answer. Once a
      // reply is seen we suppress the error/max_turns dead-end — the same guard the
      // history path (`scanTranscriptNotice`) already applies on reload. A
      // `usage_limit` dead-end still surfaces (a session-limit stop is real).
      let producedReply = false;
      const emitNotice = (notice: TurnNotice): void => {
        if (noticeEmitted) return;
        if (suppressNoticeAfterReply(notice, producedReply)) return;
        noticeEmitted = true;
        turn.emit({ type: "chat:notice", payload: { ...routing(), notice } });
      };

      // #429: sub-agent launches recovered live from the tool_use input, keyed by
      // toolUseId, so a launching card shows the real type/title + is expandable into
      // its (streaming) steps without a refresh. Populated in onMessage before each
      // translate; read by the onToolStart/onToolCall closures via subagentLaunchFields.
      const subagentLaunches = new Map<string, SubagentLaunch>();
      // @herdctl/chat's shared translator turns the SDKMessage stream into the
      // three UI events we forward over the socket. Created fresh per turn (it
      // holds per-turn tool-pairing state).
      const translate = createSDKMessageHandler({
        onText: (chunk) => {
          if (chunk) turn.emit({ type: "chat:response", payload: { ...routing(), chunk } });
        },
        onBoundary: () => {
          turn.emit({ type: "chat:message_boundary", payload: routing() });
        },
        onToolStart: (start) => {
          turn.emit({
            type: "chat:tool_start",
            payload: {
              ...routing(),
              toolName: start.toolName,
              inputSummary: start.inputSummary,
              toolUseId: start.toolUseId,
              parentToolUseId: start.parentToolUseId,
              ...subagentLaunchFields(subagentLaunches, start.toolName, start.toolUseId),
            },
          });
        },
        onToolCall: (call) => {
          turn.emit({
            type: "chat:tool_call",
            payload: {
              ...routing(),
              toolName: call.toolName,
              inputSummary: call.inputSummary,
              output: call.output,
              isError: call.isError,
              durationMs: call.durationMs,
              toolUseId: call.toolUseId,
              ...subagentLaunchFields(subagentLaunches, call.toolName, call.toolUseId),
            },
          });
        },
      });

      try {
        // Every workspace key resolves to a keeper (`keeper-<slug>`), including
        // the root's `keeper-_root` (its key is `""`, encoded via `agentKeyFor`).
        let agentName: string;
        // Effective prompt — may be augmented with the project overview below.
        let prompt = message;
        // Whether this project agent gets the T3 unified trigger-management tools
        // (resolved from the project's REUSED hooks-MCP `hooksMcpEnabled` override
        // else the instance default).
        let includeTriggers = false;
        const requested = msg.payload.model;
        {
          // Verifies the project exists (throws if not); we keep the object so
          // we can resolve its model + re-register the keeper for an override.
          const project = await deps.projects.get(slug);
          agentName = keeperAgentName(slug);
          sendFileWorkingDir = project.dir;

          // Project chat: a valid override wins, else the project's model. Then
          // ensure the (shared) keeper is registered at that model before the
          // trigger. NOTE single-user last-write-wins caveat (see herdctl.ts).
          effectiveModel =
            requested && isKnownModel(requested) ? requested : project.model;
          await deps.herdctl.ensureAgentModel(project, effectiveModel);

          // Per-project driveMode override wins over the global default
          // (Paddock#111). An absent/invalid value inherits the global.
          driveMode =
            project.driveMode && isKnownDriveMode(project.driveMode)
              ? project.driveMode
              : deps.cfg.driveMode;

          // T3 trigger-management gate (REUSES the hooks-MCP gate): the per-project
          // override wins, else the instance default. Only takes effect when the
          // write tools are also on (the trigger tools live in the write block).
          includeTriggers =
            deps.cfg.selfMcpWriteEnabled &&
            resolveHooksMcpEnabled(project.hooksMcpEnabled, deps.cfg.hooksMcpEnabled);

          // Composer attachments (issue #328): validate the uploaded files against
          // this project's effective attachment config, then prepend a
          // `<paddock-attachments>` hint block pointing the keeper's Read tool at
          // the stored files' absolute paths. Wrapped BEFORE preload so the whole
          // thing nests inside the preload block. Invalid/missing/over-count
          // attachments are dropped (defensive — the endpoint already gated them).
          if (sentAttachments && sentAttachments.length > 0) {
            const acfg = resolveAttachmentsConfig(project.attachments, deps.cfg.attachments);
            if (acfg.enabled) {
              const promptAtts: PromptAttachment[] = [];
              for (const a of sentAttachments.slice(0, acfg.maxFilesPerMessage)) {
                const abs = deps.attachments.absolutePath(a.id);
                if (!abs || !(await deps.attachments.exists(a.id))) continue;
                promptAtts.push({
                  id: a.id,
                  filename: a.filename,
                  kind: inferAttachmentKind(a.filename),
                  path: abs,
                });
              }
              prompt = wrapAttachments(promptAtts, prompt);
            }
          }

          // Context preload (issues #1/#188): only for a NEW chat, only when
          // asked. Shared with the self-MCP create_chat path (C2 / #264):
          // injects BOTH OVERVIEW.md and CHANGELOG.md when the project has
          // curated state, else leaves the prompt untouched. Wraps the (possibly
          // attachment-wrapped) `prompt`, not the bare `message`.
          if (isNewChat && preloadContext) {
            prompt = await composePreloadedPrompt(slug, prompt);
          }
        }

        // Inject the Paddock send_file MCP tool for this turn. The tool returns a
        // JSON envelope as its result `output`; the web renders it off the tool
        // call itself (live + on reload), so no bespoke WS frame is needed. The
        // working dir resolves a relative `file_path`; a real file's bytes are
        // copied into the attachment store at send time (immutable snapshot).
        const sendFile = sendFileServerDef({
          workingDirectory: sendFileWorkingDir,
          saveAttachment: (bytes, name) => deps.attachments.save(bytes, name),
        });
        const injectedMcpServers: Record<string, InjectedMcpServerDef> = {
          [SEND_FILE_SERVER_KEY]: sendFile,
        };

        // Self-management MCP (issue #214): only on keeper turns, and only when
        // the instance opts in via PADDOCK_SELF_MCP. A HUMAN turn is
        // the ROOT of any spawn tree (origin human, depth 0), so its children are
        // depth 1 — the same builder the spawned path uses, just seeded with
        // HUMAN_ROOT. Write tools follow the instance write opt-in (B1 #262: the
        // shared builder is extracted so both paths agree). Depth-0 human gating is
        // unchanged from before B1 — the depth bound governs the spawned path only.
        if (deps.cfg.selfMcpEnabled) {
          injectedMcpServers[SELF_MCP_SERVER_KEY] = buildSelfMcpServerDef(selfMcpCtx, {
            currentProjectSlug: slug,
            currentSessionId: () => resolvedSession ?? sessionId ?? null,
            parentProvenance: HUMAN_ROOT,
            includeWrite: deps.cfg.selfMcpWriteEnabled,
            includeTriggers,
            // Project provisioning (#467) rides on the write block behind its own
            // instance flag — no per-project override, so nothing to resolve here.
            includeProjects: deps.cfg.selfMcpWriteEnabled && deps.cfg.selfMcpProjectsEnabled,
          });
        }

        // Session mode drives a persistent, herdctl-managed openChatSession so
        // cross-turn autonomy (ScheduleWakeup / `/loop`) survives the turn
        // boundary; batch mode keeps the legacy one-shot trigger. Both stream
        // through the identical onMessage/onJobCreated contract (Paddock#111).
        const drive =
          driveMode === "session"
            ? deps.herdctl.chatSession.bind(deps.herdctl)
            : deps.herdctl.chat.bind(deps.herdctl);
        // Gap B sink (session mode): one persistent sink groups every background
        // re-invocation onto a single hub turn (skipping sidechain sub-agent
        // steps). Built once so its turn/translator state spans the stream.
        const bgSink = driveMode === "session" ? makeBackgroundTurnSink(slug) : null;
        const result = await drive(agentName, {
          prompt,
          // omit -> agent-level fallback; explicit null -> new chat; id -> resume.
          resume: sessionId ?? null,
          triggerType: "web",
          injectedMcpServers,
          // Gap B: deliver autonomous background-completion turns live (session
          // mode only; batch `chat` ignores this). The human turn holds the
          // session open when it launches background work; the persistent sink
          // renders each later re-invocation onto ONE hub turn (skipping sidechain
          // sub-agent steps).
          onBackgroundMessage: bgSink?.onMessage,
          onBackgroundDone: bgSink?.onDone,
          onJobCreated: (id) => {
            jobId = id;
            turn.setJobId(id);
          },
          onMessage: async (m: SDKMessage) => {
            // A FOREGROUND sub-agent streams its nested steps INLINE on this very
            // stream, tagged `parent_tool_use_id`. They belong inside the sub-agent
            // card (served by the subagents endpoint), never as top-level rows of
            // the parent transcript — see {@link isSidechainMessage}. This is the
            // human `chat:send` path, so it is where the duplication was actually
            // seen. Skipping also keeps a sub-agent's context out of the parent's
            // live meter (`foldTurnUsage` below would latch its max — the #398 shape).
            if (isSidechainMessage(m)) return;
            // Capture the session id as it arrives mid-stream (the translator
            // only surfaces text/boundary/tool events, not routing metadata).
            // Registering it with the hub makes the turn re-attachable by session.
            if (m.session_id) {
              resolvedSession = m.session_id;
              // #390: remember this human turn's injected servers so a wake this
              // chat self-schedules can replay them (the common flap scenario).
              wakeInjection.remember(m.session_id, injectedMcpServers);
              // For a NEW chat, attribute the session to its agent BEFORE the
              // hub broadcasts `chat:active`, so any client refetching its chat
              // list in response is guaranteed to see the now-listed chat — it
              // no longer waits for the turn to complete (issue #100). Awaited
              // once (a quick local job-record write); never fatal to the turn.
              if (isNewChat && !attributed) {
                attributed = true;
                // Non-fatal: on failure the chat simply falls back to appearing
                // once its turn completes (the prior behavior), never breaking
                // the live stream.
                await deps.herdctl
                  .attributeRunningSession(m.session_id, agentName)
                  .catch(() => undefined);
                // A1 (#261): a human-started chat is the ROOT of any spawn tree —
                // origin human, depth 0. Stamped once at creation; later turns on
                // this chat never change its recorded provenance.
                await deps.runProvenance?.stamp(m.session_id, HUMAN_ROOT).catch(() => undefined);
              }
              turn.setSession(m.session_id);
            }
            // Capture per-turn usage + model defensively. Assistant blocks feed
            // the context snapshot (keeping the largest — issue #165); the terminal
            // `result` block's CUMULATIVE usage is stashed separately so it can't
            // inflate the live context meter (#398).
            foldTurnUsage(seen, m);
            // #329: surface a dead-end BEFORE translating — a synthetic usage-limit
            // message or a terminal error/`error_max_turns` result. The translator
            // silently drops every synthetic message (which is exactly why these
            // turns look dead); `noticeFromMessage` returns null for ordinary output
            // and for suppressed "No response requested." placeholders.
            // #380: track a completed reply so a trailing error/max_turns result
            // (which races in AFTER the reply in session mode) is suppressed below.
            if (messageProducedReply(m as Parameters<typeof messageProducedReply>[0]))
              producedReply = true;
            const notice = noticeFromMessage(m as Parameters<typeof noticeFromMessage>[0]);
            if (notice) emitNotice(notice);
            // #429: recover any Task/Agent launch from this message's tool_use input
            // so the enriched card renders live — before translate fires onToolStart.
            for (const l of extractSubagentLaunches(m)) subagentLaunches.set(l.toolUseId, l);
            // @herdctl/core's SDKMessage types `message` as `unknown` (wider);
            // @herdctl/chat's translator declares a structurally narrower
            // SDKMessage. Same runtime object — cast across the package boundary.
            // (@herdctl/chat@0.4.1 pairs CLI tool results, so no shim needed.)
            await translate(m as unknown as ChatSDKMessage);
          },
        });

        // #404: session-mode turns that produced a real reply routinely end with a
        // trailing `error_*` / `success:false` result frame (the #380/#394 banner
        // asymmetry). Raw `result.success` is reply-unaware, so gating the post-turn
        // side effects below on it silently strands a queued follow-up, skips the
        // sweep, and drops the recovery arm. Trust the same `producedReply` signal
        // the banner already does — a real reply supersedes a benign trailing failure.
        const effectiveSuccess = turnEffectivelySucceeded(result.success, producedReply);

        // Post-turn sweep (issues #2/#6): on a successful USER turn, enqueue a
        // coalesced/debounced curation sweep. Out of band — never blocks or breaks
        // chat, and can't recurse (the sweep uses a separate agent triggered off
        // the user-chat path). Turn success is the ONLY gate: every workspace is
        // swept, the root included (`sweeper-_root`).
        // T5: routed through the `afterTurn` event so the folded-in `curate-overview`
        // trigger is the single dispatch (no double-curation).
        if (effectiveSuccess) emitAfterTurn(slug, result.sessionId ?? resolvedSession ?? null);

        // Force a session-list refresh so a brand-new chat surfaces immediately
        // (rather than waiting out the discovery cache). Non-fatal.
        try {
          deps.herdctl.invalidateSessions(agentName);
        } catch {
          /* non-fatal: stale-by-30s at worst */
        }

        // Surface the model + usage so the UI can render the context meter.
        // Omit both if no usage was observed this turn (§7).
        const completeModel = seen.model ?? effectiveModel;
        const seenUsage = resolveTurnUsage(seen);
        const completeUsage: ChatCompleteUsage | undefined = seenUsage
          ? {
              inputTokens: seenUsage.inputTokens,
              outputTokens: seenUsage.outputTokens,
              cacheReadTokens: seenUsage.cacheReadTokens,
              cacheCreationTokens: seenUsage.cacheCreationTokens,
              contextTokens:
                seenUsage.inputTokens +
                seenUsage.cacheReadTokens +
                seenUsage.cacheCreationTokens,
              contextLimit: getContextLimit(completeModel),
            }
          : undefined;

        // Ensure the turn is keyed under its final session id before the terminal
        // frame, so a client re-attaching right at the end gets the completion.
        const finalSession = effectiveSuccess ? (result.sessionId ?? resolvedSession) : resolvedSession;
        if (finalSession) turn.setSession(finalSession);
        // #329: a turn that failed WITHOUT a terminal error `result` reaching the
        // stream (a thrown/rejected drive: network reset, process crash) never hit
        // noticeFromMessage. Surface it inline so the failure is visible — before
        // chat:complete flips streaming off (deduped against any notice already sent).
        if (!result.success) emitNotice(errorNotice(result.error?.message));
        turn.emit({
          type: "chat:complete",
          payload: {
            ...routing(),
            sessionId: finalSession,
            jobId: result.jobId ?? jobId,
            success: result.success,
            error: result.error?.message,
            ...(completeUsage ? { model: completeModel, usage: completeUsage } : {}),
          },
        });
        // Ending the turn drains any queued follow-up (#197/#245) via the hub's
        // turn-end hook — the ONE place every turn path converges (#627), rather
        // than this call site alone. It no longer waits for a SUCCESSFUL turn:
        // holding the queue on a failed/Stopped turn didn't keep it for the user,
        // it stranded it, to be flushed by the NEXT `chat:send` — landing behind a
        // message typed later, with a stale chip in between. See drainQueue.
        turn.end();

        // Layer 3 (issue #301): arm a post-turn recovery watch for a session-mode
        // keeper turn. If this turn launched a background task that the runtime kills
        // at the turn boundary (herdctl#374) and the keeper doesn't wake on its own,
        // the engine auto-injects the recovery nudge — gated on the resolved
        // `recovery.autoReDrive` (default OFF), a debounce window, and a retry cap.
        if (effectiveSuccess && finalSession && driveMode === "session") {
          recoveryEngine.armWatch({ slug, sessionId: finalSession });
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        // The origin socket always gets the plain chat:error (its shape predates
        // the hub and existing clients/tests rely on it). If the turn had already
        // resolved a session, ALSO emit a terminal chat:complete through the hub
        // so a client that re-attached after a mid-turn socket drop stops showing
        // "streaming" instead of hanging with no terminal frame.
        send({ type: "chat:error", payload: { projectSlug: slug, error } });
        if (resolvedSession) {
          // #329: also surface the failure as an inline notice on the hub so a
          // re-attached client renders WHY the turn died (not just the origin
          // socket's chat:error toast).
          emitNotice(errorNotice(error));
          turn.emit({
            type: "chat:complete",
            payload: { ...routing(), success: false, error },
          });
        }
        turn.end();
      }
    };

    /**
     * Handle a slash command (`chat:command`) by driving herdctl's streaming
     * session. Output is streamed back over the same events as a normal turn;
     * a `compact_boundary` is surfaced as a synthetic assistant note so the UI
     * shows a visible confirmation, and post-command usage refreshes the meter.
     */
    const onChatCommand = async (msg: ChatCommandMessage): Promise<void> => {
      const slug = msg.payload.projectSlug as string;
      const { command, sessionId } = msg.payload;
      let resolvedSession: string | null = sessionId ?? null;
      // The turn id Stop cancels this command by (#632). Hardcoded `null` until
      // now, so a `/compact` was permanently un-stoppable: the client's cancel is
      // guarded by `if (meta.jobId)`, and even the deferred pre-arm cancel (#196)
      // waited forever for an id that never arrived.
      let jobId: string | null = null;
      const seen: TurnUsageState = initTurnUsage();
      // Same hub-tracked turn as onChatSend so a slash-command turn also survives
      // a mid-turn socket drop (issue #54). A command always targets an existing
      // session, so it's re-attachable from its first frame.
      const turn: TurnHandle = hub.startTurn(slug, socket, sessionId ?? null);

      const routing = (): Routing => ({
        projectSlug: slug,
        sessionId: resolvedSession,
        jobId,
      });

      // #429: sub-agent launches recovered live from the tool_use input (a command
      // like a custom slash-command can still spawn a Task/Agent), keyed by toolUseId.
      const subagentLaunches = new Map<string, SubagentLaunch>();
      const translate = createSDKMessageHandler({
        onText: (chunk) => {
          if (chunk) turn.emit({ type: "chat:response", payload: { ...routing(), chunk } });
        },
        onBoundary: () => {
          turn.emit({ type: "chat:message_boundary", payload: routing() });
        },
        onToolStart: (start) => {
          turn.emit({
            type: "chat:tool_start",
            payload: {
              ...routing(),
              toolName: start.toolName,
              inputSummary: start.inputSummary,
              toolUseId: start.toolUseId,
              parentToolUseId: start.parentToolUseId,
              ...subagentLaunchFields(subagentLaunches, start.toolName, start.toolUseId),
            },
          });
        },
        onToolCall: (call) => {
          turn.emit({
            type: "chat:tool_call",
            payload: {
              ...routing(),
              toolName: call.toolName,
              inputSummary: call.inputSummary,
              output: call.output,
              isError: call.isError,
              durationMs: call.durationMs,
              toolUseId: call.toolUseId,
              ...subagentLaunchFields(subagentLaunches, call.toolName, call.toolUseId),
            },
          });
        },
      });

      try {
        // Commands need an existing chat to act on; the slug resolves to its
        // project's keeper (verifying the project exists).
        await deps.projects.get(slug); // throws if the project is unknown
        const agentName = keeperAgentName(slug);

        const { sessionId: finalSession } = await deps.herdctl.runCommand(agentName, {
          command,
          resume: resolvedSession,
          // Arm Stop the moment the session exists (#632) — the same contract
          // onChatSend uses, so the client renders and can fire Stop while the
          // command is still working.
          onJobCreated: (id) => {
            jobId = id;
            turn.setJobId(id);
          },
          onMessage: async (m: SDKMessage) => {
            // A slash-command turn can spawn a Task too; its nested steps never
            // render top-level ({@link isSidechainMessage}).
            if (isSidechainMessage(m)) return;
            if (m.session_id) {
              resolvedSession = m.session_id;
              turn.setSession(m.session_id);
            }
            // Keep the largest context snapshot from assistant blocks (issue #165);
            // the terminal `result` block's CUMULATIVE usage is stashed separately
            // so it can't inflate the live context meter (#398).
            foldTurnUsage(seen, m);
            // Surface a compaction as a visible assistant note (the SDK reports
            // it as a system/compact_boundary, which the text translator skips).
            if (m.type === "system" && m.subtype === "compact_boundary") {
              const pre = (m.compact_metadata as { pre_tokens?: number } | undefined)?.pre_tokens;
              const detail = typeof pre === "number" ? ` (was ${pre.toLocaleString()} tokens)` : "";
              turn.emit({
                type: "chat:response",
                payload: { ...routing(), chunk: `🗜️ Context compacted${detail}.` },
              });
              turn.emit({ type: "chat:message_boundary", payload: routing() });
              return;
            }
            // Surface a client-local command's output (`/context`, `/usage`, …). CC
            // returns it as a `model:"<synthetic>"` assistant message the translator
            // drops as a placeholder (and, on disk, a `system`/`local_command` entry
            // the history parser drops), so re-emit its text as an assistant note
            // (issue #158) instead of the turn reading as a silent no-op. Trivial
            // placeholders (e.g. `/compact`'s "No response requested.") are filtered out.
            const localOut = extractLocalCommandOutput(m);
            if (localOut) {
              turn.emit({ type: "chat:response", payload: { ...routing(), chunk: localOut } });
              turn.emit({ type: "chat:message_boundary", payload: routing() });
              return;
            }
            // #429: recover any Task/Agent launch before translate fires onToolStart.
            for (const l of extractSubagentLaunches(m)) subagentLaunches.set(l.toolUseId, l);
            await translate(m as unknown as ChatSDKMessage);
          },
        });
        if (finalSession) resolvedSession = finalSession;

        // Refresh the session list (a command can change history) — non-fatal.
        try {
          deps.herdctl.invalidateSessions(agentName);
        } catch {
          /* non-fatal */
        }

        const completeModel = seen.model ?? DEFAULT_MODEL;
        const seenUsage = resolveTurnUsage(seen);
        const completeUsage: ChatCompleteUsage | undefined = seenUsage
          ? {
              inputTokens: seenUsage.inputTokens,
              outputTokens: seenUsage.outputTokens,
              cacheReadTokens: seenUsage.cacheReadTokens,
              cacheCreationTokens: seenUsage.cacheCreationTokens,
              contextTokens:
                seenUsage.inputTokens + seenUsage.cacheReadTokens + seenUsage.cacheCreationTokens,
              contextLimit: getContextLimit(completeModel),
            }
          : undefined;

        if (resolvedSession) turn.setSession(resolvedSession);
        turn.emit({
          type: "chat:complete",
          payload: {
            ...routing(),
            success: true,
            ...(completeUsage ? { model: completeModel, usage: completeUsage } : {}),
          },
        });
        turn.end();
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        send({ type: "chat:error", payload: { projectSlug: slug, error } });
        if (resolvedSession) {
          turn.emit({ type: "chat:complete", payload: { ...routing(), success: false, error } });
        }
        turn.end();
      }
    };
    return { onChatContinue, onSubscribe, drainQueue, onSetQueue, onChatSend, onChatCommand };
  };

  // The ops used when a turn ends with no socket behind it — a trigger, a wake, a
  // spawned turn, a background sub-agent stretch — so the drain still has a way to
  // dispatch the follow-up. Built once: it holds no per-connection state.
  const headlessOps = makeChatOps(null, () => {});

  // Prefer the ending turn's ORIGIN socket when there is one, so a drained turn
  // keeps the same fan-out (and error routing) the turn it followed had; a turn
  // with no origin falls back to the headless ops.
  const opsFor = (origin: HubSocket | null): ReturnType<typeof makeChatOps> =>
    origin
      ? makeChatOps(origin, (m: ServerMessage) => {
          if (origin.readyState === origin.OPEN) origin.send(JSON.stringify(m));
        })
      : headlessOps;

  // #627: EVERY turn-ending path drains the queue, because every one of them ends
  // its turn through the hub. Previously this was a single call after a successful
  // `chat:send`, so a message queued during a slash command, a trigger, a wake, a
  // background stretch or a Stopped turn was stranded until some later `chat:send`
  // flushed it — out of order, behind a message the user typed afterwards.
  hub.onTurnEnd = ({ sessionId, projectSlug, origin }) => {
    void opsFor(origin).drainQueue(projectSlug, sessionId);
  };

  const handle = async function handle(socket: WebSocket): Promise<void> {
    const send = (m: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
    };

    // This connection's operations. The frame dispatcher below closes over them.
    const { onChatContinue, onSubscribe, onSetQueue, onChatSend, onChatCommand } = makeChatOps(
      socket,
      send,
    );

    // Register this socket for active-turn broadcasts, and immediately catch it
    // up on which sessions are currently running (so the sidebar dots and a
    // returning pane's Stop button reflect reality from the first paint).
    clients.add(socket);
    for (const info of hub.runningSessions()) send(activeFrame(info));

    // Heartbeat: browsers auto-answer protocol ping frames with a pong, so a
    // client whose TCP has silently died (idle drop, sleep) fails to pong and is
    // terminated on the next tick — freeing server resources and letting the
    // client's own reconnect take over. Cleared when the socket closes.
    let isAlive = true;
    socket.on("pong", () => {
      isAlive = true;
    });
    const heartbeat = setInterval(() => {
      if (!isAlive) {
        socket.terminate();
        return;
      }
      isAlive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }, SERVER_PING_INTERVAL_MS);
    socket.on("close", () => {
      clearInterval(heartbeat);
      // Drop this socket from every session fan-out set so the hub stops trying
      // to write to it (a running turn keeps going for other attached sockets).
      hub.unsubscribeSocket(socket);
      clients.delete(socket);
    });

    socket.on("message", (raw: Buffer | string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        send({ type: "chat:error", payload: { projectSlug: "?", error: "Invalid JSON" } });
        return;
      }
      if (!isClientMessage(parsed)) {
        send({ type: "chat:error", payload: { projectSlug: "?", error: "Unknown message" } });
        return;
      }
      if (parsed.type === "ping") {
        send({ type: "pong" });
        return;
      }
      if (parsed.type === "chat:cancel") {
        void deps.herdctl.cancel(parsed.payload.jobId).catch(() => undefined);
        return;
      }
      if (parsed.type === "chat:subscribe") {
        onSubscribe(parsed);
        return;
      }
      if (parsed.type === "chat:set_queue") {
        void onSetQueue(parsed);
        return;
      }
      if (parsed.type === "chat:command") {
        void onChatCommand(parsed);
        return;
      }
      if (parsed.type === "chat:continue") {
        void onChatContinue(parsed);
        return;
      }
      void onChatSend(parsed);
    });
  };

  // The socket handler PLUS the manual trigger-fire entrypoint: a "trigger now"
  // action fires a schedule-type trigger on demand through the exact same hub path a
  // cron fire uses, so the resulting chat is indistinguishable from a scheduled one.
  //
  // `managementOpsContext` (#312 M1) completes the hoist: it is the SAME shared
  // context the in-process self-MCP is built from (deps + hub + startAgentTurn +
  // composePreloadedPrompt + fireTrigger), handed out so a NON-socket caller can
  // build the management ops for itself — the `/mcp` transport in M2, and the
  // turn-spawning REST endpoints in #465. Exposing the CONTEXT rather than a
  // pre-built ops bag is deliberate: ops are built PER CALLER, because they close
  // over that caller's project/session/provenance and its policy principal.
  return { handle, fireTrigger, managementOpsContext: selfMcpCtx };
}

/**
 * WebSocket chat transport.
 *
 * Protocol (the contract the frontend agent matches):
 *
 *   client -> server:
 *     { type: "chat:send", payload: {
 *         projectSlug: string,        // project slug, or "scratch" for one-off
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
 *
 * Field-name note: legacy clients may send `target` instead of `projectSlug`;
 * we accept both. Server events always carry both `projectSlug` and the legacy
 * `target` alias so existing/early frontends keep working.
 */
import type { WebSocket } from "@fastify/websocket";
import type {
  SDKMessage,
  RuntimeSession,
  SessionWakeEntry,
  InjectedMcpServerDef,
} from "@herdctl/core";
import { createSDKMessageHandler, type SDKMessage as ChatSDKMessage } from "@herdctl/chat";
import {
  keeperAgentName,
  keeperSlugFromAgent,
  SCRATCH_AGENT,
  SCRATCH_SLUG,
} from "./herdctl.js";
import type { Project } from "./projects.js";
import {
  isKnownModel,
  getContextLimit,
  KEEPER_DEFAULT_MODEL,
  isKnownDriveMode,
  type DriveMode,
} from "./models.js";
import { SessionHub, type TurnHandle, type ActiveInfo } from "./session-hub.js";
import { resolveAttachmentsConfig } from "./attachments-config.js";
import { wrapAttachments, inferAttachmentKind, type PromptAttachment } from "./attachments-hint.js";
import { sendFileServerDef, SEND_FILE_SERVER_KEY } from "./send-file-mcp.js";
import { SELF_MCP_SERVER_KEY } from "./self-mcp.js";
import { type RunProvenanceStore, HUMAN_ROOT } from "./run-provenance.js";
import {
  buildInjectedMcpServers,
  createWakeInjectionCache,
  type InjectedMcpBuildArgs,
  type InjectedMcpBuildContext,
} from "./wake-injection.js";
import { resolveMaxSpawnDepth } from "./spawn-capability.js";
import { resolveRecoveryConfig } from "./recovery-config.js";
import { RecoveryEngine } from "./recovery.js";
import {
  noticeFromMessage,
  errorNotice,
  messageProducedReply,
  suppressNoticeAfterReply,
  type TurnNotice,
} from "./turn-notice.js";
import { resolveHooksMcpEnabled } from "./hook-config.js";

// --- protocol + usage math (extracted #403) ---------------------------------
// The wire protocol (message interfaces + unions + `isClientMessage`) and the
// per-turn token/usage helpers now live in ws-protocol.ts. Re-export the whole
// surface so external importers (and tests) that `import … from "./ws.js"`
// resolve unchanged, then pull in the handful this module uses directly.
export * from "./ws-protocol.js";
import type { ChatHandlerDeps, StartAgentTurnOpts, ChatHandlerContext } from "./ws-context.js";
// forkKickoffPrompt + buildSelfMcpServerDef now live in ws-self-mcp.ts; re-export
// forkKickoffPrompt so external importers (and its test) resolve it via ws.js.
export { forkKickoffPrompt } from "./ws-self-mcp.js";
import { buildSelfMcpServerDef } from "./ws-self-mcp.js";
import { makeTriggerCluster } from "./ws-triggers.js";
import {
  extractLocalCommandOutput,
  initTurnUsage,
  foldTurnUsage,
  resolveTurnUsage,
  readSlug,
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
 * The recovery nudge injected by a manual Continue (issue #301, Layer 2) — and,
 * later, by Layer 3 auto re-drive. It tells the keeper the truth (its background
 * task was KILLED AT THE TURN BOUNDARY, not "stopped by the user" — cf #216) so it
 * reacts sensibly: re-run the work in the FOREGROUND this turn, or report what
 * happened. Kept terse; the killed `<task-notification>` is already in its context.
 */
export const RECOVERY_NUDGE =
  "[Paddock recovery] Your previous turn ended while a background task was still " +
  "running, and that task was then KILLED at the turn boundary by the runtime — " +
  "this is a known limitation (see herdctl#374), NOT a user cancellation. Nothing " +
  "is running now. Please pick up where you left off: if you still need that work, " +
  "re-run it in the FOREGROUND this turn (do not background it), otherwise summarise " +
  "what happened and continue.";


/**
 * Register the /ws route handler. Pure transport: it validates messages,
 * resolves the target agent, and streams a real trigger back to the socket.
 */
// Server-side keepalive: how often to ping each client and, if the previous
// ping went unanswered, reap the dead socket. Protocol-level ping frames also
// keep intermediaries (proxies/NAT) from evicting an otherwise-idle connection.
// See issue #46.
const SERVER_PING_INTERVAL_MS = 30_000;


export function makeChatHandler(deps: ChatHandlerDeps) {
  // ONE hub shared across every socket this handler serves: it tracks each
  // session's in-flight turn and fans its frames out to whichever socket(s) are
  // currently attached, so a turn survives the death of the socket that started
  // it (issue #54). See session-hub.ts.
  const hub = new SessionHub();

  // Per-session marker of the last queued message the server has already drained
  // (#245), keyed `agent \0 sessionId` and stamped with that message's client
  // timestamp. Lets an idle-drain skip a message it already sent — e.g. a stale
  // localStorage copy a reloaded client re-asserts — instead of double-sending.
  // In-memory (shared across this handler's sockets); a rare double-send only
  // survives a server restart, when the persisted store is already empty anyway.
  const lastFlushedTs = new Map<string, number>();

  // Every currently-connected socket, so a turn's start/stop transition can be
  // broadcast to all clients — powering the per-chat sidebar streaming dots that
  // must update even for chats whose pane isn't mounted (issue #53).
  const clients = new Set<WebSocket>();
  const activeFrame = (info: ActiveInfo): ChatActiveMessage => ({
    type: "chat:active",
    payload: {
      projectSlug: info.projectSlug,
      target: info.projectSlug,
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
    const slug = keeperSlugFromAgent(entry.agent) ?? SCRATCH_SLUG;
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
      target: slug,
      sessionId: resolvedSession,
      jobId: turn.jobId,
    });
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
    try {
      for await (const m of session.messages) {
        if (m.session_id) {
          resolvedSession = m.session_id;
          turn.setSession(m.session_id);
          // #353: no provenance stamp on wake — see the note at the top of this
          // handler. A resume must never write a creation origin.
        }
        if (messageProducedReply(m as Parameters<typeof messageProducedReply>[0]))
          wakeProducedReply = true;
        const notice = noticeFromMessage(m as Parameters<typeof noticeFromMessage>[0]);
        if (notice) emitWakeNotice(notice);
        await translate(m as unknown as ChatSDKMessage);
        if (m.type === "result") break;
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
    // Post-wake curation sweep, same as a human turn (never for scratch). T5: routed
    // through the `afterTurn` event so the folded-in curator dispatches once.
    triggers.emitAfterTurn(slug, resolvedSession ?? null);
  });

  // Trigger / schedule / event firing (ws-triggers.ts, #403). Built here so it can
  // close over the shared startAgentTurn engine (a hoisted declaration below) and
  // wire its herdctl schedule handler + onArchive/afterTurn listeners. ws.ts consumes
  // emitAfterTurn / composePreloadedPrompt / fireTrigger from it.
  const triggers = makeTriggerCluster(deps, startAgentTurn);

  // The self-management MCP context (deps + shared closures), handed to the
  // extracted buildSelfMcpServerDef (ws-self-mcp.ts, #403) for both the live
  // injection path and the onChatCommand path. startAgentTurn / composePreloadedPrompt
  // / fireTrigger are hoisted function declarations, so this can be assembled here.
  const selfMcpCtx: ChatHandlerContext = {
    deps,
    hub,
    startAgentTurn,
    composePreloadedPrompt: triggers.composePreloadedPrompt,
    fireTrigger: triggers.fireTrigger,
  };

  // ── Wake-time injected-MCP re-establishment (edspencer/herdctl#390) ──────────
  // The single injection-policy context, shared by the live `startAgentTurn` path
  // (below) AND the wake rebuild, so the two can never drift. See wake-injection.ts.
  const injectionBuildCtx: InjectedMcpBuildContext = {
    scratchSlug: SCRATCH_SLUG,
    cfg: deps.cfg,
    saveAttachment: (bytes, name) => deps.attachments.save(bytes, name),
    // Optional, mirroring the optional `runProvenance` dep: absent ⇒ the caller's
    // `depth` is used unchanged (identical to the pre-extraction inline behaviour).
    getProvenance: deps.runProvenance ? (id) => deps.runProvenance!.get(id) : undefined,
    getProjectHooksMcp: async (slug) => {
      const tp = await deps.projects.get(slug).catch(() => null);
      return tp?.hooksMcpEnabled;
    },
    buildSelfMcp: (p) => buildSelfMcpServerDef(selfMcpCtx, p),
  };

  /** Build one turn's injected servers via the shared policy (see wake-injection.ts). */
  function buildInjection(
    args: InjectedMcpBuildArgs,
  ): Promise<Record<string, InjectedMcpServerDef>> {
    return buildInjectedMcpServers(args, injectionBuildCtx);
  }

  // Rebuild a woken session's injection from scratch (cold-cache warm after a server
  // restart, when the live-turn cache is empty). Resolves the project (scratch/unknown
  // ⇒ no injection) then delegates to the shared builder; the resume gates self-MCP on
  // the chat's OWN recorded depth. Never throws (the cache also catches defensively).
  const rebuildWakeInjection = async (
    entry: SessionWakeEntry,
  ): Promise<Record<string, InjectedMcpServerDef> | undefined> => {
    const slug = keeperSlugFromAgent(entry.agent);
    if (!slug || slug === SCRATCH_SLUG) return undefined;
    let project: Awaited<ReturnType<typeof deps.projects.get>>;
    try {
      project = await deps.projects.get(slug);
    } catch {
      return undefined; // unknown/deleted project — nothing to inject
    }
    return buildInjection({
      projectSlug: slug,
      workingDir: project.workingDir,
      resume: entry.sessionId,
      // `origin` only feeds child provenance via `childOf` (which forces "spawned"),
      // so its value is behaviourally irrelevant here; "scheduled" matches a wake root.
      origin: "scheduled",
      depth: 0,
      maxSpawnDepth: resolveMaxSpawnDepth(project.maxSpawnDepth, deps.cfg.maxSpawnDepth),
      currentSessionId: () => entry.sessionId,
    });
  };

  // The cache/resolver. `wakeInjection.remember` is called on every live turn (the
  // human socket path and `startAgentTurn`), so a session that self-schedules a wake
  // is warm when it fires. herdctl calls `wakeInjection.resolve` synchronously on each
  // wake fire — paired with `onSessionWake` above (which streams the woken turn), this
  // re-establishes the injected MCP servers the woken subprocess would otherwise spawn
  // WITHOUT, closing the "MCP flap". Registered here (rather than at the onSessionWake
  // call site) so it sits beside the builder + cache it depends on.
  const wakeInjection = createWakeInjectionCache({ rebuild: rebuildWakeInjection });
  deps.herdctl.setResolveInjectedMcpServers((entry) => wakeInjection.resolve(entry));

  /**
   * Kick off a keeper turn that is NOT driven by a socket — used by the
   * self-management MCP write tools (issue #214 Phase 2: create_chat / fork_chat /
   * send_message / fork_chat_batch fan-out). Routes the turn through the SAME
   * shared {@link hub} as socket-driven turns, so a spawned chat streams live to
   * any client viewing it, flips the sidebar running indicator (hub.onActive
   * broadcast), and is re-attachable — full parity with a human-started turn,
   * just with no originating socket (origin `null`).
   *
   * Returns a promise that resolves with the chat's sessionId AS SOON AS it is
   * known (immediately for a resumed/forked id; on the first streamed session_id
   * for a brand-new chat), while the turn itself runs to completion in the
   * BACKGROUND (detached). So a fan-out can fire N of these and collect N ids
   * without waiting for any child turn to finish; herdctl's own max-concurrency
   * throttles how many actually run at once. Rejects if the turn errors (or a
   * timeout elapses) before an id is known.
   *
   * The spawned turn always gets `send_file`, and — NEW in B1 (#262) — it ALSO
   * gets the self-management MCP (including the WRITE tools, so `send_message`
   * exists and a child can finally report back to its parent) when its depth is
   * within `maxSpawnDepth`. The fork-bomb bound is now EXPLICIT: a turn running in
   * a chat at depth `d` gets the tools iff `d <= maxSpawnDepth` (see
   * spawn-capability.ts). `maxSpawnDepth = 0` reproduces the old behaviour exactly
   * (send_file only). Every child spawned by a tool-equipped turn is stamped one
   * hop deeper, so the bound descends and the tree can't run away. A resume runs
   * in an EXISTING chat, so its capability is gated on THAT chat's own recorded
   * depth (from {@link RunProvenanceStore}), not on the caller's describe-the-run
   * `depth`. A human who later opens a spawned chat still gets the full tools via
   * the regular socket path (any keeper chat may use them) — unchanged.
   */
  async function startAgentTurn(opts: StartAgentTurnOpts): Promise<string> {
    const { projectSlug, agentName, workingDir, resume, prompt, driveMode, fallbackModel, origin, depth, maxSpawnDepth, sender } =
      opts;
    let resolvedSession: string | null = resume ?? null;
    let jobId: string | null = null;
    let attributed = false;
    const isNewChat = resume === null;
    const turn: TurnHandle = hub.startTurn(projectSlug, null, resume ?? null);
    const seen: TurnUsageState = initTurnUsage();
    // #329: whether this turn already surfaced a dead-end notice (usage limit /
    // max-turns / error). At most one per turn — a synthetic session-limit turn
    // repeats the message several times, and a failed turn can carry both an error
    // `result` and a `success:false` completion. Emit the first, suppress the rest.
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

    const routing = (): Routing => ({
      projectSlug,
      target: projectSlug,
      sessionId: resolvedSession,
      jobId,
    });

    // Per-message provenance (issue #290). Once the TARGET session id is known,
    // record the injected prompt + its sender so a later transcript load can
    // attribute the machine-added user turn (see message-provenance.ts). For an
    // injection into an EXISTING chat we ALSO emit a `chat:injected` frame so a
    // client currently viewing the recipient renders the injected user bubble live
    // (Part 2) — a fresh/new chat has no established viewer, and opening it later
    // hydrates the labelled turn from history, so we skip the live emit there to
    // avoid a replay double-add. Fires at most once per turn.
    let injectionHandled = false;
    const handleInjection = (id: string): void => {
      if (injectionHandled || !sender) return;
      injectionHandled = true;
      void deps.messageProvenance?.record(id, sender, prompt).catch(() => undefined);
      if (resume !== null) {
        turn.emit({
          type: "chat:injected",
          payload: {
            projectSlug,
            target: projectSlug,
            sessionId: id,
            jobId,
            sender,
            content: prompt,
            timestamp: new Date().toISOString(),
          },
        });
      }
    };
    // A resume already knows its target session id — stamp/emit up front so the
    // injected bubble precedes the assistant's streamed reply.
    if (resume !== null) handleInjection(resume);
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
          },
        });
      },
    });

    // Build this turn's injected MCP servers via the shared policy (send_file always;
    // depth-gated self-MCP, #262/DD-3). Extracted so the wake resolver (#390) rebuilds
    // the IDENTICAL set — see wake-injection.ts. A RESUME gates self-MCP on the chat's
    // OWN recorded depth (resolved inside the builder); `currentSessionId` is late-bound
    // to `resolvedSession` so the self-MCP write tools attribute against the live id.
    const injectedMcpServers = await buildInjection({
      projectSlug,
      workingDir,
      resume,
      origin,
      depth,
      maxSpawnDepth,
      currentSessionId: () => resolvedSession,
    });

    const drive =
      driveMode === "session"
        ? deps.herdctl.chatSession.bind(deps.herdctl)
        : deps.herdctl.chat.bind(deps.herdctl);

    // Resolve the sessionId early; the caller returns it while the turn continues.
    let resolveId!: (id: string) => void;
    let rejectId!: (err: Error) => void;
    const idKnown = new Promise<string>((res, rej) => {
      resolveId = res;
      rejectId = rej;
    });
    if (resume) resolveId(resume);

    const drivePromise = drive(agentName, {
      prompt,
      // herdctl's TriggerTypeSchema is a strict enum (manual|schedule|webhook|
      // chat|discord|slack|web|fork); "agent" is NOT a member, so it fails job
      // validation and the whole spawn errors out — which is why a spawned child
      // could never be created against this core version. Use "manual" (the
      // documented API/CLI-initiated value) until herdctl adds a first-class
      // `spawned` trigger type (DD-6 / herdctl#377); provenance is carried by
      // RunProvenanceStore (origin/depth), not by this field.
      triggerType: "manual",
      resume,
      injectedMcpServers,
      onJobCreated: (id) => {
        jobId = id;
        turn.setJobId(id);
      },
      onMessage: async (m: SDKMessage) => {
        if (m.session_id) {
          resolvedSession = m.session_id;
          // #390: remember this turn's injected servers so a later wake of this
          // session replays them (closes the flap on the common self-schedule case).
          wakeInjection.remember(m.session_id, injectedMcpServers);
          if (isNewChat && !attributed) {
            attributed = true;
            await deps.herdctl.attributeRunningSession(m.session_id, agentName).catch(() => undefined);
            // A1 (#261): stamp the NEW chat's provenance (e.g. create_chat →
            // spawned, depth = parent+1) so #262 can depth-gate and #267 can
            // badge it. Only a new chat is stamped here; a resume/message target
            // (fork kickoff, send_message) keeps its own creation provenance.
            await deps.runProvenance
              ?.stamp(m.session_id, { origin, depth })
              .catch(() => undefined);
            // #290: record the kickoff's sender for the NEW chat now that its id
            // is known (no live emit — see handleInjection; the labelled turn
            // hydrates from history when the chat is opened).
            handleInjection(m.session_id);
          }
          turn.setSession(m.session_id);
          resolveId(m.session_id);
        }
        // Capture per-turn usage: assistant blocks feed the context snapshot; the
        // terminal `result` block's CUMULATIVE usage is kept apart so it can't
        // inflate the live context meter (#398).
        foldTurnUsage(seen, m);
        // #329: surface a dead-end BEFORE translating — a synthetic usage-limit
        // message or a terminal error/`error_max_turns` result. The translator
        // drops every synthetic message (so nothing would ever render), which is
        // exactly why these turns look dead. `noticeFromMessage` returns null for
        // ordinary output and for suppressed "No response requested." placeholders.
        // #380/#394: track whether this turn showed the user real prose so a
        // trailing error/max_turns result (which races in AFTER the reply in
        // session mode) is suppressed below. OR-accumulated across ALL of the
        // turn's messages — a tool-heavy turn's prose rides on a `tool_use`
        // message and its terminal `end_turn` is often thinking-only (#394), so
        // the flag must survive later text-less messages, not just the last one.
        if (messageProducedReply(m as Parameters<typeof messageProducedReply>[0]))
          producedReply = true;
        const notice = noticeFromMessage(m as Parameters<typeof noticeFromMessage>[0]);
        if (notice) emitNotice(notice);
        await translate(m as unknown as ChatSDKMessage);
      },
    });

    // Detached completion: emit the terminal frame + end the hub turn no matter
    // what. Never throws to the event loop (guards the fan-out from one bad turn).
    void drivePromise
      .then((result) => {
        const finalSession =
          (result.success ? (result.sessionId ?? resolvedSession) : resolvedSession) ?? null;
        if (finalSession) turn.setSession(finalSession);
        const completeModel = seen.model ?? fallbackModel;
        const u = resolveTurnUsage(seen);
        const completeUsage: ChatCompleteUsage | undefined = u
          ? {
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              cacheReadTokens: u.cacheReadTokens,
              cacheCreationTokens: u.cacheCreationTokens,
              contextTokens: u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens,
              contextLimit: getContextLimit(completeModel),
            }
          : undefined;
        // #329: a turn that failed WITHOUT a terminal error `result` reaching the
        // stream (a thrown/rejected drive: network/DNS reset, process crash) never
        // triggered `noticeFromMessage`. Surface it here as an inline error notice
        // so the failure is visible — before chat:complete flips streaming off.
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
        turn.end();
        try {
          deps.herdctl.invalidateSessions(agentName);
        } catch {
          /* non-fatal */
        }
        // T5: post-turn curation via the `afterTurn` event (folded-in sweeper).
        if (result.success) triggers.emitAfterTurn(projectSlug, finalSession);
        // Layer 3 (issue #301): arm a post-turn recovery watch for a session-mode
        // keeper turn that stayed alive — including a recovery re-drive itself, so a
        // re-drive that hangs again is caught (bounded by the per-session retry cap).
        if (result.success && finalSession && driveMode === "session" && projectSlug !== SCRATCH_SLUG) {
          recoveryEngine.armWatch({ slug: projectSlug, sessionId: finalSession });
        }
        if (!resolvedSession) {
          rejectId(new Error(result.error?.message ?? "turn ended with no session id"));
        }
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        // #329: the drive itself rejected — surface the failure inline so the chat
        // doesn't just look dead (deduped against any notice already emitted).
        emitNotice(errorNotice(error));
        turn.emit({
          type: "chat:complete",
          payload: { ...routing(), sessionId: resolvedSession, jobId, success: false, error },
        });
        turn.end();
        rejectId(err instanceof Error ? err : new Error(error));
      });

    // Never hang the calling tool forever if the child never streams an id.
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error("timed out waiting for spawned chat to start")), 60_000),
    );
    return Promise.race([idKnown, timeout]);
  }

  /**
   * Sessions with a recovery nudge dispatch in flight (issue #352 double-dispatch
   * guard). A resume of a still-in-flight session-mode chat interrupts and swallows
   * the prior resume, so we never let two recovery/Continue dispatches for the same
   * session overlap. Set synchronously the moment a nudge is dispatched (before the
   * `sessionExists` await), cleared once the turn has started; `hub.isRunning` then
   * carries the guard for the turn's lifetime.
   */
  const injectingRecovery = new Set<string>();

  /**
   * Inject the keeper-chat recovery nudge into a still-alive session (issue #301) —
   * the ONE shared path behind both the manual Layer 2 "Continue" (`chat:continue`)
   * and the Layer 3 automatic re-drive ({@link RecoveryEngine}). Re-drives the
   * hung keeper via {@link startAgentTurn} with the {@link RECOVERY_NUDGE} and a
   * `recovery` sender, exactly the message a human sends by hand to unstick it.
   * No-op for scratch (no keeper) or a session that no longer exists. The gate on
   * WHICH layer may call this lives in each caller (surfaceKilledTask vs
   * autoReDrive); this helper is layer-agnostic.
   */
  const injectRecoveryNudge = async (project: Project, sessionId: string): Promise<void> => {
    const slug = project.slug;
    if (!slug || slug === SCRATCH_SLUG) return;
    // Single-flight double-dispatch guard (issue #352). Two dispatches resuming the
    // SAME session at once is fatal under session-mode `chatSession(resume)`: the
    // second resume interrupts the first, so one nudge is swallowed ("first message
    // swallowed", #350/#347). A turn already running for this session (a human send,
    // a queued-message drain, or a Continue click) means the keeper is not idle —
    // yield to it. And `injectingRecovery` closes the async gap below (the
    // `sessionExists` await) so two near-simultaneous recovery/Continue calls can't
    // both get past this check before either registers its turn as running.
    if (injectingRecovery.has(sessionId) || hub.isRunning(sessionId)) {
      return;
    }
    injectingRecovery.add(sessionId);
    try {
      // Only re-drive a real, existing session (a live kept-alive keeper chat).
      if (!(await deps.herdctl.sessionExists(project, sessionId).catch(() => false))) return;
      const driveMode =
        project.driveMode && isKnownDriveMode(project.driveMode)
          ? project.driveMode
          : deps.cfg.keeperDriveMode;
      await startAgentTurn({
        projectSlug: slug,
        agentName: keeperAgentName(slug),
        workingDir: project.workingDir,
        resume: sessionId,
        prompt: RECOVERY_NUDGE,
        driveMode,
        fallbackModel: project.model,
        // A resume never re-stamps provenance (only new chats are stamped), so these
        // describe-the-run values aren't persisted — the target keeps its own marker
        // and its self-MCP is gated on THAT recorded depth. Describe it as a
        // human-rooted run (matches the Layer 2 manual Continue path).
        origin: "human",
        depth: 0,
        maxSpawnDepth: resolveMaxSpawnDepth(project.maxSpawnDepth, deps.cfg.maxSpawnDepth),
        // #290 / #301: attribute the injected nudge to Paddock recovery so the history
        // renders "⚠ continued after a background task was terminated" and emits a live
        // chat:injected frame to any attached viewer.
        sender: { kind: "recovery" },
      });
    } finally {
      // Clear the single-flight mark once the turn has STARTED (startAgentTurn
      // resolves as soon as the session id is known — for a resume, immediately —
      // by which point `hub.isRunning(sessionId)` is true and takes over the guard).
      injectingRecovery.delete(sessionId);
    }
  };

  /**
   * Layer 3 automatic-recovery engine (issue #301). After each session-mode keeper
   * turn completes (armed at the completion sites below), it tails the transcript;
   * if a background task was killed at the turn boundary and the keeper doesn't wake
   * on its own, it auto-injects the recovery nudge — guarded by the resolved
   * `recovery.autoReDrive` flag (default OFF), a debounce window, and a per-session
   * retry cap. Re-drive reuses the exact {@link injectRecoveryNudge} path as the
   * manual Continue; a human message ({@link RecoveryEngine.onHumanMessage}) resets
   * a session's guard so a later genuine hang recovers fresh.
   */
  const recoveryEngine = new RecoveryEngine({
    cfg: { recovery: deps.cfg.recovery },
    getProject: (slug) => deps.projects.get(slug),
    reDrive: (project, sessionId) => injectRecoveryNudge(project, sessionId),
    // #352: a live turn on this session means the keeper isn't idle — the watch
    // defers rather than surface a stale "idle" banner or fire a re-drive that
    // would interrupt (and be swallowed by) the in-flight turn. `injectRecoveryNudge`
    // holds the same guard for the recovery path's own dispatch window.
    isBusy: (sessionId) => hub.isRunning(sessionId),
    // #397: `hub.isRunning` only sees turns PADDOCK started — it is BLIND to a
    // session herdctl's reaper is keeping alive for the just-killed background task
    // (or its ~15s re-invocation grace). Auto re-drive resumes via a FRESH
    // subprocess, so firing while that prior subprocess is still live spawned a
    // COMPETING resume the SDK interrupted (`[Request interrupted by user]`). Thread
    // the reaper's true liveness in so the engine defers until the session is
    // genuinely idle. Null-safe (batch mode / no reaper → false = pre-#397 path).
    sdkSessionLive: (sessionId) => deps.herdctl.isSdkSessionLive(sessionId),
    // #347: when a background task is killed at the turn boundary, its
    // notification is trapped in the SDK input queue — the client would never
    // render the "keeper is idle" affordance until a refresh flushed it. On
    // detection, broadcast a live frame to any attached socket so the banner +
    // Continue appear immediately. Out-of-band (no live turn), so hub.broadcast.
    surface: (project, sessionId, summary) => {
      hub.broadcast(sessionId, {
        type: "chat:killed_task",
        payload: {
          projectSlug: project.slug,
          target: project.slug,
          sessionId,
          summary: summary ?? "A background task was terminated at the turn boundary.",
          timestamp: new Date().toISOString(),
        },
      });
    },
  });

  const handle = async function handle(socket: WebSocket): Promise<void> {
    const send = (m: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
    };

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
        send({ type: "chat:error", payload: { projectSlug: "?", target: "?", error: "Invalid JSON" } });
        return;
      }
      if (!isClientMessage(parsed)) {
        send({ type: "chat:error", payload: { projectSlug: "?", target: "?", error: "Unknown message" } });
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

    /**
     * Manual keeper recovery (issue #301, Layer 2). Re-drive a hung keeper whose
     * background task was killed at the turn boundary by injecting the recovery
     * nudge into its still-alive session via {@link startAgentTurn} — the same
     * workhorse the self-MCP `send_message` / schedule fires use, so the injected
     * turn streams live, lists in the sidebar, and is attributable
     * (`sender: recovery`). Server-authoritative gate: no-op unless the resolved
     * `recovery.surfaceKilledTask` is on for this project, so a stale/rogue client
     * can't re-drive when the operator disabled Layer 2. Scratch chats have no
     * keeper session to recover, so they're ignored.
     */
    const onChatContinue = async (msg: ChatContinueMessage): Promise<void> => {
      const slug = msg.payload.projectSlug ?? msg.payload.target;
      if (!slug || slug === SCRATCH_SLUG) return;
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
          payload: { projectSlug: slug, target: slug, error: `Recovery failed: ${String(err)}` },
        });
      });
    };

    const onSubscribe = (msg: ChatSubscribeMessage): void => {
      const { sessionId, wantReplay, lastSeq } = msg.payload;
      const result = hub.attach(sessionId, socket, {
        wantReplay: wantReplay === true,
        afterSeq: typeof lastSeq === "number" ? lastSeq : -1,
      });
      if (result.status === "resync") {
        send({
          type: "chat:resync",
          payload: { projectSlug: result.projectSlug, target: result.projectSlug, sessionId },
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
    // message as the next turn, exactly once. Called (a) when a turn completes
    // successfully and (b) when a queue is set while the session is idle — a queue
    // that arrived (e.g. via the reconnect outbox) after the turn it was meant to
    // follow already ended. `take` makes the read+clear atomic so the two callers
    // can never both send it; the `lastFlushedTs` marker skips a message already
    // drained (a stale client re-assert on reload) so it isn't sent twice.
    const drainQueue = async (slug: string, sessionId: string): Promise<void> => {
      if (!deps.queuedMessage) return;
      const agent = slug === SCRATCH_SLUG ? SCRATCH_AGENT : keeperAgentName(slug);
      const queued = await deps.queuedMessage.take(agent, sessionId).catch(() => null);
      if (!queued?.text) return;
      const markerKey = `${agent} ${sessionId}`;
      const already = (lastFlushedTs.get(markerKey) ?? 0) >= queued.createdAtMs;
      // Tell every attached client (origin + reconnected sockets) to clear its copy
      // of this message. When we're really sending it, carry the text so the client
      // renders the sent bubble in-transcript; on a stale re-assert we only clear.
      hub.broadcast(sessionId, {
        type: "chat:queued_flushed",
        payload: {
          projectSlug: slug,
          target: slug,
          sessionId,
          ...(already ? {} : { text: queued.text }),
        },
      });
      if (already) return;
      lastFlushedTs.set(markerKey, queued.createdAtMs);
      // Broadcast the flush frame BEFORE kicking the turn so the user bubble renders
      // above the reply. Run it detached, like a human send. A leading-slash queued
      // message is a slash command (e.g. "/compact"): route it through the command
      // path so the CLI dispatches it — matching how the composer sends one live.
      if (queued.text.startsWith("/")) {
        void onChatCommand({
          type: "chat:command",
          payload: { projectSlug: slug, target: slug, command: queued.text, sessionId },
        });
      } else {
        void onChatSend({
          type: "chat:send",
          payload: { projectSlug: slug, target: slug, sessionId, message: queued.text },
        });
      }
    };

    const onSetQueue = async (msg: ChatSetQueueMessage): Promise<void> => {
      if (!deps.queuedMessage) return; // feature disabled
      const slug = (msg.payload.projectSlug ?? msg.payload.target) as string | undefined;
      if (!slug) return;
      const sessionId = msg.payload.sessionId ?? null;
      const text = msg.payload.text ?? null;
      // Determine the agent name for this chat (keeper for project, scratch for one-off)
      const agent = slug === SCRATCH_SLUG ? SCRATCH_AGENT : keeperAgentName(slug);
      if (!sessionId) {
        // New chat: queue isn't stored until the session id exists. The client
        // re-asserts it (with the same ts) once the id resolves, so it persists then.
        return;
      }
      // Store or clear the queued message.
      if (text && text.trim().length > 0) {
        await deps.queuedMessage
          .set(agent, sessionId, { text, createdAtMs: msg.payload.ts ?? Date.now() })
          .catch(() => undefined);
        // If no turn is running, this queue arrived after the turn it was meant to
        // follow already ended — drain it now rather than wait for a completion
        // that won't come (the reported stranding bug, #245).
        if (!hub.isRunning(sessionId)) await drainQueue(slug, sessionId);
      } else {
        await deps.queuedMessage.set(agent, sessionId, null).catch(() => undefined);
      }
    };

    const onChatSend = async (msg: ChatSendMessage): Promise<void> => {
      const slug = readSlug(msg.payload) as string;
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
      let effectiveModel: string = KEEPER_DEFAULT_MODEL;
      // How this turn is driven (Paddock#111): the global default unless the
      // project overrides it (resolved in the project branch below). Scratch
      // chats have no project, so they always take the global default.
      let driveMode: DriveMode = deps.cfg.keeperDriveMode;
      // The agent's working directory, so the send_file tool can resolve a real
      // `file_path` (and sandbox it). Resolved alongside the agent below.
      let sendFileWorkingDir: string | undefined;

      const routing = (): Routing => ({
        projectSlug: slug,
        target: slug,
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
            },
          });
        },
      });

      try {
        // Resolve the agent: "scratch" -> scratch agent; otherwise keeper-<slug>.
        let agentName: string;
        // Effective prompt — may be augmented with the project overview below.
        let prompt = message;
        // Whether this project agent gets the T3 unified trigger-management tools
        // (resolved from the project's REUSED hooks-MCP `hooksMcpEnabled` override
        // else the instance default); stays false for scratch (no self-MCP).
        let includeTriggers = false;
        const requested = msg.payload.model;
        if (slug === SCRATCH_SLUG) {
          agentName = SCRATCH_AGENT;
          sendFileWorkingDir = deps.herdctl.scratchDir;
          // Scratch: honor a valid override, else the keeper default. Re-register
          // the scratch agent at the requested model (no-op if unchanged).
          effectiveModel =
            requested && isKnownModel(requested) ? requested : KEEPER_DEFAULT_MODEL;
          if (requested && isKnownModel(requested)) {
            await deps.herdctl.ensureScratchModel(requested);
          }
        } else {
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
          await deps.herdctl.ensureKeeperModel(project, effectiveModel);

          // Per-project driveMode override wins over the global default
          // (Paddock#111). An absent/invalid value inherits the global.
          driveMode =
            project.driveMode && isKnownDriveMode(project.driveMode)
              ? project.driveMode
              : deps.cfg.keeperDriveMode;

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
            prompt = await triggers.composePreloadedPrompt(slug, prompt);
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

        // Self-management MCP (issue #214): only on keeper turns (never scratch)
        // and only when the instance opts in via PADDOCK_SELF_MCP. A HUMAN turn is
        // the ROOT of any spawn tree (origin human, depth 0), so its children are
        // depth 1 — the same builder the spawned path uses, just seeded with
        // HUMAN_ROOT. Write tools follow the instance write opt-in (B1 #262: the
        // shared builder is extracted so both paths agree). Depth-0 human gating is
        // unchanged from before B1 — the depth bound governs the spawned path only.
        if (slug !== SCRATCH_SLUG && deps.cfg.selfMcpEnabled) {
          injectedMcpServers[SELF_MCP_SERVER_KEY] = buildSelfMcpServerDef(selfMcpCtx, {
            currentProjectSlug: slug,
            currentSessionId: () => resolvedSession ?? sessionId ?? null,
            parentProvenance: HUMAN_ROOT,
            includeWrite: deps.cfg.selfMcpWriteEnabled,
            includeTriggers,
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
        const result = await drive(agentName, {
          prompt,
          // omit -> agent-level fallback; explicit null -> new chat; id -> resume.
          resume: sessionId ?? null,
          triggerType: "web",
          injectedMcpServers,
          onJobCreated: (id) => {
            jobId = id;
            turn.setJobId(id);
          },
          onMessage: async (m: SDKMessage) => {
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
            // @herdctl/core's SDKMessage types `message` as `unknown` (wider);
            // @herdctl/chat's translator declares a structurally narrower
            // SDKMessage. Same runtime object — cast across the package boundary.
            // (@herdctl/chat@0.4.1 pairs CLI tool results, so no shim needed.)
            await translate(m as unknown as ChatSDKMessage);
          },
        });

        // Post-turn sweep (issues #2/#6): on a successful USER turn in a real
        // project, enqueue a coalesced/debounced curation sweep. Out of band —
        // never blocks or breaks chat, and can't recurse (the sweep uses a
        // separate agent triggered off the user-chat path). Skipped for scratch.
        // T5: routed through the `afterTurn` event so the folded-in `curate-overview`
        // trigger is the single dispatch (no double-curation).
        if (result.success) triggers.emitAfterTurn(slug, result.sessionId ?? resolvedSession ?? null);

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
        const finalSession = result.success ? (result.sessionId ?? resolvedSession) : resolvedSession;
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
        turn.end();

        // After a SUCCESSFUL turn, auto-send any queued follow-up (#197/#245). A
        // Stop/failed turn holds the queue for the user (no drain). drainQueue owns
        // the take + client notify + next-turn kickoff, shared with the idle path.
        if (result.success && finalSession) {
          await drainQueue(slug, finalSession);
        }

        // Layer 3 (issue #301): arm a post-turn recovery watch for a session-mode
        // keeper turn. If this turn launched a background task that the runtime kills
        // at the turn boundary (herdctl#374) and the keeper doesn't wake on its own,
        // the engine auto-injects the recovery nudge — gated on the resolved
        // `recovery.autoReDrive` (default OFF), a debounce window, and a retry cap.
        if (result.success && finalSession && driveMode === "session" && slug !== SCRATCH_SLUG) {
          recoveryEngine.armWatch({ slug, sessionId: finalSession });
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        // The origin socket always gets the plain chat:error (its shape predates
        // the hub and existing clients/tests rely on it). If the turn had already
        // resolved a session, ALSO emit a terminal chat:complete through the hub
        // so a client that re-attached after a mid-turn socket drop stops showing
        // "streaming" instead of hanging with no terminal frame.
        send({ type: "chat:error", payload: { projectSlug: slug, target: slug, error } });
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
      const slug = (msg.payload.projectSlug ?? msg.payload.target) as string;
      const { command, sessionId } = msg.payload;
      let resolvedSession: string | null = sessionId ?? null;
      const seen: TurnUsageState = initTurnUsage();
      // Same hub-tracked turn as onChatSend so a slash-command turn also survives
      // a mid-turn socket drop (issue #54). A command always targets an existing
      // session, so it's re-attachable from its first frame.
      const turn: TurnHandle = hub.startTurn(slug, socket, sessionId ?? null);

      const routing = (): Routing => ({
        projectSlug: slug,
        target: slug,
        sessionId: resolvedSession,
        jobId: null,
      });

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
            },
          });
        },
      });

      try {
        // Commands need an existing chat to act on; scratch resolves to its
        // agent, a project to its keeper (verifying the project exists).
        let agentName: string;
        if (slug === SCRATCH_SLUG) {
          agentName = SCRATCH_AGENT;
        } else {
          await deps.projects.get(slug); // throws if the project is unknown
          agentName = keeperAgentName(slug);
        }

        const { sessionId: finalSession } = await deps.herdctl.runCommand(agentName, {
          command,
          resume: resolvedSession,
          onMessage: async (m: SDKMessage) => {
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

        const completeModel = seen.model ?? KEEPER_DEFAULT_MODEL;
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
        send({ type: "chat:error", payload: { projectSlug: slug, target: slug, error } });
        if (resolvedSession) {
          turn.emit({ type: "chat:complete", payload: { ...routing(), success: false, error } });
        }
        turn.end();
      }
    };
  };

  // The socket handler PLUS the manual trigger-fire entrypoint: a "trigger now"
  // action fires a schedule-type trigger on demand through the exact same hub path a
  // cron fire uses, so the resulting chat is indistinguishable from a scheduled one.
  return { handle, fireTrigger: triggers.fireTrigger };
}

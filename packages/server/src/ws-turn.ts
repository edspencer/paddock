/**
 * The turn-execution engine, extracted from ws.ts (#403).
 *
 * `makeTurnEngine({ deps, hub })` relocates — intact — the mutually-recursive core
 * that ws.ts's makeChatHandler used to hold in one closure: the trigger cluster,
 * the self-MCP injection context, the per-turn injected-MCP builders + wake cache,
 * the shared `startAgentTurn` execution engine, and the Layer-2/3 recovery
 * (`injectRecoveryNudge` + `RecoveryEngine`). These pieces cross-reference each
 * other (startAgentTurn ↔ recoveryEngine.armWatch, triggers ↔ startAgentTurn,
 * selfMcp injection ↔ startAgentTurn), so they must share ONE scope — moving them
 * as a group keeps that intact with no late-binding. ws.ts's socket layer consumes
 * the returned surface.
 */
import type {
  SDKMessage,
  SessionWakeEntry,
  InjectedMcpServerDef,
} from "@herdctl/core";
import { createSDKMessageHandler, type SDKMessage as ChatSDKMessage } from "@herdctl/chat";
import { keeperAgentName, keeperSlugFromAgent, SCRATCH_SLUG } from "./herdctl.js";
import type { Project } from "./projects.js";
import { isKnownDriveMode, getContextLimit } from "./models.js";
import { SessionHub, type TurnHandle } from "./session-hub.js";
import { type RunProvenanceStore } from "./run-provenance.js";
import {
  buildInjectedMcpServers,
  createWakeInjectionCache,
  type InjectedMcpBuildArgs,
  type InjectedMcpBuildContext,
} from "./wake-injection.js";
import { resolveMaxSpawnDepth } from "./spawn-capability.js";
import { RecoveryEngine } from "./recovery.js";
import { extractSubagentLaunches, subagentLaunchFields, type SubagentLaunch } from "./subagents.js";
import {
  noticeFromMessage,
  errorNotice,
  messageProducedReply,
  suppressNoticeAfterReply,
  type TurnNotice,
} from "./turn-notice.js";
import type {
  ChatHandlerDeps,
  StartAgentTurnOpts,
  StartAgentTurn,
  ChatHandlerContext,
} from "./ws-context.js";
import { buildSelfMcpServerDef } from "./ws-self-mcp.js";
import { makeTriggerCluster } from "./ws-triggers.js";
import {
  initTurnUsage,
  foldTurnUsage,
  resolveTurnUsage,
  type TurnUsageState,
  type Routing,
  type ChatCompleteUsage,
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
 * Whether an SDK message is a sub-agent (sidechain) step — `parent_tool_use_id`
 * points at the spawning `Task` tool_use. Present on the top-level SDK message
 * and/or its nested `message` (assistant/user shapes differ). Sidechain steps are
 * the sub-agent's own nested work; the main turn stream never renders them (they
 * surface via the subagents endpoint on card-expand), so the background sink skips
 * them to avoid scattering the sub-agent's work into phantom top-level rows.
 */
export function isSidechainMessage(m: SDKMessage): boolean {
  const anym = m as unknown as {
    parent_tool_use_id?: string | null;
    message?: { parent_tool_use_id?: string | null };
  };
  return Boolean(anym.parent_tool_use_id ?? anym.message?.parent_tool_use_id);
}

/** The turn-execution surface ws.ts's socket layer consumes. */
export interface TurnEngine {
  startAgentTurn: StartAgentTurn;
  buildInjection(args: InjectedMcpBuildArgs): Promise<Record<string, InjectedMcpServerDef>>;
  wakeInjection: ReturnType<typeof createWakeInjectionCache>;
  selfMcpCtx: ChatHandlerContext;
  injectRecoveryNudge(project: Project, sessionId: string): Promise<void>;
  recoveryEngine: RecoveryEngine;
  emitAfterTurn(slug: string, sessionId: string | null): void;
  composePreloadedPrompt(projectSlug: string, baseMessage: string): Promise<string>;
  fireTrigger(slug: string, triggerName: string): Promise<string | null>;
  /**
   * Gap B: build a per-turn sink that renders autonomous background-completion
   * re-invocation turns (delivered on the same session stream after the primary
   * turn) as their own live hub turns. The human socket path (ws.ts) passes the
   * returned function as `onBackgroundMessage` so a fresh/resume human turn's
   * background work is delivered live too — parity with the spawned path.
   */
  makeBackgroundTurnSink(projectSlug: string): {
    onMessage: (m: SDKMessage) => Promise<void>;
    onDone: () => void;
  };
}

/**
 * Build the turn-execution engine bound to the handler's deps + shared hub, wiring
 * the herdctl schedule/wake resolvers and the trigger event listeners.
 */
export function makeTurnEngine(engine: { deps: ChatHandlerDeps; hub: SessionHub }): TurnEngine {
  const { deps, hub } = engine;

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

// ── Gap B: live delivery of autonomous background-completion turns ───────────
// A session-mode turn that launches continuous background work is held open by
// the reaper (decideReap keepAlives while backgroundTasks > 0). When a task
// completes, the SDK hands the parent the result as a fresh autonomous
// re-invocation turn on the SAME session stream — AFTER the primary turn. herdctl
// `chatSession` keeps consuming that stream (consumeBackgroundTurns) and forwards
// each subsequent message to this sink, which renders it onto the live hub — the
// same delivery the scheduler-wake path uses (ws.ts onSessionWake) — so it appears
// without a refresh.
//
// Grouping (the sub-agent fix): a background *sub-agent* (`Task` run_in_background)
// streams for minutes and, unlike a foreground synchronous Task (whose nested steps
// herdctl routes to a SEPARATE sidechain session, never the main turn stream), its
// nested `isSidechain` steps arrive INLINE on this re-invocation stream. So we:
//   1. SKIP sidechain messages (`parent_tool_use_id` set) from RENDERING — matching
//      the foreground/history path, which never draws them top-level (they surface
//      only via the subagents endpoint on card-expand). We still CONSUME them
//      (consumeBackgroundTurns forwards everything to keep the stream + reaper
//      lifecycle signals advancing) — we just don't render them.
//   2. Use ONE persistent TurnHandle + ONE translator for the WHOLE background
//      stream (not a fresh one per `result`), so a Task `tool_use`↔`tool_result`
//      pair through the translator's persistent `pendingToolUses` into ONE
//      reconciled card, and successive re-invocations render as boundary-separated
//      bubbles under one turn group — instead of scattering into phantom untitled
//      "Agent" cards. The turn is finalized once, when the stream ends ({@link
//      onDone}), so the streaming indicator clears.
const makeBackgroundTurnSink = (
  projectSlug: string,
): { onMessage: (m: SDKMessage) => Promise<void>; onDone: () => void } => {
  let turn: TurnHandle | null = null;
  let translate: ReturnType<typeof createSDKMessageHandler> | null = null;
  let resolvedSession: string | null = null;
  let producedReply = false;
  let noticeEmitted = false;
  let sawError = false;
  // #429: sub-agent launches recovered live from the tool_use input, keyed by
  // toolUseId, so the enriched card renders without a refresh (see subagentLaunchFields).
  const launches = new Map<string, SubagentLaunch>();
  const routing = (): Routing => ({
    projectSlug,
    target: projectSlug,
    sessionId: resolvedSession,
    jobId: turn?.jobId ?? null,
  });
  const emitNotice = (notice: TurnNotice): void => {
    if (!turn || noticeEmitted) return;
    if (suppressNoticeAfterReply(notice, producedReply)) return;
    noticeEmitted = true;
    turn.emit({ type: "chat:notice", payload: { ...routing(), notice } });
  };
  // Lazily open the single hub turn on the first RENDERED (main-agent) message, so
  // a background stretch that is nothing but sub-agent sidechain steps opens no
  // empty turn.
  const ensureTurn = (sid: string | null): void => {
    if (turn) return;
    resolvedSession = sid;
    turn = hub.startTurn(projectSlug, null, sid);
    const t = turn;
    translate = createSDKMessageHandler({
      onText: (chunk) => {
        if (chunk) t.emit({ type: "chat:response", payload: { ...routing(), chunk } });
      },
      onBoundary: () => {
        t.emit({ type: "chat:message_boundary", payload: routing() });
      },
      onToolStart: (start) => {
        t.emit({
          type: "chat:tool_start",
          payload: {
            ...routing(),
            toolName: start.toolName,
            inputSummary: start.inputSummary,
            toolUseId: start.toolUseId,
            parentToolUseId: start.parentToolUseId,
            ...subagentLaunchFields(launches, start.toolName, start.toolUseId),
          },
        });
      },
      onToolCall: (call) => {
        t.emit({
          type: "chat:tool_call",
          payload: {
            ...routing(),
            toolName: call.toolName,
            inputSummary: call.inputSummary,
            output: call.output,
            isError: call.isError,
            durationMs: call.durationMs,
            toolUseId: call.toolUseId,
            ...subagentLaunchFields(launches, call.toolName, call.toolUseId),
          },
        });
      },
    });
  };
  const onMessage = async (m: SDKMessage): Promise<void> => {
    // (1) Skip sidechain sub-agent nested steps from rendering (see header). The
    // attribution lives on the top-level SDK message OR its nested `message`.
    if (isSidechainMessage(m)) return;
    if (m.session_id) resolvedSession = m.session_id;
    // #429: recover any Task/Agent launch from this (main-agent) message's tool_use
    // input so the enriched, expandable card renders live (before translate fires).
    for (const l of extractSubagentLaunches(m)) launches.set(l.toolUseId, l);
    // (2) One persistent turn+translator for the whole stream — never reset per
    // `result`, so tool_use↔tool_result pairing and card reconciliation survive
    // across re-invocation boundaries.
    ensureTurn(m.session_id ?? resolvedSession);
    if (m.session_id) turn!.setSession(m.session_id);
    if (messageProducedReply(m as Parameters<typeof messageProducedReply>[0]))
      producedReply = true;
    const notice = noticeFromMessage(m as Parameters<typeof noticeFromMessage>[0]);
    if (notice) emitNotice(notice);
    if (
      m.type === "result" &&
      ((typeof m.subtype === "string" && m.subtype.startsWith("error")) || m.success === false)
    ) {
      sawError = true;
    }
    await translate!(m as unknown as ChatSDKMessage);
  };
  // Finalize the single turn once the background stream ends (reaper reap). No-op
  // if nothing was ever rendered (a sidechain-only stretch opened no turn).
  const onDone = (): void => {
    if (!turn) return;
    turn.emit({
      type: "chat:complete",
      payload: { ...routing(), sessionId: resolvedSession, success: !sawError },
    });
    turn.end();
    turn = null;
    translate = null;
  };
  return { onMessage, onDone };
};


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
  // #429: sub-agent launches recovered live from the tool_use input (keyed by
  // toolUseId), so the launching card shows the real type/title + is expandable
  // without a refresh. Populated in onMessage before each translate; read by the
  // onToolStart/onToolCall closures below via subagentLaunchFields.
  const subagentLaunches = new Map<string, SubagentLaunch>();
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

  // Gap B sink (session mode, non-scratch): one persistent sink renders every
  // background-completion re-invocation onto a single hub turn (skipping sidechain
  // sub-agent steps). Built once so its state (turn/translator) spans the stream.
  const bgSink =
    driveMode === "session" && projectSlug !== SCRATCH_SLUG
      ? makeBackgroundTurnSink(projectSlug)
      : null;

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
    // Gap B: deliver autonomous background-completion turns live (session mode
    // only; batch `chat` ignores this). Scratch has no keeper worth streaming
    // background turns for, so skip it. See makeBackgroundTurnSink above.
    onBackgroundMessage: bgSink?.onMessage,
    onBackgroundDone: bgSink?.onDone,
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
      // #429: recover any Task/Agent launch from this message's tool_use input so
      // the enriched card renders live — must run before translate fires onToolStart.
      for (const l of extractSubagentLaunches(m)) subagentLaunches.set(l.toolUseId, l);
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
  return {
    startAgentTurn,
    buildInjection,
    wakeInjection,
    selfMcpCtx,
    injectRecoveryNudge,
    recoveryEngine,
    emitAfterTurn: triggers.emitAfterTurn,
    composePreloadedPrompt: triggers.composePreloadedPrompt,
    fireTrigger: triggers.fireTrigger,
    makeBackgroundTurnSink,
  };
}

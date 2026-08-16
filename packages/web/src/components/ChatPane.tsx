import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { chatClient, type ConnectionState } from "../lib/ws";
import { DictationButton } from "./DictationButton";
import { api } from "../lib/api";
import { readChatModel, writeChatModel } from "../lib/chatModel";
import { readDraft, writeDraft } from "../lib/draft";
import {
  readQueued,
  writeQueued,
  readQueuedId,
  writeQueuedId,
  readQueuedAttachments,
  writeQueuedAttachments,
  newQueuedId,
} from "../lib/queued";
import { AlertIcon, ClockIcon, PaperclipIcon, SendIcon, SparkIcon, StopIcon } from "./icons";
import type {
  AttachmentRef,
  AttachmentsConfig,
  AttachmentsOverride,
  ChatCompleteUsage,
  ChatTriggerInfo,
  ChatUsage,
  HistoryMessage,
  ModelInfo,
  RecoveryConfig,
  RecoveryOverride,
  SlashCommand,
  LiveBackgroundTask,
} from "../lib/types";
import { acceptAttribute } from "../lib/attachments";
import { AttachmentTrayItem } from "./MessageAttachments";
import { TriggerCapabilityBanner } from "./TriggerCapabilityBanner";
import { ConfirmDialog } from "./ConfirmDialog";
import { PaddockManageProjectContext } from "./PaddockManageBlock";
// --- extracted chat modules (issue #403) -------------------------------------
import {
  type Turn,
  historyToTurns,
  mergeHydratedTurns,
  nextId,
  sealStreaming,
} from "./chat/turnModel";
import {
  RecoveryContext,
  type RecoveryContextValue,
  SubagentActivityContext,
  SubagentFetchContext,
  SubagentFocusContext,
  type SubagentFocusValue,
  SubagentLiveContext,
  ToolImageUrlContext,
  TurnActionsContext,
  type TurnActionsValue,
} from "./chat/chatContexts";
import { RunningWork } from "./chat/RunningWork";
import { useRunningSubagents, useSubagentActivity } from "./chat/useSubagentActivity";
import { useShellCommands } from "./chat/useShellCommands";
import {
  ConnDot,
  PreloadToggle,
  QueuedMessageBar,
  StatusRow,
  WorkingIndicator,
} from "./chat/ComposerBits";
import { TurnRow } from "./chat/Transcript";
import { messageAnchorId } from "../routes/ProjectView/urls";
import { useChatSocket } from "./chat/useChatSocket";
import { useComposerAttachments } from "./chat/useComposerAttachments";

// `historyToTurns` was previously defined here; it now lives in ./chat/turnModel.
// Re-export it so existing importers (e.g. ChatPane.turns.test.ts) resolve unchanged.
export { historyToTurns };

/**
 * How long a `stopping…` hold may go unanswered before the row hands its button
 * back (#848). Generous on purpose: a stop that lands takes well under a second
 * (the runtime kills the task and the SDK's notification evicts the row), so
 * anything near this is a lost frame or a task refusing to die — never a normal
 * stop that is merely slow.
 */
export const STOP_TIMEOUT_MS = 15_000;
/** Claims only what is known: we did not hear back. Not "the stop failed". */
export const STOP_TIMEOUT_MESSAGE = "no response — try again";

export interface ChatPaneProps {
  /** The workspace key this chat belongs to (`""` — the root — for a root chat). */
  projectSlug: string;
  /** Existing session to resume, or undefined for a new chat. */
  initialSessionId?: string;
  /** Loads the transcript for a resumed session. */
  loadHistory?: (sessionId: string) => Promise<HistoryMessage[]>;
  /** Called when a brand-new chat first gets a real session id (to refresh lists). */
  onSessionEstablished?: (sessionId: string) => void;
  /**
   * Called the moment a brand-new chat first learns its session id — typically
   * mid-stream, well before the turn completes — so the parent can surface a
   * pending list entry immediately (issue #36). Fires at most once per chat.
   */
  onSessionStarted?: (sessionId: string) => void;
  /**
   * Called whenever a turn completes (pull model: re-fetch project/files for
   * sweeps). Carries the turn's live per-turn usage + session id when the
   * `chat:complete` frame reported one, so the parent can seed the chat-list
   * context ring immediately instead of waiting on a disk re-read (issue #164).
   */
  onTurnComplete?: (live?: { sessionId: string; usage: ChatCompleteUsage }) => void;
  /** Whether the project has an OVERVIEW.md to preload (issue #1). */
  preloadAvailable?: boolean;
  /**
   * The project's configured model — the default model for this chat's
   * picker (CONTRACT-v3 §8). Undefined until the project DTO loads, where the
   * default falls back to the models response's `defaultModel`.
   */
  projectModel?: string;
  /**
   * The project's per-project offered-models allow-list (issue #457 Step 2), from
   * the Project DTO. When non-empty it NARROWS this chat's model picker to that
   * subset of the instance list; undefined/empty ⇒ the full instance list.
   */
  projectModels?: string[];
  /**
   * When set, this is a FORK composer: the chat has no session id yet, and its
   * first message is sent with `forkFrom` so the server branches this source
   * session (resumes its context, writes to a brand-new id). Cleared naturally
   * once the forked chat establishes its own session id.
   */
  /**
   * The chat this one was forked from, shown as a "Fork of <name>" back-link in
   * the composer footer (from local fork lineage). `onOpenForkParent` navigates
   * to it.
   */
  forkParent?: { sessionId: string; name: string };
  onOpenForkParent?: (sessionId: string) => void;
  /** Focus the composer on mount (e.g. right after forking, to continue). */
  autoFocus?: boolean;
  emptyHint?: string;
  placeholder?: string;
  /**
   * For a TRIGGER chat (Epic T / T4): the owning trigger's truthful-from-config
   * capability descriptor. When present, a read-only capability banner floats atop the
   * message history stating that this is a trigger agent, its type + firing condition,
   * and its granted tools. Absent for every non-trigger chat.
   */
  trigger?: ChatTriggerInfo;
  /**
   * The project's per-project keeper-chat recovery override (issue #301), from the
   * Project DTO. Combined with the instance default (GET /api/models
   * `recoveryDefault`) to resolve whether the killed-task Continue affordance is
   * shown. Undefined when the project sets no override.
   */
  projectRecovery?: RecoveryOverride;
  /**
   * The project's per-project inbound-attachment override (issue #328), from the
   * Project DTO. Combined with the instance default (GET /api/models
   * `attachmentsDefault`) to resolve the composer's effective attachment config
   * (enabled + size/count/type caps). Undefined when unset.
   */
  projectAttachments?: AttachmentsOverride;
  /**
   * Fork a NEW chat branched at an earlier message (issue #451): given the anchor
   * message's transcript uuid, the parent asks for a name (the same dialog the
   * sidebar's fork button opens) and then forks this session's PREFIX up to that
   * turn and navigates to the new chat. Undefined ⇒ the per-message fork
   * affordance is hidden (a new chat with no session id yet).
   */
  onForkFromMessage?: (uuid: string) => void;
  /**
   * Revert this chat back to an earlier message (issue #451): given the anchor
   * message's transcript uuid, the parent truncates the session in place. Resolves
   * after the server write so the pane can reload its (now shorter) transcript.
   * Undefined ⇒ the per-message revert affordance is hidden.
   */
  onRevertToMessage?: (uuid: string) => Promise<void>;
  /**
   * Builds the absolute deep link to one message, given its transcript uuid —
   * the href behind the hover rail's time/context pill. URL shape belongs to the
   * route, not the pane (the root workspace and a project spell chat URLs
   * differently), so this arrives as a prop like the two actions above.
   */
  onMessageLink?: (uuid: string) => string;
  /**
   * The message this chat was opened AT, from the URL fragment — scrolled to and
   * flashed once history has hydrated. Undefined for a plain chat open.
   */
  focusMessageUuid?: string;
}

export function ChatPane({
  projectSlug,
  initialSessionId,
  loadHistory,
  onSessionEstablished,
  onSessionStarted,
  onTurnComplete,
  preloadAvailable = false,
  projectModel,
  projectModels,
  forkParent,
  onOpenForkParent,
  autoFocus,
  emptyHint,
  placeholder,
  trigger,
  projectRecovery,
  projectAttachments,
  onForkFromMessage,
  onRevertToMessage,
  onMessageLink,
  focusMessageUuid,
}: ChatPaneProps) {
  const [turns, setTurns] = useState<Turn[]>([]);
  // Seed the composer from any unsent draft persisted for this chat. The pane is
  // remounted on a real chat switch (keyed by the parent), so this initializer
  // re-runs per chat and restores its own draft (see lib/draft.ts).
  const [draft, setDraft] = useState(() => readDraft(initialSessionId, projectSlug));
  // The composer textarea, so dictated text can be appended and the box resized.
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [hydrating, setHydrating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A transient, NON-error explanation shown above the composer: currently just
  // "another client stopped the turn and took the queued message back", which
  // would otherwise be a chip vanishing for no visible reason. Self-clearing —
  // it explains something that already happened and needs no acknowledgement.
  const [notice, setNotice] = useState<string | null>(null);
  const [conn, setConn] = useState<ConnectionState>(chatClient.state);
  // A measured-but-not-yet-confirmed revert (#541): what the click would remove,
  // held while the confirmation dialog is up. null when the dialog is closed.
  const [revertPlan, setRevertPlan] = useState<{
    uuid: string;
    count: number;
    toolCount: number;
    anchorIsUser: boolean;
  } | null>(null);

  // Issue #91: a single message queued to auto-send when the current turn
  // finishes. `queued` drives the toolbar above the composer; `queuedRef` mirrors
  // it for the (stably-subscribed) socket handlers, which can't see the latest
  // `queued` state. `null` = nothing queued.
  // Issue #197: hydrate any message persisted for this chat so it survives a chat
  // switch / reload instead of being silently dropped (mirrors the composer draft
  // above; see lib/queued.ts).
  // Issue #245: the SERVER now owns auto-send — this pane persists the queue to the
  // server and renders/clears it when the server says it flushed (onQueuedFlushed);
  // it no longer sends the queued message itself. `queuedIdRef` is the queue's
  // opaque, stable id, persisted alongside the text so the server can tell a stale
  // copy this pane re-asserts on reload from one it has not sent yet (#245/#736) —
  // and can tell THIS pane's queue from another client's (#629).
  const [queued, setQueued] = useState<string | null>(() =>
    readQueued(initialSessionId, projectSlug),
  );
  const queuedRef = useRef<string | null>(queued);
  const queuedIdRef = useRef<string | null>(readQueuedId(initialSessionId, projectSlug));
  // Issue #728: the files staged behind the queued message. Enqueueing used to
  // ignore the composer tray entirely — `send()` returned early into setQueued and
  // never touched `attachRef`, and the flush happens SERVER-side, so `sendText`
  // (the only consumer of the tray) never ran for a queued message. The tray never
  // cleared and the file silently rode whatever was sent next. Attachments are now
  // consumed by ENQUEUEING, exactly as they are by sending: they move out of the
  // tray, into the queue slot, and out again with the drained turn.
  //
  // The slot is server-owned and shared across clients (#751/#629), so this is a
  // mirror of what the server says is staged, not a private copy — the server
  // unions attachments in, broadcasts them on `chat:queued_state`, sends them with
  // the drain, and hands them back on `chat:queued_returned`.
  const [queuedAttachments, setQueuedAttachments] = useState<AttachmentRef[]>(() =>
    readQueuedAttachments(initialSessionId, projectSlug),
  );
  const queuedAttachRef = useRef<AttachmentRef[]>(queuedAttachments);
  queuedAttachRef.current = queuedAttachments;
  // Anything at all queued? A slot can hold files with no prose (#328: an
  // attachment-only message is valid), so this is text OR attachments — testing
  // the text alone is why an attachment-only submit during a live turn queued
  // nothing and rendered no toolbar.
  const hasQueued = queued != null || queuedAttachments.length > 0;
  // Set when the user hits Stop, so the completion it triggers does NOT flush the
  // queue (we hold rather than fire a follow-up into a cancelled turn). Cleared
  // on the next completion.
  const cancelledRef = useRef(false);
  // #329: whether this turn already surfaced an inline notice (usage limit /
  // max-turns / error). When it did, the failed-completion path skips the
  // transient composer-level error toast (the richer inline notice supersedes it);
  // when no notice arrived, the toast still shows as a backstop.
  const noticeThisTurnRef = useRef(false);

  // Issue #1/#188: preload the project's curated OVERVIEW.md + CHANGELOG.md as
  // context on the FIRST turn of a new project chat. Default ON for project
  // chats. Only sent on the
  // first message of a never-resumed session (the server ignores it otherwise).
  const [preloadContext, setPreloadContext] = useState(true);
  const showPreload = !initialSessionId;
  // The checkbox only has an effect once a turn has been sent on a brand-new chat.
  const firstTurnSentRef = useRef(false);

  // --- model picker + context meter (CONTRACT-v3 §8) -------------------------
  // The selectable models + defaults (fetched once, app-wide static). The
  // picker's default is the project's model, else the instance default; a
  // per-chat localStorage override takes precedence when present.
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [instanceDefaultModel, setInstanceDefaultModel] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  // Instance-default recovery config (issue #301), fetched once with the models.
  // Combined with the per-project `projectRecovery` override to gate the killed-
  // task Continue affordance. Null until fetched (defaults apply until then).
  const [recoveryDefault, setRecoveryDefault] = useState<RecoveryConfig | null>(null);
  // Instance-default inbound-attachment config (issue #328), fetched with models.
  // Combined with the per-project `projectAttachments` override to resolve the
  // composer's effective config. Null until fetched (allow-all defaults apply).
  const [attachmentsDefault, setAttachmentsDefault] = useState<AttachmentsConfig | null>(null);


  // --- slash-command autocomplete (issue #103) -------------------------------
  // The commands available to this chat's agent, fetched once per chat (the
  // server memoizes the underlying subprocess). Drives the composer menu that
  // pops when the draft starts with "/". `menuIndex` is the keyboard-highlighted
  // row; `menuDismissed` lets Escape hide the menu without clearing the draft
  // (reset the moment the user types again).
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  // The selected model is kept in a ref too so `send` reads the latest without
  // re-subscribing (the picker can change between sends without remounting).
  const modelRef = useRef<string | null>(null);
  // Last completed turn's usage for THIS chat (stale-by-one-turn by design).
  // Reset whenever the chat identity changes (see the hydration effect below).
  const [usage, setUsage] = useState<ChatCompleteUsage | null>(null);
  // Cumulative lifetime token totals + cost for THIS chat (issue #152), read
  // from the transcript via /context on open and refreshed after each completed
  // turn. Kept separate from `usage` (the per-turn context-fill meter) because
  // the live ws chat:complete frame only knows the current turn.
  const [sessionUsage, setSessionUsage] = useState<ChatUsage | null>(null);

  // The chat's default model: the project's model, else instanceDefaultModel.
  const defaultModel = projectModel ?? instanceDefaultModel;

  // The models OFFERED in this chat's picker (issue #457 Step 2): the instance list
  // narrowed to the project's allow-list when it sets one, else the full instance
  // list. A project that sets no allow-list gets the full list.
  const pickerModels = useMemo(
    () =>
      projectModels && projectModels.length > 0
        ? models.filter((m) => projectModels.includes(m.id))
        : models,
    [models, projectModels],
  );

  // Session id is kept in a ref (the WS sub needs the latest without re-subscribing).
  const sessionRef = useRef<string | null>(initialSessionId ?? null);
  const jobRef = useRef<string | null>(null);
  // Set true when the user hits Stop during the "pre-arm" window — the turn is
  // already streaming (Stop is showing) but the server hasn't round-tripped the
  // jobId yet, so there's nothing to cancel. `armJob` fires this deferred cancel
  // the instant the jobId arrives, so Stop isn't a silent no-op there (#196).
  const pendingCancelRef = useRef(false);

  // --- composer attachments (issue #328) — extracted to a hook (#403) --------
  // The staged-tray state + paste/drag/drop/pick handlers live in
  // useComposerAttachments; the refs it returns are read by the send path below.
  const {
    attachments,
    attachRef,
    setAttachments,
    uploading,
    dragOver,
    fileInputRef,
    attachConfig,
    attachEnabled,
    removeAttachment,
    onComposerPaste,
    onComposerDragOver,
    onComposerDragLeave,
    onComposerDrop,
    onPickFiles,
  } = useComposerAttachments({
    projectSlug,
    initialSessionId,
    attachmentsDefault,
    projectAttachments,
    sessionRef,
    setError,
  });

  // Lazy-loader for sub-agent nested steps (issue #37). Bound to this chat's slug
  // + current session; the sessionRef read defers to click time so it's correct
  // even for a chat whose session id was established mid-stream.
  const fetchSubagent = useCallback(
    (toolUseId: string): Promise<HistoryMessage[]> =>
      sessionRef.current
        ? api.subagentMessages(projectSlug, sessionRef.current, toolUseId)
        : Promise.resolve([]),
    [projectSlug],
  );
  // Which sub-agents are working right now, and what each is doing — derived from
  // the SAME turn list the transcript renders, then polled once per sub-agent so a
  // collapsed card still reports progress to the running-sub-agents bar.
  //
  // `streaming` is passed to the poller only to decide when a quiet sub-agent may
  // be declared finished — NOT to gate the list. A sub-agent outlives its parent's
  // turn (the SDK backgrounds them by default), so gating on `streaming` emptied
  // the bar the instant the parent replied, while the work carried on.
  const subagentCandidates = useRunningSubagents(turns);
  const subagentActivity = useSubagentActivity(subagentCandidates, fetchSubagent, streaming);
  // #604: live background work (shells, monitors, workflows, and any sub-agent
  // the transcript path has not found), pushed from the server rather than
  // polled. Keyed on the session so a remount re-subscribes and is repopulated
  // from the connect-time snapshot.
  const [backgroundTasks, setBackgroundTasks] = useState<LiveBackgroundTask[]>([]);
  useEffect(() => {
    const sid = initialSessionId ?? null;
    if (!sid) {
      setBackgroundTasks([]);
      return;
    }
    return chatClient.onBackgroundWork(sid, setBackgroundTasks);
  }, [initialSessionId]);
  // #848: stopping one piece of background work. Two pieces of local state, one
  // per outcome that is not simply "the row goes away":
  //  - `stopping` holds a row greyed at `stopping…` from the click until the
  //    SDK's terminal notification evicts it. The click deliberately does NOT
  //    remove the row — an optimistic removal would lie whenever the stop is
  //    refused, and a refusal is a real case (`monitor_mcp`).
  //  - `stopFailed` records a refusal so the row says "can't stop" and stays
  //    clickable, instead of hanging at `stopping…` forever.
  // `gone` needs neither: the server drops the task from its registry, so the
  // row leaves on the ordinary `chat:background` frame and we just release it.
  const [stoppingTasks, setStoppingTasks] = useState<Set<string>>(new Set());
  const [stopFailedTasks, setStopFailedTasks] = useState<Map<string, string>>(new Map());
  /*
   * Watchdogs for held rows, one per in-flight stop.
   *
   * EVERY exit from `stopping…` depends on a frame arriving: either
   * `chat:stop_task_result`, or the `chat:background` that follows the SDK's
   * terminal notification. `chat:stop_task_result` is unicast and carries no
   * `Routing`, so unlike a turn frame the hub neither buffers nor replays it —
   * a socket drop between the send and the reply loses it outright. The row
   * would then sit greyed with its button DISABLED and no way back, and the
   * pruning effect below cannot rescue it, because a task that never died never
   * leaves the registry.
   *
   * So the hold is given a deadline. It is deliberately NOT cleared when the
   * server answers `stopping`: that only means the request was accepted, and a
   * task that accepts a kill and then does not die strands the row exactly the
   * same way — which is the fifteen-wedged-shells case this feature exists for.
   */
  const stopTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const clearStopTimer = useCallback((taskId: string) => {
    const t = stopTimers.current.get(taskId);
    if (t !== undefined) {
      clearTimeout(t);
      stopTimers.current.delete(taskId);
    }
  }, []);
  // Unmount: never leave a timer holding a reference to a dead component.
  useEffect(() => {
    const timers = stopTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);
  useEffect(() => {
    const sid = initialSessionId ?? null;
    if (!sid) return;
    return chatClient.onStopTaskResult(sid, ({ taskId, outcome, message }) => {
      if (outcome === "stopping") return; // Keep holding; the notification ends it.
      clearStopTimer(taskId);
      // Both remaining outcomes release the hold — one because the work is gone,
      // one because it never stopped. Only the latter leaves a mark.
      setStoppingTasks((prev) => {
        if (!prev.has(taskId)) return prev;
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
      if (outcome === "error") {
        setStopFailedTasks((prev) =>
          new Map(prev).set(taskId, message || "the runtime refused the stop"),
        );
      }
    });
  }, [initialSessionId, clearStopTimer]);
  const stopBackgroundTask = useCallback(
    (taskId: string) => {
      const sid = initialSessionId ?? null;
      if (!sid) return;
      // Re-clicking a failed row is a retry, so clear the old failure first —
      // otherwise the row would show "can't stop" while a fresh stop is in
      // flight. A row already stopping is ignored (the button is disabled too,
      // so this only catches a programmatic double-send such as Stop all).
      let already = false;
      setStoppingTasks((prev) => {
        if (prev.has(taskId)) {
          already = true;
          return prev;
        }
        return new Set(prev).add(taskId);
      });
      if (already) return;
      setStopFailedTasks((prev) => {
        if (!prev.has(taskId)) return prev;
        const next = new Map(prev);
        next.delete(taskId);
        return next;
      });
      clearStopTimer(taskId);
      stopTimers.current.set(
        taskId,
        setTimeout(() => {
          stopTimers.current.delete(taskId);
          // Reached only if nothing ever answered AND the row never left, so the
          // hold is still live. Release it and hand the button back. The wording
          // claims only what we know — we did not hear back — rather than
          // asserting the stop failed, which we cannot tell from here.
          setStoppingTasks((prev) => {
            if (!prev.has(taskId)) return prev;
            const next = new Set(prev);
            next.delete(taskId);
            return next;
          });
          setStopFailedTasks((prev) => new Map(prev).set(taskId, STOP_TIMEOUT_MESSAGE));
        }, STOP_TIMEOUT_MS),
      );
      chatClient.stopTask(sid, taskId);
    },
    [initialSessionId, clearStopTimer],
  );
  // Never let the two maps outlive the rows they annotate: a task that has left
  // the bar (stopped, finished on its own, or evicted by a level signal) must
  // not leave a stale hold behind to grey out a future task that reuses the id.
  useEffect(() => {
    const live = new Set(backgroundTasks.map((t) => t.id));
    for (const id of [...stopTimers.current.keys()]) {
      if (!live.has(id)) clearStopTimer(id);
    }
    setStoppingTasks((prev) => {
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
    setStopFailedTasks((prev) => {
      const next = new Map([...prev].filter(([id]) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [backgroundTasks, clearStopTimer]);
  // #853: the registry's wire carries a shell's DESCRIPTION but never its
  // command, so the bar could only report what the agent meant to run. The
  // command is already on the client — it is the `inputSummary` of the Bash call
  // that launched the task — so it is joined here, where the turns live, and
  // handed down. Resolved in ChatPane rather than in the bar because the bar
  // sits outside the scrolling transcript and takes props by design.
  const shellCommands = useShellCommands(turns);
  // The bar lists only those still working. Once a sub-agent has been polled its
  // own transcript decides; BEFORE the first poll lands we fall back to whether
  // the chat is streaming — so a just-launched sub-agent appears immediately,
  // while a finished chat reopened from history (never polled) lists nothing.
  const runningSubagents = useMemo(
    () =>
      subagentCandidates.filter(
        (c) => subagentActivity.get(c.toolUseId)?.running ?? streaming,
      ),
    [subagentCandidates, subagentActivity, streaming],
  );
  // Raw-file URL builder for inline image reads (issue #239).
  const toolImageUrl = useMemo(
    () => (projectSlug ? (relPath: string) => api.projectFileRawUrl(projectSlug, relPath) : null),
    [projectSlug],
  );
  const isNewSessionRef = useRef<boolean>(!initialSessionId);
  // True while this pane has an in-flight turn (from send() until complete/error).
  // Used to session-guard incoming frames so a still-streaming chat's stragglers
  // can't leak into a chat that was switched to mid-stream (issue #35).
  const streamingRef = useRef(false);
  // True when a brand-new chat has sent its first message but not yet learned
  // its server session id — the only state in which a session-less/first frame
  // is legitimately ours.
  const awaitingSessionRef = useRef(false);
  // Guards the one-shot onSessionStarted notification for a brand-new chat.
  const startedNotifiedRef = useRef(false);
  // The session id this pane established LIVE (a brand-new chat that just saved).
  // Used to ignore the parent mirroring that id into the URL (which flows back
  // as `initialSessionId`) so we don't needlessly re-hydrate the live transcript.
  const establishedHereRef = useRef<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  // Timestamps of `chat:injected` frames already rendered live (#290), so a hub
  // REPLAY of a buffered frame (reconnect/re-attach re-delivers it with the SAME
  // server-stamped timestamp) is dropped, while a genuinely NEW injection — even
  // one whose text is byte-identical to an earlier one — carries a fresh timestamp
  // and still renders. Keying on content alone would have collapsed a real second
  // identical injection into the first (Warren #292).
  const seenInjectionsRef = useRef<Set<string>>(new Set());

  // --- scroll management: only auto-scroll when pinned to the bottom ---------
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  // Reveal request from the running-sub-agents bar → the matching card expands,
  // scrolls itself into view and flashes. The nonce makes a repeat tap on the SAME
  // sub-agent a new request (see SubagentFocusContext).
  //
  // Unpinning is load-bearing, not a nicety. During a live turn `turns` changes
  // constantly, and the layout effect above re-snaps to the bottom on every one of
  // those updates — which silently overrode the smooth scroll and yanked the view
  // back down, so revealing anything but the LAST card appeared to do nothing.
  // An explicit reveal is a deliberate scroll away from the bottom, so it unpins
  // exactly as a manual scroll-up would; the next send re-pins (see send()).
  const [focusedSubagent, setFocusedSubagent] = useState<SubagentFocusValue["focused"]>(null);
  const subagentFocus = useMemo<SubagentFocusValue>(
    () => ({
      focused: focusedSubagent,
      focus: (toolUseId: string) => {
        pinnedRef.current = false;
        setFocusedSubagent((prev) => ({ toolUseId, nonce: (prev?.nonce ?? 0) + 1 }));
      },
    }),
    [focusedSubagent],
  );

  // --- connection state ------------------------------------------------------
  useEffect(() => chatClient.onState(setConn), []);

  // --- model list (fetched once) ---------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void api
      .getModels()
      .then((res) => {
        if (cancelled) return;
        setModels(res.models);
        setInstanceDefaultModel(res.defaultModel);
        setRecoveryDefault(res.recoveryDefault);
        setAttachmentsDefault(res.attachmentsDefault);
      })
      .catch(() => {
        /* leave the picker empty; sends fall back to the server default */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // --- slash commands (fetched once per chat) --------------------------------
  useEffect(() => {
    let cancelled = false;
    // Every chat queries its workspace keeper.
    void api
      .projectCommands(projectSlug)
      .then((cmds) => {
        if (!cancelled) setCommands(cmds);
      })
      .catch(() => {
        /* no menu if the list can't be fetched; sending is unaffected */
      });
    return () => {
      cancelled = true;
    };
  }, [projectSlug]);

  // The active slash query: the text after a leading "/", but only while the
  // draft is still the bare command name (no whitespace yet). `null` means the
  // menu should not consider itself triggered. Empty string = just typed "/".
  const slashQuery = useMemo(() => {
    if (!draft.startsWith("/")) return null;
    const rest = draft.slice(1);
    if (/\s/.test(rest)) return null; // moved on to typing arguments
    return rest;
  }, [draft]);

  // Case-insensitive substring match on the command name, preserving list order.
  const menuCommands = useMemo(() => {
    if (slashQuery === null) return [];
    const q = slashQuery.toLowerCase();
    return commands.filter((c) => c.name.toLowerCase().includes(q));
  }, [slashQuery, commands]);

  const menuOpen = slashQuery !== null && !menuDismissed && menuCommands.length > 0;

  // Reset the highlighted row whenever the filtered set changes, and re-arm a
  // menu the user dismissed with Escape once they edit the query again.
  useEffect(() => {
    setMenuIndex(0);
  }, [slashQuery]);
  useEffect(() => {
    setMenuDismissed(false);
  }, [slashQuery]);

  // Accept a command: replace the draft with "/name " (trailing space closes the
  // menu — `slashQuery` becomes null — and positions the caret for arguments).
  const acceptCommand = useCallback((cmd: SlashCommand) => {
    setDraft(`/${cmd.name} `);
    requestAnimationFrame(() => composerRef.current?.focus());
  }, []);

  // Keep the selected model in both state (for the <select>) and a ref (so
  // `send` reads the latest without resubscribing).
  const selectModel = useCallback(
    (next: string) => {
      setModel(next);
      modelRef.current = next;
      writeChatModel(sessionRef.current ?? initialSessionId, projectSlug, next);
    },
    [projectSlug, initialSessionId],
  );

  // --- hydrate a resumed session --------------------------------------------
  useEffect(() => {
    // The parent mirrors a brand-new chat's established session id into the URL
    // (which flows back in as `initialSessionId`) WITHOUT remounting this pane.
    // That is NOT a chat switch: the live transcript is already correct, so skip
    // re-hydration ONLY when the incoming id is the one this pane established
    // live. (On a normal mount/switch, sessionRef is pre-seeded with
    // initialSessionId, so guarding on sessionRef alone would wrongly skip the
    // hydration we DO want — hence the dedicated establishedHereRef.)
    if (initialSessionId && initialSessionId === establishedHereRef.current) {
      isNewSessionRef.current = false;
      return;
    }

    let cancelled = false;
    sessionRef.current = initialSessionId ?? null;
    isNewSessionRef.current = !initialSessionId;
    jobRef.current = null;
    streamingRef.current = false;
    awaitingSessionRef.current = false;
    startedNotifiedRef.current = false;
    setError(null);
    setStreaming(false);

    if (initialSessionId && loadHistory) {
      setHydrating(true);
      setTurns([]);
      void loadHistory(initialSessionId)
        .then((msgs) => {
          if (cancelled) return;
          // MERGE, don't replace (#726). The socket is attached future-only — a
          // fresh mount hydrates over REST, so replaying buffered frames would
          // duplicate — which means any frame that arrives between the server
          // reading the transcript and this response landing has already been
          // appended to `prev`. A wholesale replace threw those away: remounting
          // mid-turn (a tab switch and back) could silently lose the assistant's
          // entire reply and leave a Task card spinning on RUNNING forever, with
          // only a page reload to bring them back. `cancelled` guards a newer chat
          // SWITCH; it never guarded newer frames.
          //
          // `prev` here is exactly the live turns since `setTurns([])` above, and
          // is empty whenever the fetch beat them — so on the fast path (localhost
          // answers in single-digit ms) this is the same full replace as before.
          setTurns((prev) => mergeHydratedTurns(historyToTurns(msgs), prev));
        })
        .catch(() => {
          if (!cancelled) setError("Could not load this chat's history.");
        })
        .finally(() => {
          if (!cancelled) setHydrating(false);
        });
    } else {
      setTurns([]);
      setHydrating(false);
    }

    // Seed the context meter from the transcript's last-turn usage so a chat
    // opened from history (e.g. a resumed or migrated chat) shows context
    // immediately — stale-by-one-turn, exactly like a live turn's usage. This
    // resolves after the synchronous meter-reset effect below, so it wins.
    if (initialSessionId) {
      void api
        .chatContext(projectSlug, initialSessionId)
        .then((ctx) => {
          if (cancelled || !ctx) return;
          setUsage({
            inputTokens: ctx.contextTokens,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            contextTokens: ctx.contextTokens,
            contextLimit: ctx.contextLimit,
          });
          // Cumulative session totals (issue #152) come from the same payload.
          setSessionUsage(ctx);
        })
        .catch(() => {
          /* leave the meter at "—" */
        });
    }

    return () => {
      cancelled = true;
    };
  }, [projectSlug, initialSessionId, loadHistory]);

  // --- per-message fork/revert affordances (issue #451) ----------------------
  // Reload this chat's transcript + context ring after a revert truncates it, so
  // the pane reflects the shorter history without a full remount.
  const reloadHistory = useCallback(async () => {
    if (!initialSessionId || !loadHistory) return;
    try {
      const msgs = await loadHistory(initialSessionId);
      setTurns(historyToTurns(msgs));
    } catch {
      setError("Could not reload this chat's history.");
    }
    try {
      const ctx = await api.chatContext(projectSlug, initialSessionId);
      if (ctx) {
        setUsage({
          inputTokens: ctx.contextTokens,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextTokens: ctx.contextTokens,
          contextLimit: ctx.contextLimit,
        });
        setSessionUsage(ctx);
      }
    } catch {
      /* leave the meter as-is */
    }
  }, [initialSessionId, loadHistory, projectSlug]);

  // Revert with a confirmation that counts the lost turns — and warns that tool
  // actions after this point are NOT undone (only the conversation is).
  //
  // #541: this used to build one long `\n\n`-delimited string for `window.confirm`,
  // which flattened the tool-call caveat — the most important sentence here — into
  // the middle of a plain-text paragraph. Now the click only *measures* the revert
  // and parks the result; the dialog renders it as structured content.
  const handleRevert = useCallback(
    (uuid: string) => {
      if (!onRevertToMessage) return;
      const idx = turns.findIndex((t) => t.id.split("#")[0] === uuid);
      const anchorIsUser = idx >= 0 && turns[idx].kind === "user";
      // Mirror the server's landing boundary so the count matches what's removed:
      // - assistant anchor: keep it + its OWN trailing tool calls; drop from the
      //   next real turn on (#451 QA — it used to over-count the anchor's tools).
      // - user anchor: revert rewinds to the assistant's previous reply, so the
      //   clicked message (and everything after) is removed.
      let start = idx + 1;
      if (anchorIsUser) {
        let a = idx - 1;
        while (a >= 0 && turns[a].kind !== "assistant") a--;
        start = a + 1;
      } else {
        while (start < turns.length && (turns[start].kind === "tool" || turns[start].kind === "file")) {
          start++;
        }
      }
      const after = idx >= 0 ? turns.slice(start) : [];
      const toolCount = after.filter((t) => t.kind === "tool").length;
      setRevertPlan({ uuid, count: after.length, toolCount, anchorIsUser });
    },
    [onRevertToMessage, turns],
  );

  const confirmRevert = useCallback(async () => {
    if (!revertPlan) return;
    try {
      await onRevertToMessage?.(revertPlan.uuid);
      await reloadHistory();
    } catch {
      // Thrown rather than banner-set: ConfirmDialog catches it, shows it in
      // place and leaves the dialog open, so a failed revert is retryable
      // instead of silently closing and pointing at a banner elsewhere.
      throw new Error("Could not revert this chat.");
    }
    setRevertPlan(null);
  }, [revertPlan, onRevertToMessage, reloadHistory]);

  // --- arriving on a message deep link ---------------------------------------
  // The reveal REQUEST for the message named in the URL fragment; the matching
  // row scrolls itself into view and flashes (see AnchoredTurn). Held here rather
  // than resolved in the DOM so "no such message" is answered from the turns we
  // actually rendered — which is also the honest answer for a message that lives
  // in a sub-agent's sidechain, or one a revert has since cut away.
  const [focusedMessage, setFocusedMessage] = useState<{ uuid: string; nonce: number } | null>(
    null,
  );
  // One reveal per link per chat: `turns` changes on every frame of a live turn,
  // and without this the view would be yanked back to the anchor each time.
  const revealedLinkRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusMessageUuid) return;
    // Wait for hydration to actually produce something. On the first commit
    // `hydrating` is still false (the effect that sets it runs earlier in this
    // same pass) and `turns` is empty, so testing the flag alone would report a
    // perfectly good link as missing.
    if (hydrating || turns.length === 0) return;
    const key = `${initialSessionId ?? ""}:${focusMessageUuid}`;
    if (revealedLinkRef.current === key) return;
    revealedLinkRef.current = key;
    if (turns.some((t) => t.id.split("#")[0] === focusMessageUuid)) {
      // Unpinning is load-bearing exactly as it is for a sub-agent reveal: the
      // bottom-snap layout effect would otherwise override the smooth scroll.
      pinnedRef.current = false;
      setFocusedMessage((prev) => ({
        uuid: focusMessageUuid,
        nonce: (prev?.nonce ?? 0) + 1,
      }));
    } else {
      setNotice("That link points at a message that isn't in this chat any more.");
    }
  }, [focusMessageUuid, hydrating, turns, initialSessionId]);

  // The chat's own URL, for links copied off the hover rail. Falls back to the
  // current address when the route supplies no builder, so the pill is never a
  // dead `href="#"`.
  const linkTo = useCallback(
    (uuid: string) =>
      onMessageLink?.(uuid) ??
      `${window.location.origin}${window.location.pathname}#${messageAnchorId(uuid)}`,
    [onMessageLink],
  );

  const turnActions = useMemo<TurnActionsValue | null>(
    () =>
      onForkFromMessage && onRevertToMessage
        ? {
            onFork: onForkFromMessage,
            onRevert: handleRevert,
            contextLimit: usage?.contextLimit,
            linkTo,
            focused: focusedMessage,
          }
        : null,
    [onForkFromMessage, onRevertToMessage, handleRevert, usage?.contextLimit, linkTo, focusedMessage],
  );

  // --- resolve the picker's model + reset usage on a chat switch -------------
  // Keyed on the chat identity (slug + sessionId) so switching chats restores
  // that chat's saved model (else the project default) and clears the stale
  // meter. Re-runs when `defaultModel` resolves (models load async), but only
  // adopts the default while the user hasn't already picked a model this chat.
  useEffect(() => {
    const saved = readChatModel(initialSessionId, projectSlug);
    const resolved = saved ?? defaultModel;
    if (resolved) {
      setModel(resolved);
      modelRef.current = resolved;
    }
  }, [projectSlug, initialSessionId, defaultModel]);

  // Reset the stale meter when the chat identity changes (a real switch). Skip
  // the new->established transition (where the parent mirrors the just-saved id
  // back as initialSessionId without a remount) so the meter the user just got
  // from that first turn isn't wiped.
  useEffect(() => {
    if (initialSessionId && initialSessionId === establishedHereRef.current) return;
    setUsage(null);
    setSessionUsage(null);
  }, [projectSlug, initialSessionId]);

  // Persist the unsent draft for this chat so it survives a switch/reload.
  // Writing an empty string removes the stored key, so clearing the composer
  // (setDraft("") on send) forgets the draft without any explicit clear call.
  useEffect(() => {
    writeDraft(initialSessionId, projectSlug, draft);
  }, [draft, initialSessionId, projectSlug]);

  // Self-dismiss the transient notice. Keyed on the message so a second one gets
  // its own full dwell rather than inheriting the remainder of the first's.
  useEffect(() => {
    if (notice == null) return;
    const t = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(t);
  }, [notice]);

  // Issue #197: persist the queued message so it survives a chat switch / reload
  // too — otherwise navigating away and back silently drops it. Every queue
  // mutation (enqueue / edit / clear) flows through setQueued, so keying off
  // `queued` covers them all; writing null/"" forgets the key. Its stable queue id
  // (#245) is persisted in lockstep so a reloaded pane re-asserts the same identity
  // and the server can dedup an already-sent copy.
  useEffect(() => {
    writeQueued(initialSessionId, projectSlug, queued);
    writeQueuedId(initialSessionId, projectSlug, hasQueued ? queuedIdRef.current : null);
    // The files riding the queued message persist alongside the text (#728) —
    // otherwise a reload of a chat with an attachment-only queue would show an
    // empty toolbar for a message the server is still holding.
    writeQueuedAttachments(initialSessionId, projectSlug, queuedAttachments);
  }, [queued, queuedAttachments, hasQueued, initialSessionId, projectSlug]);


  // Push the queued message to the server (#197/#245) — the server is authoritative
  // for auto-send, so this pane just keeps the server's copy in sync. Carries the
  // stable queue id so a re-assert on reload is deduped. Only once the session id
  // exists; a new chat re-asserts (same id) when its id resolves and
  // initialSessionId updates.
  useEffect(() => {
    if (!initialSessionId) return; // new chat, no session yet
    chatClient.setQueued(
      projectSlug,
      initialSessionId,
      queued,
      hasQueued ? queuedIdRef.current : null,
      // The staged files go up with the text (#728). The server UNIONS them into
      // the shared slot, so this pane re-asserting a queue whose files it has
      // already handed over (its tray is empty by then) adds nothing and removes
      // nothing — only an explicit clear empties the slot.
      queuedAttachments,
    );
  }, [queued, queuedAttachments, hasQueued, initialSessionId, projectSlug, chatClient]);

  // Auto-focus the composer on mount for a fresh chat so the user can type right
  // away: right after forking (autoFocus), and when starting a New Chat — which
  // remounts this pane with no initialSessionId. A normal open of an existing
  // chat (initialSessionId present, not forked) leaves focus alone.
  useEffect(() => {
    if (autoFocus || !initialSessionId) composerRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Render the server's auto-sent queued message as the user bubble, then clear
  // this pane's queued state (#245). Fires on chat:queued_flushed: `text` present
  // means the server drained+sent it (the drained turn streams the reply right
  // after), so we append the user turn to keep the transcript in order; either way
  // the queue toolbar + local/persisted copy are cleared (the socket layer already
  // cleared localStorage). The server owns the send — we only reflect it.
  const onQueuedFlushed = useCallback((text?: string, attachments?: AttachmentRef[]) => {
    const atts = attachments ?? [];
    // An attachment-only queued message has no text but is still a real turn
    // (#328/#728), so the bubble renders on EITHER.
    if (text || atts.length > 0) {
      pinnedRef.current = true;
      setTurns((prev) => [
        ...sealStreaming(prev),
        {
          kind: "user",
          id: nextId(),
          content: text ?? "",
          ...(atts.length > 0 ? { attachments: atts } : {}),
        },
      ]);
    }
    queuedRef.current = null;
    queuedIdRef.current = null;
    setQueued(null);
    setQueuedAttachments([]);
  }, []);

  // The chat's queued message changed on the SERVER (#629) — another client (or
  // another tab) queued, edited or cleared it. The slot is shared chat state, so
  // render exactly what the server says is in it and adopt its id, which makes our
  // next edit update that slot in place instead of appending a second part beside
  // it. Ignored when it matches what we already show, so the echo of our own
  // set_queue settles in one round trip instead of looping.
  const onQueuedState = useCallback(
    (text: string | null, qid?: string, reason?: "returned", attachments?: AttachmentRef[]) => {
      if (qid) queuedIdRef.current = qid;
      const next = text && text.length > 0 ? text : null;
      const atts = attachments ?? [];
      // Someone else pressed Stop and took the queued message back to their own
      // composer. Say so: a chip disappearing from under you with no explanation
      // is the same silence that made a second client's overwrite so confusing
      // (#629). The client that pressed Stop is not sent this — it watches the
      // text land in its own composer.
      if (reason === "returned" && (queuedRef.current != null || queuedAttachRef.current.length)) {
        setNotice("Stopped — the queued message went back to the composer that stopped the turn.");
      }
      // The slot's files are shared state too (#728), so a broadcast that only
      // repeats our text can still be carrying a file another device staged.
      const sameAtts =
        atts.length === queuedAttachRef.current.length &&
        atts.every((a, i) => a.id === queuedAttachRef.current[i]?.id);
      if (queuedRef.current === next && sameAtts) return;
      queuedRef.current = next;
      if (next === null && atts.length === 0) queuedIdRef.current = null;
      setQueued(next);
      if (!sameAtts) setQueuedAttachments(atts);
    },
    [],
  );
  const onQueuedStateRef = useRef(onQueuedState);
  onQueuedStateRef.current = onQueuedState;

  const popQueuedToComposer = useCallback(
    (text: string, attachments?: AttachmentRef[]) => {
    queuedRef.current = null;
    queuedIdRef.current = null;
    setQueued(null);
    // The files come back to the composer TRAY, not the draft (#728): the message
    // is being handed back whole, and putting the prose back while dropping its
    // attachments would be the same silent loss in a nicer costume. Merged by id
    // so a file already staged for the next message isn't duplicated.
    const back = attachments ?? queuedAttachRef.current;
    if (back.length > 0) {
      setAttachments((prev) => {
        const seen = new Set(prev.map((a) => a.id));
        return [...prev, ...back.filter((a) => !seen.has(a.id))];
      });
    }
    setQueuedAttachments([]);
    setDraft((prev) => (prev.trim() ? `${text}\n${prev}` : text));
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (el) {
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
        el.focus();
      }
    });
    },
    [setAttachments],
  );

  // The user pressed Stop, so the server handed this chat's queued message back
  // to US rather than sending it — Stop means "give me control back", and having
  // the agent immediately start on the follow-up is the opposite of that. It
  // lands in the composer by exactly the path the queue bar's Edit button uses,
  // so it merges with any draft already typed and persists through the same
  // writeDraft effect. The server has already cleared its copy of the slot.
  const onQueuedReturned = useCallback(
    (text: string, attachments?: AttachmentRef[]) => popQueuedToComposer(text, attachments),
    [popQueuedToComposer],
  );
  const onQueuedReturnedRef = useRef(onQueuedReturned);
  onQueuedReturnedRef.current = onQueuedReturned;
  // Stable ref so the (stably-subscribed) socket handlers call the latest version.
  const onQueuedFlushedRef = useRef(onQueuedFlushed);
  onQueuedFlushedRef.current = onQueuedFlushed;

  // --- subscribe to the shared socket for this chat -------------------------
  // The ~12 frame handlers live in useChatSocket (issue #403). The refs stay
  // owned here (send/cancel touch them too) and are threaded through; the hook's
  // effect is the old inline one verbatim, with the same dependency array.
  useChatSocket({
    projectSlug,
    initialSessionId,
    loadHistory,
    onSessionEstablished,
    onSessionStarted,
    onTurnComplete,
    sessionRef,
    jobRef,
    pendingCancelRef,
    streamingRef,
    awaitingSessionRef,
    isNewSessionRef,
    startedNotifiedRef,
    establishedHereRef,
    modelRef,
    cancelledRef,
    noticeThisTurnRef,
    seenInjectionsRef,
    onQueuedFlushedRef,
    onQueuedStateRef,
    onQueuedReturnedRef,
    setTurns,
    setStreaming,
    setUsage,
    setSessionUsage,
    setError,
  });

  // --- send / cancel ---------------------------------------------------------
  // The core send path, shared by a live composer submit and by the queue flush
  // (issue #91). `text` is already trimmed/non-empty and we are NOT streaming.
  const sendText = useCallback(
    (text: string) => {
      setError(null);
      pinnedRef.current = true;
      // Consume any composer attachments (#328): they ride WITH this turn and the
      // tray clears. Only for a plain (non-slash-command) send.
      const atts = text.startsWith("/") ? [] : attachRef.current;
      setTurns((prev) => [
        ...sealStreaming(prev),
        {
          kind: "user",
          id: nextId(),
          content: text,
          ...(atts.length > 0 ? { attachments: atts } : {}),
        },
      ]);
      if (atts.length > 0) {
        setAttachments([]);
        attachRef.current = [];
      }
      // Clearing the value doesn't undo the inline height the autosize handler
      // grew the textarea to, so a multi-line message would leave the composer
      // tall until the next keystroke. Reset it back to one row here.
      if (composerRef.current) composerRef.current.style.height = "auto";
      setStreaming(true);
      streamingRef.current = true;
      // A fresh turn: clear the per-turn notice guard (#329) so this turn's own
      // failed-completion backstop toast isn't suppressed by a prior turn's notice.
      noticeThisTurnRef.current = false;
      // Each turn starts with an unknown jobId. Null it (and any stale deferred
      // cancel) so a Stop in the pre-arm window is detected as "no job yet" and
      // takes the deferred-cancel path — rather than firing chat:cancel against
      // the PREVIOUS turn's already-finished jobId, which the server no-ops,
      // leaving the new turn running (#196).
      jobRef.current = null;
      pendingCancelRef.current = false;
      // A brand-new chat won't know its session id until the first frame arrives;
      // flag that we're awaiting it so those frames are accepted as ours.
      if (sessionRef.current === null) awaitingSessionRef.current = true;

      // A leading-slash draft is a slash command (e.g. "/compact"): route it to
      // the streaming-session path so the CLI dispatches it, rather than sending
      // it as a plain prompt. Commands carry no preload/model — they act on the
      // current session as-is.
      if (text.startsWith("/")) {
        firstTurnSentRef.current = true;
        chatClient.sendCommand(projectSlug, text, sessionRef.current);
        return;
      }

      // Preload only applies to the very first turn of a never-resumed chat.
      const isFirstTurnOfNewChat = isNewSessionRef.current && !firstTurnSentRef.current;
      const preload = isFirstTurnOfNewChat && preloadContext;
      firstTurnSentRef.current = true;
      chatClient.send(projectSlug, text, sessionRef.current, {
        preloadContext: preload,
        // Send the selected model so the server runs this turn on it. Omitted when
        // unresolved (models not yet loaded) → the server uses the project default.
        model: modelRef.current ?? undefined,
        // Composer attachments (#328): refs to already-uploaded files; the server
        // prepends the Read-tool hint block. Empty ⇒ omitted on the wire.
        attachments: atts.map((a) => ({ id: a.id, filename: a.filename, kind: a.kind })),
      });
    },
    [projectSlug, preloadContext],
  );

  const send = useCallback(() => {
    const text = draft.trim();
    // A send needs SOMETHING: text, or at least one attachment
    // (#328 — an image-only message is valid, ChatGPT-style).
    if (!text && attachRef.current.length === 0) return;
    // While a turn is in flight we can't send in parallel — queue the message
    // instead of no-opping (issue #91). Append to any already-queued message so
    // the slot stays single (Claude Code's model). The composer clears either
    // way, and the queued toolbar surfaces it above the composer.
    if (streaming) {
      // Enqueueing CONSUMES the composer attachments, exactly as sending does
      // (#728). This path used to return without touching `attachRef` at all, and
      // because the queue is flushed server-side, `sendText` — the only consumer
      // of the tray — never ran for a queued message. The tray stayed populated
      // and the file silently rode the next, unrelated send.
      //
      // A leading-slash queue is the one exception, mirroring `sendText`: the CLI
      // dispatches a slash command and it carries no files, so they stay staged
      // for the real message the user is about to type rather than being thrown
      // away (#346 — silently dropping staged attachments is its own bug).
      const isCommand = (queuedRef.current ?? text).startsWith("/");
      const atts = isCommand ? [] : attachRef.current;
      if (atts.length > 0) {
        setQueuedAttachments((prev) => {
          const seen = new Set(prev.map((a) => a.id));
          return [...prev, ...atts.filter((a) => !seen.has(a.id))];
        });
        setAttachments([]);
        attachRef.current = [];
      }
      setQueued((prev) => {
        // An attachment-only submit leaves the text alone: `""` is not a message,
        // and joining it would put a stray blank line into the queued prose.
        const next = text ? (prev ? `${prev}\n${text}` : text) : prev;
        queuedRef.current = next;
        // Mint a stable id for a fresh queue; keep it when appending to an existing
        // one (same pending message) so its identity is stable (#245).
        if (prev == null || queuedIdRef.current == null) queuedIdRef.current = newQueuedId();
        return next;
      });
      setDraft("");
      if (composerRef.current) composerRef.current.style.height = "auto";
      return;
    }
    setDraft("");
    sendText(text);
  }, [draft, streaming, sendText, attachRef, setAttachments]);



  // Pop the queued message back into the composer for editing. This CANCELS the
  // pending auto-send (queuedRef → null): the server clears its copy via the
  // setQueued(null) effect — it's a draft again until re-submitted (#91).
  const editQueued = useCallback(() => {
    const text = queuedRef.current;
    // An attachment-only queue has no text but is still editable: Edit hands the
    // files back to the tray (#728).
    if (text == null && queuedAttachRef.current.length === 0) return;
    popQueuedToComposer(text ?? "");
  }, [popQueuedToComposer]);

  // Discard the queued message entirely (the setQueued(null) effect clears the
  // server + persisted copies too).
  const clearQueued = useCallback(() => {
    queuedRef.current = null;
    queuedIdRef.current = null;
    setQueued(null);
    // Clear discards the whole message, files included — deliberate, on something
    // the user can see (the bar lists the chips).
    setQueuedAttachments([]);
  }, []);

  const cancel = useCallback(() => {
    // jobId is captured off event metadata in the handlers below. The server
    // emits chat:complete/error on cancel; the UI unlocks there. Mark the turn
    // as cancelled so its completion does NOT flush the queue (#91: hold rather
    // than fire a follow-up into a stopped turn).
    cancelledRef.current = true;
    if (jobRef.current) {
      chatClient.cancel(jobRef.current);
    } else {
      // Pre-arm window (#196): the turn is streaming (Stop is showing) but the
      // server hasn't round-tripped the jobId yet, so there's nothing to cancel
      // *yet*. Defer it — armJob() fires the cancel the moment the jobId arrives,
      // so Stop isn't a silent no-op during the (sometimes multi-second) window
      // before the first frame / chat:active carries the id.
      pendingCancelRef.current = true;
    }
  }, []);

  // Manual keeper recovery (issue #301, Layer 2). Re-drive a hung keeper whose
  // background task was killed at the turn boundary by injecting a recovery nudge
  // into its still-alive session (server `chat:continue`). Only meaningful for a
  // project chat with a known session id and no turn already running.
  const continueChat = useCallback(() => {
    const sid = sessionRef.current;
    if (!sid) return;
    if (streamingRef.current) return;
    setStreaming(true);
    chatClient.continueChat(projectSlug, sid);
  }, [projectSlug]);

  // Resolve the effective Layer 2 flag: the per-project override wins field-wise,
  // else the instance default, else the built-in ON (issue #301). Memoised so the
  // context value is stable across renders that don't change the inputs.
  const recoveryCtx = useMemo<RecoveryContextValue | null>(() => {
    const enabled =
      projectRecovery?.surfaceKilledTask ?? recoveryDefault?.surfaceKilledTask ?? true;
    return { enabled, busy: streaming, onContinue: continueChat };
  }, [projectSlug, projectRecovery, recoveryDefault, streaming, continueChat]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // While the slash-command menu is open it owns Arrow/Tab/Enter/Escape, ahead
    // of the send logic below (issue #103).
    if (menuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenuIndex((i) => (i + 1) % menuCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenuIndex((i) => (i - 1 + menuCommands.length) % menuCommands.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        acceptCommand(menuCommands[menuIndex]);
        return;
      }
      // Enter COMPLETES a partial selection, but once the highlighted command is
      // already fully typed it falls through to send — so `/compact`+Enter sends
      // (incl. queueing mid-stream) rather than re-inserting, matching the CLI.
      if (e.key === "Enter") {
        const hit = menuCommands[menuIndex];
        if (hit && hit.name !== slashQuery) {
          e.preventDefault();
          acceptCommand(hit);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // Append dictated text to the current draft (space-joined), then refocus and
  // resize the textarea to fit — same autosize the onChange handler applies.
  const insertDictation = useCallback((text: string) => {
    setDraft((prev) => (prev.trim() ? `${prev.trimEnd()} ${text}` : text));
    const el = composerRef.current;
    if (el) {
      requestAnimationFrame(() => {
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
        el.focus();
      });
    }
  }, []);

  const empty = turns.length === 0 && !hydrating;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* transcript */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto overscroll-contain"
      >
        <div className="mx-auto w-full max-w-3xl px-4 py-6">
          {/* Read-only capability banner atop a TRIGGER chat (Epic T / T4): a
              truthful-from-config statement of what this agent is + may do. */}
          {trigger && (
            <TriggerCapabilityBanner trigger={trigger} projectSlug={projectSlug} />
          )}

          {hydrating && (
            <div className="space-y-3">
              <div className="h-4 w-2/3 animate-pulse rounded bg-surface-active" />
              <div className="h-4 w-1/2 animate-pulse rounded bg-surface-active" />
            </div>
          )}

          {empty && (
            <div className="mt-16 flex flex-col items-center text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                <SparkIcon width={22} height={22} />
              </div>
              <p className="max-w-sm text-sm text-fg-subtle">
                {emptyHint ??
                  "Start the conversation. Messages stream live from Claude and persist as a resumable session."}
              </p>
            </div>
          )}

          <SubagentFetchContext.Provider value={fetchSubagent}>
            <SubagentLiveContext.Provider value={streaming}>
              <SubagentActivityContext.Provider value={subagentActivity}>
                <SubagentFocusContext.Provider value={subagentFocus}>
              <ToolImageUrlContext.Provider value={toolImageUrl}>
                <PaddockManageProjectContext.Provider value={projectSlug}>
                  <RecoveryContext.Provider value={recoveryCtx}>
                    <TurnActionsContext.Provider value={turnActions}>
                      <div className="space-y-4">
                        {turns.map((t) => (
                          <TurnRow key={t.id} turn={t} />
                        ))}
                      </div>
                    </TurnActionsContext.Provider>
                  </RecoveryContext.Provider>
                </PaddockManageProjectContext.Provider>
              </ToolImageUrlContext.Provider>
                </SubagentFocusContext.Provider>
              </SubagentActivityContext.Provider>
            </SubagentLiveContext.Provider>
          </SubagentFetchContext.Provider>
        </div>
      </div>

      {/* Persistent "agent is working…" indicator while a turn is in flight
          (#53) — independent of whether a bubble is currently painting, so it
          shows during the initial thinking gap and between tool calls, and lights
          up the instant you return to a still-streaming chat. */}
      {streaming && <WorkingIndicator />}

      {/* One live line per RUNNING piece of background work — sub-agents, and
          (#604) background shells, monitors and workflows — so long work is
          visible without hunting for (and expanding) its card. Tapping a row
          reveals the card. Renders nothing when nothing is running. */}
      <RunningWork
        running={runningSubagents}
        activity={subagentActivity}
        tasks={backgroundTasks}
        commands={shellCommands}
        onReveal={subagentFocus.focus}
        // #848: no session id means there is nothing to address a stop to, and
        // withholding the handler is what removes every stop affordance —
        // preferable to a button that silently does nothing.
        onCancel={initialSessionId ? stopBackgroundTask : undefined}
        stopping={stoppingTasks}
        stopFailed={stopFailedTasks}
      />

      {error && (
        <div className="mx-auto mb-2 flex w-full max-w-3xl items-start gap-2 px-4">
          <div className="flex w-full items-start gap-2 rounded-lg border border-danger-edge bg-danger-soft px-3 py-2 text-sm text-danger">
            <AlertIcon width={16} height={16} className="mt-0.5 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        </div>
      )}

      {notice && (
        <div className="mx-auto mb-2 flex w-full max-w-3xl items-start gap-2 px-4">
          <div className="flex w-full items-start gap-2 rounded-lg border border-edge bg-surface-hover px-3 py-2 text-sm text-fg-muted">
            <ClockIcon width={16} height={16} className="mt-0.5 shrink-0" />
            <span className="break-words">{notice}</span>
          </div>
        </div>
      )}

      {/* Queued-message toolbar (#91): the single message stacked to auto-send
          when the current turn frees up. Sits directly above the composer. */}
      {hasQueued && (
        <QueuedMessageBar
          text={queued ?? ""}
          attachments={queuedAttachments}
          onEdit={editQueued}
          onClear={clearQueued}
        />
      )}

      {/* composer */}
      <div className="border-t border-edge bg-surface/80 backdrop-blur">
        <div className="pb-safe mx-auto w-full max-w-3xl px-4 pt-3">
          {showPreload && (
            <PreloadToggle
              checked={preloadContext}
              available={preloadAvailable}
              onChange={setPreloadContext}
            />
          )}
          <StatusRow
            models={pickerModels}
            model={model}
            onSelectModel={selectModel}
            usage={usage}
            sessionUsage={sessionUsage}
            forkParent={forkParent}
            onOpenForkParent={onOpenForkParent}
          />
          {/* Attachment tray (#328): thumbnails/chips of files staged for the
              next message, each removable before send. Shows an uploading hint. */}
          {attachEnabled && (attachments.length > 0 || uploading) && (
            <div className="mb-2 flex flex-wrap gap-2" data-testid="attachment-tray">
              {attachments.map((a) => (
                <AttachmentTrayItem key={a.id} attachment={a} onRemove={removeAttachment} />
              ))}
              {uploading && (
                <span className="flex items-center gap-1.5 rounded-xl bg-surface-sunken px-3 py-2 text-xs text-fg-muted ring-1 ring-edge">
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-edge-strong border-t-accent" />
                  Uploading…
                </span>
              )}
            </div>
          )}
          <div
            className={`relative flex items-end gap-2 rounded-2xl border bg-surface-raised p-2 shadow-sm focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20 ${
              dragOver ? "border-accent ring-2 ring-accent/30" : "border-edge-strong"
            }`}
            onDragOver={attachEnabled ? onComposerDragOver : undefined}
            onDragLeave={attachEnabled ? onComposerDragLeave : undefined}
            onDrop={attachEnabled ? onComposerDrop : undefined}
          >
            {/* Drop-zone overlay while dragging files over the composer (#328). */}
            {dragOver && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-accent-soft text-sm font-medium text-accent">
                Drop files to attach
              </div>
            )}
            {/* Slash-command autocomplete (issue #103). Pops above the composer
                when the draft is a bare leading-slash command; keyboard nav lives
                in onKeyDown, mouse selection in onMouseDown (preventDefault keeps
                the textarea focused so the click still registers). */}
            {menuOpen && (
              <div
                className="menu bottom-full left-0 mb-2 max-h-64 w-full overflow-y-auto"
                role="menu"
                aria-label="Slash commands"
              >
                {menuCommands.map((cmd, i) => (
                  <button
                    type="button"
                    key={cmd.name}
                    role="menuitem"
                    className={`menu-item ${i === menuIndex ? "bg-surface-selected" : ""}`}
                    onMouseEnter={() => setMenuIndex(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      acceptCommand(cmd);
                    }}
                  >
                    <span className="flex w-full items-baseline gap-2">
                      <span className="font-mono font-medium text-accent">/{cmd.name}</span>
                      {cmd.argumentHint && (
                        <span className="shrink-0 text-fg-subtle">{cmd.argumentHint}</span>
                      )}
                      {cmd.description && (
                        <span className="ml-auto truncate text-fg-muted">{cmd.description}</span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={composerRef}
              className="max-h-48 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none"
              rows={1}
              autoCapitalize="sentences"
              value={draft}
              placeholder={
                streaming
                  ? "Queue a message to send next…"
                  : (placeholder ?? "Message Claude…")
              }
              onChange={(e) => {
                setDraft(e.target.value);
                const el = e.target;
                el.style.height = "auto";
                el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
              }}
              onKeyDown={onKeyDown}
              onPaste={attachEnabled ? onComposerPaste : undefined}
            />
            {/* File picker (#328): hidden input + paperclip trigger. Project chats
                only, and only when attachments are enabled. `multiple` + an accept
                hint derived from the effective allowedTypes (a UX hint only — the
                server is authoritative). */}
            {attachEnabled && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={acceptAttribute(attachConfig.allowedTypes) || undefined}
                  className="hidden"
                  data-testid="attachment-input"
                  onChange={onPickFiles}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  title="Attach files"
                  aria-label="Attach files"
                  data-testid="attachment-button"
                  className="btn bg-transparent text-fg-muted hover:bg-surface-hover hover:text-fg"
                >
                  <PaperclipIcon width={16} height={16} />
                </button>
              </>
            )}
            {/* Voice dictation (#voice): renders nothing unless the instance has
                a whisper backend configured. Interactive regardless of turn state
                — dictated text lands in the draft and follows the same queue path
                as typing during a live turn (issue #365). */}
            <DictationButton onText={insertDictation} />
            {streaming ? (
              <button
                type="button"
                onClick={cancel}
                title="Stop generating"
                aria-label="Stop"
                className="btn bg-surface-active text-fg-muted hover:bg-surface-selected"
              >
                <StopIcon width={15} height={15} />
                {/* Label hidden on mobile (icon-only) to give the textarea room
                    so its placeholder fits one line at the 16px anti-zoom size (#372).
                    aria-label keeps a stable accessible name for the icon-only state. */}
                <span className="hidden sm:inline">Stop</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={send}
                disabled={(!draft.trim() && attachments.length === 0) || uploading}
                className="btn-primary"
                title="Send (Enter)"
                aria-label="Send"
              >
                <SendIcon width={15} height={15} />
                <span className="hidden sm:inline">Send</span>
              </button>
            )}
          </div>
          <div className="mt-1.5 flex items-center justify-between px-1 text-2xs text-fg-subtle">
            <span>
              <kbd className="font-sans">Enter</kbd> to {streaming ? "queue" : "send"} ·{" "}
              <kbd className="font-sans">Shift+Enter</kbd> for newline
            </span>
            <ConnDot state={conn} />
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={revertPlan !== null}
        wide
        // Long warning text + a big box makes the backdrop an easy mis-click,
        // and dropping the decision silently is worse than asking for a button.
        dismissOnBackdrop={false}
        title="Revert this chat back to here?"
        confirmLabel="Revert chat"
        message={
          revertPlan && (
            <>
              {revertPlan.anchorIsUser && (
                <p className="mb-2">This rewinds to the assistant&apos;s previous reply.</p>
              )}
              <p>
                <span className="font-medium text-fg">
                  {revertPlan.count} message{revertPlan.count === 1 ? "" : "s"}
                </span>{" "}
                will be removed
                {revertPlan.toolCount > 0 ? (
                  <>
                    , including{" "}
                    <span className="font-medium text-fg">
                      {revertPlan.toolCount} tool call
                      {revertPlan.toolCount === 1 ? "" : "s"}
                    </span>
                    .
                  </>
                ) : (
                  "."
                )}
              </p>
              {revertPlan.toolCount > 0 && (
                <p className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-warn">
                  <span className="font-medium">Those actions are not undone.</span> Files written,
                  PRs opened and messages sent stay as they are — only the conversation is rewound.
                </p>
              )}
              <p className="mt-3">
                The removed messages are backed up, and this chat keeps its id.
              </p>
            </>
          )
        }
        onConfirm={confirmRevert}
        onClose={() => setRevertPlan(null)}
      />
    </div>
  );
}

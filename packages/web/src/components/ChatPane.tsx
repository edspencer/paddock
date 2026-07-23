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
import { readQueued, writeQueued, readQueuedTs, writeQueuedTs } from "../lib/queued";
import { readAttachmentRefs, writeAttachmentRefs } from "../lib/attachmentRefs";
import { AlertIcon, PaperclipIcon, SendIcon, SparkIcon, StopIcon } from "./icons";
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
} from "../lib/types";
import {
  isTypeAllowed as isAttachmentTypeAllowed,
  acceptAttribute,
} from "../lib/attachments";
import { AttachmentTrayItem } from "./MessageAttachments";
import { SCRATCH_SLUG } from "../lib/types";
import { TriggerCapabilityBanner } from "./TriggerCapabilityBanner";
import { PaddockManageProjectContext } from "./PaddockManageBlock";
// --- extracted chat modules (issue #403) -------------------------------------
import { sentFileFromToolCall } from "./chat/toolFormatting";
import {
  type Turn,
  appendAssistantText,
  historyToTurns,
  nextId,
  sealStreaming,
  settlePending,
} from "./chat/turnModel";
import {
  RecoveryContext,
  type RecoveryContextValue,
  SubagentFetchContext,
  ToolImageUrlContext,
} from "./chat/chatContexts";
import {
  ConnDot,
  PreloadToggle,
  QueuedMessageBar,
  StatusRow,
  WorkingIndicator,
} from "./chat/ComposerBits";
import { TurnView } from "./chat/Transcript";

// `historyToTurns` was previously defined here; it now lives in ./chat/turnModel.
// Re-export it so existing importers (e.g. ChatPane.turns.test.ts) resolve unchanged.
export { historyToTurns };

export interface ChatPaneProps {
  /** Project slug, or "scratch" for one-off chats. */
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
  /** True for a project chat (vs. a one-off scratch chat). Gates the preload checkbox. */
  isProjectChat?: boolean;
  /** Whether the project has an OVERVIEW.md to preload (issue #1). */
  preloadAvailable?: boolean;
  /**
   * The project's configured keeper model — the default model for this chat's
   * picker (CONTRACT-v3 §8). Undefined for scratch chats, where the default
   * falls back to the models response's `keeperDefault`.
   */
  projectModel?: string;
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
   * shown. Undefined for scratch chats / when the project sets no override.
   */
  projectRecovery?: RecoveryOverride;
  /**
   * The project's per-project inbound-attachment override (issue #328), from the
   * Project DTO. Combined with the instance default (GET /api/models
   * `attachmentsDefault`) to resolve the composer's effective attachment config
   * (enabled + size/count/type caps). Undefined for scratch / when unset.
   */
  projectAttachments?: AttachmentsOverride;
}

export function ChatPane({
  projectSlug,
  initialSessionId,
  loadHistory,
  onSessionEstablished,
  onSessionStarted,
  onTurnComplete,
  isProjectChat = false,
  preloadAvailable = false,
  projectModel,
  forkParent,
  onOpenForkParent,
  autoFocus,
  emptyHint,
  placeholder,
  trigger,
  projectRecovery,
  projectAttachments,
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
  const [conn, setConn] = useState<ConnectionState>(chatClient.state);

  // Issue #91: a single message queued to auto-send when the current turn
  // finishes. `queued` drives the toolbar above the composer; `queuedRef` mirrors
  // it for the (stably-subscribed) socket handlers, which can't see the latest
  // `queued` state. `null` = nothing queued.
  // Issue #197: hydrate any message persisted for this chat so it survives a chat
  // switch / reload instead of being silently dropped (mirrors the composer draft
  // above; see lib/queued.ts).
  // Issue #245: the SERVER now owns auto-send — this pane persists the queue to the
  // server and renders/clears it when the server says it flushed (onQueuedFlushed);
  // it no longer sends the queued message itself. `queuedTsRef` is the message's
  // stable enqueue timestamp, persisted alongside the text so the server can dedup
  // a stale copy this pane re-asserts on reload from one it already sent.
  const [queued, setQueued] = useState<string | null>(() =>
    readQueued(initialSessionId, projectSlug),
  );
  const queuedRef = useRef<string | null>(queued);
  const queuedTsRef = useRef<number | null>(readQueuedTs(initialSessionId, projectSlug));
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
  const showPreload = isProjectChat && !initialSessionId;
  // The checkbox only has an effect once a turn has been sent on a brand-new chat.
  const firstTurnSentRef = useRef(false);

  // --- model picker + context meter (CONTRACT-v3 §8) -------------------------
  // The selectable models + defaults (fetched once, app-wide static). The
  // picker's default is the project's model (project chats) or `keeperDefault`
  // (scratch); a per-chat localStorage override takes precedence when present.
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [keeperDefault, setKeeperDefault] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  // Instance-default recovery config (issue #301), fetched once with the models.
  // Combined with the per-project `projectRecovery` override to gate the killed-
  // task Continue affordance. Null until fetched (defaults apply until then).
  const [recoveryDefault, setRecoveryDefault] = useState<RecoveryConfig | null>(null);
  // Instance-default inbound-attachment config (issue #328), fetched with models.
  // Combined with the per-project `projectAttachments` override to resolve the
  // composer's effective config. Null until fetched (allow-all defaults apply).
  const [attachmentsDefault, setAttachmentsDefault] = useState<AttachmentsConfig | null>(null);

  // --- composer attachments (issue #328) -------------------------------------
  // Files the user has picked/dropped/pasted and uploaded to the store, held
  // until send. `attachRef` mirrors it for the send callback (like `queuedRef`).
  // Issue #346: seed from any staged refs persisted for this chat so they survive
  // a chat switch / reload instead of being silently dropped (mirrors the composer
  // draft above; the bytes live durably server-side, so only the refs need saving —
  // see lib/attachmentRefs.ts).
  const [attachments, setAttachments] = useState<AttachmentRef[]>(() =>
    readAttachmentRefs(initialSessionId, projectSlug),
  );
  const attachRef = useRef<AttachmentRef[]>([]);
  attachRef.current = attachments;
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

  // The chat's default model: project model for project chats, else keeperDefault.
  const defaultModel = (isProjectChat ? projectModel : keeperDefault) ?? keeperDefault;

  // Session id is kept in a ref (the WS sub needs the latest without re-subscribing).
  const sessionRef = useRef<string | null>(initialSessionId ?? null);
  const jobRef = useRef<string | null>(null);
  // Set true when the user hits Stop during the "pre-arm" window — the turn is
  // already streaming (Stop is showing) but the server hasn't round-tripped the
  // jobId yet, so there's nothing to cancel. `armJob` fires this deferred cancel
  // the instant the jobId arrives, so Stop isn't a silent no-op there (#196).
  const pendingCancelRef = useRef(false);

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
  // Raw-file URL builder for inline image reads (issue #239). Only for real
  // project chats — scratch has no servable project-file endpoint.
  const toolImageUrl = useMemo(
    () =>
      projectSlug && projectSlug !== SCRATCH_SLUG
        ? (relPath: string) => api.projectFileRawUrl(projectSlug, relPath)
        : null,
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
        setKeeperDefault(res.keeperDefault);
        if (res.recoveryDefault) setRecoveryDefault(res.recoveryDefault);
        if (res.attachmentsDefault) setAttachmentsDefault(res.attachmentsDefault);
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
    // Project chats query their keeper; one-off chats query the scratch agent.
    void (isProjectChat ? api.projectCommands(projectSlug) : api.scratchCommands())
      .then((cmds) => {
        if (!cancelled) setCommands(cmds);
      })
      .catch(() => {
        /* no menu if the list can't be fetched; sending is unaffected */
      });
    return () => {
      cancelled = true;
    };
  }, [projectSlug, isProjectChat]);

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
          setTurns(historyToTurns(msgs));
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

  // Issue #197: persist the queued message so it survives a chat switch / reload
  // too — otherwise navigating away and back silently drops it. Every queue
  // mutation (enqueue / edit / clear) flows through setQueued, so keying off
  // `queued` covers them all; writing null/"" forgets the key. Its stable enqueue
  // timestamp (#245) is persisted in lockstep so a reloaded pane re-asserts the
  // same identity and the server can dedup an already-sent copy.
  useEffect(() => {
    writeQueued(initialSessionId, projectSlug, queued);
    writeQueuedTs(initialSessionId, projectSlug, queued ? queuedTsRef.current : null);
  }, [queued, initialSessionId, projectSlug]);

  // Issue #346: persist the staged composer attachments so they survive a chat
  // switch / reload too — otherwise navigating away and back silently drops them
  // while the draft text right next to them is restored. Every tray mutation
  // (add / remove / clear-on-send) flows through setAttachments, so keying off
  // `attachments` covers them all; writing an empty list forgets the key. Only the
  // lightweight refs are stored (the bytes are durable server-side).
  useEffect(() => {
    writeAttachmentRefs(initialSessionId, projectSlug, attachments);
  }, [attachments, initialSessionId, projectSlug]);

  // Push the queued message to the server (#197/#245) — the server is authoritative
  // for auto-send, so this pane just keeps the server's copy in sync. Carries the
  // stable ts so a re-assert on reload is deduped. Only once the session id exists;
  // a new chat re-asserts (same ts) when its id resolves and initialSessionId updates.
  useEffect(() => {
    if (!initialSessionId) return; // new chat, no session yet
    chatClient.setQueued(projectSlug, initialSessionId, queued, queued ? queuedTsRef.current : null);
  }, [queued, initialSessionId, projectSlug, chatClient]);

  // Auto-focus the composer on mount for a fresh chat so the user can type right
  // away: right after forking (autoFocus), and when starting a New Chat — which
  // remounts this pane with no initialSessionId. A normal open of an existing
  // chat (initialSessionId present, not forked) leaves focus alone.
  useEffect(() => {
    if (autoFocus || !initialSessionId) composerRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- subscribe to the shared socket for this chat -------------------------
  useEffect(() => {
    // Guard against frames that belong to a different chat. Only one ChatPane is
    // mounted per project, so a still-streaming chat's stragglers can be routed
    // here after the user switches away (issue #35). Adopt only frames for our
    // own session — or, for a brand-new chat, the first frames of the turn we
    // just sent (identified by the awaiting/streaming flags).
    const framesBelong = (meta: { sessionId: string | null; jobId: string | null }) => {
      const mine = sessionRef.current;
      if (mine) {
        if (meta.sessionId === mine) return true;
        // A session-less frame during our own in-flight turn (server hasn't
        // stamped the id yet) is ours; one while idle is a straggler.
        return meta.sessionId == null && streamingRef.current;
      }
      // Nascent chat: accept frames only once we've sent and are awaiting our
      // own session id. Otherwise (a fresh chat the user is just looking at)
      // reject everything so another chat's stream can't bleed in.
      return awaitingSessionRef.current;
    };
    const adoptSession = (id: string) => {
      sessionRef.current = id;
      awaitingSessionRef.current = false;
      sub.setSessionId(id);
      // Tell the parent as soon as a brand-new chat learns its id (mid-stream)
      // so it can show a pending list entry right away — not at turn end.
      if (isNewSessionRef.current && !startedNotifiedRef.current) {
        startedNotifiedRef.current = true;
        // The parent mirrors this id into the URL mid-stream. Treat that like
        // the new->established transition so it does NOT re-hydrate the live
        // transcript or reset the model picker to the default when
        // initialSessionId flips: mark it established here and persist the
        // picked model onto the now-known session-id key (mirrors onComplete).
        establishedHereRef.current = id;
        if (modelRef.current) writeChatModel(id, projectSlug, modelRef.current);
        onSessionStarted?.(id);
      }
    };
    // Record the turn's now-known jobId. If the user already hit Stop during the
    // pre-arm window (`pendingCancelRef`), fire the deferred cancel right now —
    // otherwise that earlier click would have been a silent no-op (#196).
    const armJob = (id: string) => {
      jobRef.current = id;
      if (pendingCancelRef.current) {
        pendingCancelRef.current = false;
        chatClient.cancel(id);
      }
    };
    const sub = chatClient.subscribe(projectSlug, sessionRef.current, {
      onResponse: (chunk, meta) => {
        if (!framesBelong(meta)) return;
        if (meta.jobId) armJob(meta.jobId);
        if (meta.sessionId) adoptSession(meta.sessionId);
        appendAssistantText(setTurns, chunk);
      },
      onToolStart: (tc, meta) => {
        if (!framesBelong(meta)) return;
        if (meta.jobId) armJob(meta.jobId);
        if (meta.sessionId) adoptSession(meta.sessionId);
        // A slow tool (esp. a subagent) starts: show a pending "running…" row
        // right away instead of nothing until it finishes (#175). Reconciled by
        // toolUseId when its chat:tool_call completion arrives.
        setTurns((prev) => {
          // A replayed start frame (reconnect gap replay) must not double-add.
          if (
            tc.toolUseId &&
            prev.some((t) => t.kind === "tool" && t.tool.toolUseId === tc.toolUseId)
          ) {
            return prev;
          }
          // Seal the streaming text bubble first so its caret clears the instant
          // the tool begins (same reasoning as the completion path below).
          return [...sealStreaming(prev), { kind: "tool", id: nextId(), tool: tc }];
        });
      },
      onToolCall: (tc, meta) => {
        if (!framesBelong(meta)) return;
        if (meta.jobId) armJob(meta.jobId);
        if (meta.sessionId) adoptSession(meta.sessionId);
        // A send_file call renders as a rich `file` turn (parsed from its output
        // envelope); everything else is the generic tool widget.
        const file = sentFileFromToolCall(tc);
        setTurns((prev) => {
          // Reconcile the pending row created on chat:tool_start (#175): replace
          // it in place — keeping its Turn id for a stable React key — with the
          // finished call (or the rich file turn for send_file).
          if (tc.toolUseId) {
            const idx = prev.findIndex(
              (t) => t.kind === "tool" && t.tool.toolUseId === tc.toolUseId,
            );
            if (idx !== -1) {
              const kept = prev[idx].id;
              const next = prev.slice();
              next[idx] = file
                ? { kind: "file", id: kept, file }
                : { kind: "tool", id: kept, tool: tc };
              return next;
            }
          }
          // No pending row (start frame lost/aged out of the replay buffer, or a
          // tool with no id): seal the streaming bubble and append, as before.
          const turn: Turn = file
            ? { kind: "file", id: nextId(), file }
            : { kind: "tool", id: nextId(), tool: tc };
          return [...sealStreaming(prev), turn];
        });
      },
      onMessageBoundary: (meta) => {
        if (!framesBelong(meta)) return;
        if (meta.jobId) armJob(meta.jobId);
        // Seal the current streaming bubble so the next assistant message
        // renders as a separate turn.
        setTurns((prev) => sealStreaming(prev));
      },
      onComplete: (meta) => {
        if (!framesBelong(meta)) return;
        if (meta.jobId) armJob(meta.jobId);
        streamingRef.current = false;
        setStreaming(false);
        // Seal the streaming bubble and settle any in-flight tool row whose
        // completion never arrived (#175 backstop) so no spinner survives the turn.
        setTurns((prev) => settlePending(sealStreaming(prev)));
        // Stale-by-one-turn context meter: store the last completed turn's
        // usage for this chat (omitted by the server when none was observed).
        if (meta.usage) setUsage(meta.usage);
        // Refresh the cumulative session totals (issue #152) now that the turn
        // just written a fresh usage line to the transcript. Best-effort — the
        // per-turn meter above already updated; this only re-tots the lifetime
        // figure. Uses the (possibly newly-minted) session id from the frame.
        {
          const sid = meta.sessionId ?? sessionRef.current;
          if (sid) {
            void api
              .chatContext(projectSlug, sid)
              .then((ctx) => setSessionUsage(ctx))
              .catch(() => {
                /* leave the prior cumulative figure in place */
              });
          }
        }
        if (meta.sessionId) {
          const wasNew = isNewSessionRef.current && sessionRef.current !== meta.sessionId;
          adoptSession(meta.sessionId);
          if (wasNew || isNewSessionRef.current) {
            isNewSessionRef.current = false;
            // Carry the new chat's picked model from its "new:<slug>" key onto
            // the now-established session-id key so reopening it restores it.
            if (modelRef.current) writeChatModel(meta.sessionId, projectSlug, modelRef.current);
            // Remember this so the parent's URL mirroring (which feeds the id
            // back as initialSessionId) doesn't trigger a re-hydration.
            establishedHereRef.current = meta.sessionId;
            onSessionEstablished?.(meta.sessionId);
          }
        }
        // A failed turn surfaces as an inline notice turn (#329, via the preceding
        // chat:notice frame) — richer, persistent, and retryable. Only fall back to
        // the transient composer-level error toast when no such notice arrived this
        // turn, so the failure is never invisible but also never double-surfaced.
        if (!meta.success && meta.error && !noticeThisTurnRef.current) setError(meta.error);
        // Pull model: a completed turn may have triggered a sweep that rewrote
        // OVERVIEW.md / CHANGELOG / added files — let the parent re-fetch. Hand
        // up the live per-turn usage (already accurate, no disk dependency) so
        // the parent can seed the chat-list ring immediately (issue #164).
        {
          const sid = meta.sessionId ?? sessionRef.current;
          onTurnComplete?.(sid && meta.usage ? { sessionId: sid, usage: meta.usage } : undefined);
        }
        // Issue #245: the SERVER auto-sends any queued follow-up (it drains its own
        // persisted copy on a successful turn and streams the next turn back here,
        // then a chat:queued_flushed clears our copy). The client no longer flushes
        // the queue itself — that removed a stranding path (a completion arriving
        // while the socket was down never fired the client flush) and a double-send
        // (client + server both sending). Just clear the Stop-hold marker.
        cancelledRef.current = false;
      },
      onError: (err) => {
        // chat:error carries no session id, so it can't be session-routed.
        // Only surface it when this pane actually has a turn in flight —
        // otherwise it's another chat's error leaking into an idle pane.
        if (!streamingRef.current) return;
        streamingRef.current = false;
        setStreaming(false);
        jobRef.current = null;
        setTurns((prev) => settlePending(sealStreaming(prev)));
        setError(err);
        // Hold the queue on error (#91) but clear the cancel flag so it can't
        // suppress a later turn's flush.
        cancelledRef.current = false;
      },
      onResync: () => {
        // Rare (#54): the server's live-turn buffer aged out before we could
        // re-attach, so it asked us to re-hydrate. Reload the transcript to catch
        // up on the gap; live frames for the still-running turn keep appending.
        const sid = sessionRef.current;
        if (!sid || !loadHistory) return;
        void loadHistory(sid)
          .then((msgs) => setTurns(historyToTurns(msgs)))
          .catch(() => {
            /* keep whatever we already have */
          });
      },
      onActive: ({ running, jobId }) => {
        // The server reports this chat's live-turn status (#52). On a pane that
        // navigated back to a still-streaming chat this restores the Stop button
        // and the job id needed to cancel — state a remount would otherwise lose.
        if (running) {
          if (jobId) armJob(jobId);
          streamingRef.current = true;
          setStreaming(true);
        } else {
          // The turn ended (possibly while we were away): clear the running UI.
          streamingRef.current = false;
          setStreaming(false);
          jobRef.current = null;
          setTurns((prev) => sealStreaming(prev));
          cancelledRef.current = false;
          pendingCancelRef.current = false;
        }
      },
      onQueuedFlushed: ({ text }) => {
        // The server auto-sent (or cleared a stale copy of) our queued message
        // (#245). Reflect it: render the sent bubble + clear the queue toolbar.
        onQueuedFlushedRef.current(text);
      },
      onInjected: (inj, meta) => {
        // A machine injected a user turn into THIS open chat (#290 Part 2):
        // another chat send_message'd / a schedule fired. Render its bubble live
        // (with the sender attribution) so it no longer takes a refresh to appear.
        if (!framesBelong(meta)) return;
        if (meta.jobId) armJob(meta.jobId);
        if (meta.sessionId) adoptSession(meta.sessionId);
        // Dedup a hub REPLAY (which re-delivers the buffered frame verbatim,
        // same server timestamp) while still rendering a genuinely new injection
        // — even one with identical text — since that carries a fresh timestamp.
        // `content` rides in the key too so a clock with only second-granularity
        // can't merge two distinct same-second injections.
        const key = `${inj.timestamp} ${inj.content}`;
        if (seenInjectionsRef.current.has(key)) return;
        seenInjectionsRef.current.add(key);
        setTurns((prev) => [
          ...sealStreaming(prev),
          { kind: "user", id: nextId(), content: inj.content, sender: inj.sender },
        ]);
      },
      onKilledTask: ({ summary, timestamp }) => {
        // A background task was killed at the turn boundary (#347) — surfaced LIVE
        // by the recovery engine (its notification is otherwise trapped in the SDK
        // input queue). Append the terminated-notification turn so the amber
        // "keeper is idle / Continue" affordance renders inline without a refresh.
        // Dedup on timestamp so a re-delivery can't stack duplicate notices.
        const key = `killed ${timestamp}`;
        if (seenInjectionsRef.current.has(key)) return;
        seenInjectionsRef.current.add(key);
        setTurns((prev) => [
          ...sealStreaming(prev),
          { kind: "notification", id: nextId(), summary, status: "killed" },
        ]);
      },
      onNotice: (notice, meta) => {
        if (!framesBelong(meta)) return;
        // A turn dead-ended without a normal reply (#329): a usage-limit hit, the
        // max-turns cap, or an error. Seal any streaming bubble and append a
        // distinct notice turn so the chat shows WHY it stopped. Mark the turn so
        // the failed-completion path doesn't also raise the transient error toast.
        noticeThisTurnRef.current = true;
        setTurns((prev) => [...sealStreaming(prev), { kind: "notice", id: nextId(), notice }]);
      },
    });
    return () => {
      sub.unsubscribe();
    };
    // Re-subscribe when the chat identity changes.
  }, [projectSlug, initialSessionId, loadHistory, onSessionEstablished, onSessionStarted, onTurnComplete]);

  // --- send / cancel ---------------------------------------------------------
  // The core send path, shared by a live composer submit and by the queue flush
  // (issue #91). `text` is already trimmed/non-empty and we are NOT streaming.
  const sendText = useCallback(
    (text: string) => {
      setError(null);
      pinnedRef.current = true;
      // Consume any composer attachments (#328): they ride WITH this turn and the
      // tray clears. Only for a plain (non-slash-command) project-chat send.
      const atts = text.startsWith("/") || !isProjectChat ? [] : attachRef.current;
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
      const preload = isProjectChat && isFirstTurnOfNewChat && preloadContext;
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
    [projectSlug, isProjectChat, preloadContext],
  );

  const send = useCallback(() => {
    const text = draft.trim();
    // A send needs SOMETHING: text, or (project chat) at least one attachment
    // (#328 — an image-only message is valid, ChatGPT-style).
    if (!text && !(isProjectChat && attachRef.current.length > 0)) return;
    // While a turn is in flight we can't send in parallel — queue the message
    // instead of no-opping (issue #91). Append to any already-queued message so
    // the slot stays single (Claude Code's model). The composer clears either
    // way, and the queued toolbar surfaces it above the composer.
    if (streaming) {
      setQueued((prev) => {
        const next = prev ? `${prev}\n${text}` : text;
        queuedRef.current = next;
        // Stamp a stable enqueue time on a fresh queue; keep it when appending to
        // an existing one (same pending message) so its identity is stable (#245).
        if (prev == null) queuedTsRef.current = Date.now();
        return next;
      });
      setDraft("");
      if (composerRef.current) composerRef.current.style.height = "auto";
      return;
    }
    setDraft("");
    sendText(text);
  }, [draft, streaming, sendText, isProjectChat]);

  // --- composer attachments (#328): effective config + upload handlers --------
  // The composer's effective attachment config: the per-project override wins
  // field-wise over the instance default (from /api/models). Allow-all defaults
  // apply until the fetch lands. Mirrors the server's resolveAttachmentsConfig.
  const attachConfig = useMemo<AttachmentsConfig>(() => {
    const d = attachmentsDefault ?? {
      enabled: true,
      maxFileSizeMb: 25,
      maxFilesPerMessage: 10,
      allowedTypes: ["*"],
    };
    const o = projectAttachments ?? {};
    return {
      enabled: o.enabled ?? d.enabled,
      maxFileSizeMb: o.maxFileSizeMb ?? d.maxFileSizeMb,
      maxFilesPerMessage: o.maxFilesPerMessage ?? d.maxFilesPerMessage,
      allowedTypes: o.allowedTypes ?? d.allowedTypes,
    };
  }, [attachmentsDefault, projectAttachments]);
  // Attachments are project-chat-only (the upload endpoint is project-scoped) and
  // gated by the effective `enabled` knob.
  const attachEnabled = isProjectChat && attachConfig.enabled;

  // Client-side validate (UX guardrail; the server re-validates authoritatively),
  // then upload accepted files and append their refs to the tray.
  const addFiles = useCallback(
    async (incoming: File[]) => {
      if (!attachEnabled || incoming.length === 0) return;
      const maxBytes = attachConfig.maxFileSizeMb * 1024 * 1024;
      const room = attachConfig.maxFilesPerMessage - attachRef.current.length;
      if (room <= 0) {
        setError(`You can attach at most ${attachConfig.maxFilesPerMessage} files per message.`);
        return;
      }
      const accepted: File[] = [];
      for (const f of incoming.slice(0, room)) {
        if (!isAttachmentTypeAllowed(attachConfig.allowedTypes, f.type, f.name)) {
          setError(`File type not allowed: ${f.name}`);
          continue;
        }
        if (f.size > maxBytes) {
          setError(`File too large (max ${attachConfig.maxFileSizeMb} MB): ${f.name}`);
          continue;
        }
        accepted.push(f);
      }
      if (incoming.length > room) {
        setError(`You can attach at most ${attachConfig.maxFilesPerMessage} files per message.`);
      }
      if (accepted.length === 0) return;
      setUploading(true);
      try {
        const { files } = await api.uploadAttachments(
          projectSlug,
          sessionRef.current ?? "new",
          accepted,
        );
        setAttachments((prev) => [...prev, ...files]);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed.");
      } finally {
        setUploading(false);
      }
    },
    [attachEnabled, attachConfig, projectSlug],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // Cmd/Ctrl+V of a screenshot (or any file) into the composer (#328).
  const onComposerPaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (!attachEnabled) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length > 0) {
        e.preventDefault();
        void addFiles(files);
      }
    },
    [attachEnabled, addFiles],
  );

  // Drag-and-drop onto the composer (#328). `dragOver` highlights the drop zone.
  const onComposerDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!attachEnabled) return;
      if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) {
        e.preventDefault();
        setDragOver(true);
      }
    },
    [attachEnabled],
  );
  const onComposerDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear when the pointer actually leaves the drop zone (not a child).
    if (e.currentTarget === e.target) setDragOver(false);
  }, []);
  const onComposerDrop = useCallback(
    (e: React.DragEvent) => {
      if (!attachEnabled) return;
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) {
        e.preventDefault();
        setDragOver(false);
        void addFiles(files);
      }
    },
    [attachEnabled, addFiles],
  );
  const onPickFiles = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length > 0) void addFiles(files);
      // Reset so re-picking the same file fires onChange again.
      e.target.value = "";
    },
    [addFiles],
  );

  // Render the server's auto-sent queued message as the user bubble, then clear
  // this pane's queued state (#245). Fires on chat:queued_flushed: `text` present
  // means the server drained+sent it (the drained turn streams the reply right
  // after), so we append the user turn to keep the transcript in order; either way
  // the queue toolbar + local/persisted copy are cleared (the socket layer already
  // cleared localStorage). The server owns the send — we only reflect it.
  const onQueuedFlushed = useCallback((text?: string) => {
    if (text) {
      pinnedRef.current = true;
      setTurns((prev) => [...sealStreaming(prev), { kind: "user", id: nextId(), content: text }]);
    }
    queuedRef.current = null;
    queuedTsRef.current = null;
    setQueued(null);
  }, []);
  // Stable ref so the (stably-subscribed) socket handlers call the latest version.
  const onQueuedFlushedRef = useRef(onQueuedFlushed);
  onQueuedFlushedRef.current = onQueuedFlushed;

  // Pop the queued message back into the composer for editing. This CANCELS the
  // pending auto-send (queuedRef → null): the server clears its copy via the
  // setQueued(null) effect — it's a draft again until re-submitted (#91).
  const editQueued = useCallback(() => {
    const text = queuedRef.current;
    if (text == null) return;
    queuedRef.current = null;
    queuedTsRef.current = null;
    setQueued(null);
    setDraft((prev) => (prev.trim() ? `${text}\n${prev}` : text));
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (el) {
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
        el.focus();
      }
    });
  }, []);

  // Discard the queued message entirely (the setQueued(null) effect clears the
  // server + persisted copies too).
  const clearQueued = useCallback(() => {
    queuedRef.current = null;
    queuedTsRef.current = null;
    setQueued(null);
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
    if (!sid || projectSlug === SCRATCH_SLUG) return;
    if (streamingRef.current) return;
    setStreaming(true);
    chatClient.continueChat(projectSlug, sid);
  }, [projectSlug]);

  // Resolve the effective Layer 2 flag: the per-project override wins field-wise,
  // else the instance default, else the built-in ON (issue #301). Memoised so the
  // context value is stable across renders that don't change the inputs.
  const recoveryCtx = useMemo<RecoveryContextValue | null>(() => {
    if (projectSlug === SCRATCH_SLUG) return null;
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
              <div className="h-4 w-2/3 animate-pulse rounded bg-paddock-200/70 dark:bg-paddock-800/70" />
              <div className="h-4 w-1/2 animate-pulse rounded bg-paddock-200/70 dark:bg-paddock-800/70" />
            </div>
          )}

          {empty && (
            <div className="mt-16 flex flex-col items-center text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
                <SparkIcon width={22} height={22} />
              </div>
              <p className="max-w-sm text-sm text-paddock-500">
                {emptyHint ??
                  "Start the conversation. Messages stream live from the keeper agent and persist as a resumable session."}
              </p>
            </div>
          )}

          <SubagentFetchContext.Provider value={fetchSubagent}>
            <ToolImageUrlContext.Provider value={toolImageUrl}>
              <PaddockManageProjectContext.Provider value={projectSlug}>
                <RecoveryContext.Provider value={recoveryCtx}>
                  <div className="space-y-4">
                    {turns.map((t) => (
                      <TurnView key={t.id} turn={t} />
                    ))}
                  </div>
                </RecoveryContext.Provider>
              </PaddockManageProjectContext.Provider>
            </ToolImageUrlContext.Provider>
          </SubagentFetchContext.Provider>
        </div>
      </div>

      {/* Persistent "agent is working…" indicator while a turn is in flight
          (#53) — independent of whether a bubble is currently painting, so it
          shows during the initial thinking gap and between tool calls, and lights
          up the instant you return to a still-streaming chat. */}
      {streaming && <WorkingIndicator />}

      {error && (
        <div className="mx-auto mb-2 flex w-full max-w-3xl items-start gap-2 px-4">
          <div className="flex w-full items-start gap-2 rounded-lg border border-rose-300/60 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/50 dark:text-rose-300">
            <AlertIcon width={16} height={16} className="mt-0.5 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        </div>
      )}

      {/* Queued-message toolbar (#91): the single message stacked to auto-send
          when the current turn frees up. Sits directly above the composer. */}
      {queued != null && (
        <QueuedMessageBar text={queued} onEdit={editQueued} onClear={clearQueued} />
      )}

      {/* composer */}
      <div className="border-t border-paddock-200 bg-canvas/80 backdrop-blur dark:border-paddock-800 dark:bg-canvas-dark/80">
        <div className="pb-safe mx-auto w-full max-w-3xl px-4 pt-3">
          {showPreload && (
            <PreloadToggle
              checked={preloadContext}
              available={preloadAvailable}
              onChange={setPreloadContext}
            />
          )}
          <StatusRow
            models={models}
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
                <span className="flex items-center gap-1.5 rounded-xl bg-paddock-50 px-3 py-2 text-xs text-paddock-500 ring-1 ring-paddock-200/70 dark:bg-paddock-950 dark:ring-paddock-800">
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-paddock-300 border-t-accent" />
                  Uploading…
                </span>
              )}
            </div>
          )}
          <div
            className={`relative flex items-end gap-2 rounded-2xl border bg-white p-2 shadow-sm focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20 dark:bg-paddock-900 ${
              dragOver
                ? "border-accent ring-2 ring-accent/30"
                : "border-paddock-300 dark:border-paddock-700"
            }`}
            onDragOver={attachEnabled ? onComposerDragOver : undefined}
            onDragLeave={attachEnabled ? onComposerDragLeave : undefined}
            onDrop={attachEnabled ? onComposerDrop : undefined}
          >
            {/* Drop-zone overlay while dragging files over the composer (#328). */}
            {dragOver && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-accent/10 text-sm font-medium text-accent">
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
                    className={`menu-item ${
                      i === menuIndex ? "bg-paddock-100 dark:bg-paddock-800" : ""
                    }`}
                    onMouseEnter={() => setMenuIndex(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      acceptCommand(cmd);
                    }}
                  >
                    <span className="flex w-full items-baseline gap-2">
                      <span className="font-mono font-medium text-accent">/{cmd.name}</span>
                      {cmd.argumentHint && (
                        <span className="shrink-0 text-paddock-400">{cmd.argumentHint}</span>
                      )}
                      {cmd.description && (
                        <span className="ml-auto truncate text-paddock-500">{cmd.description}</span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={composerRef}
              className="max-h-48 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-paddock-400 dark:placeholder:text-paddock-600"
              rows={1}
              autoCapitalize="sentences"
              value={draft}
              placeholder={
                streaming
                  ? "Queue a message to send next…"
                  : (placeholder ?? "Message the keeper agent…")
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
                  className="btn bg-transparent text-paddock-500 hover:bg-paddock-100 hover:text-paddock-700 dark:text-paddock-400 dark:hover:bg-paddock-800"
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
                className="btn bg-paddock-200 text-paddock-700 hover:bg-paddock-300 dark:bg-paddock-800 dark:text-paddock-200 dark:hover:bg-paddock-700"
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
          <div className="mt-1.5 flex items-center justify-between px-1 text-[11px] text-paddock-400">
            <span>
              <kbd className="font-sans">Enter</kbd> to {streaming ? "queue" : "send"} ·{" "}
              <kbd className="font-sans">Shift+Enter</kbd> for newline
            </span>
            <ConnDot state={conn} />
          </div>
        </div>
      </div>
    </div>
  );
}

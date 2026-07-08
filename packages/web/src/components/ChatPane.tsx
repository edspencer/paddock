import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { chatClient, type ConnectionState, type ToolCall } from "../lib/ws";
import { Markdown } from "./Markdown";
import { DictationButton } from "./DictationButton";
import { formatDuration } from "../lib/format";
import { api } from "../lib/api";
import { readChatModel, writeChatModel } from "../lib/chatModel";
import { readDraft, writeDraft } from "../lib/draft";
import {
  AlertIcon,
  BranchIcon,
  ChevronRightIcon,
  ClockIcon,
  PencilIcon,
  SendIcon,
  SparkIcon,
  StopIcon,
  WrenchIcon,
  XIcon,
} from "./icons";
import type { ChatCompleteUsage, HistoryMessage, ModelInfo, SlashCommand } from "../lib/types";

/** One rendered item in the transcript. Assistant boundaries split bubbles. */
type Turn =
  | { kind: "user"; id: string; content: string }
  | { kind: "assistant"; id: string; content: string; streaming: boolean }
  | { kind: "tool"; id: string; tool: ToolCall };

let idCounter = 0;
const nextId = () => `t${++idCounter}`;

/** Tool names that launch a sub-agent: `Task` (classic Claude Code), `Agent` (SDK). */
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

/**
 * Fetches a sub-agent's nested steps by its parent tool_use id (issue #37).
 * Provided per-chat (bound to slug + session); consumed by ToolBlock so every
 * depth of nesting can lazy-load through the same call. Null outside a chat.
 */
const SubagentFetchContext = createContext<
  ((toolUseId: string) => Promise<HistoryMessage[]>) | null
>(null);

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
  /** Called whenever a turn completes (pull model: re-fetch project/files for sweeps). */
  onTurnComplete?: () => void;
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
  // finishes. `queued` drives the toolbar above the composer; `queuedRef` is the
  // same value read by the flush that fires inside the (stably-subscribed) socket
  // handlers, which can't see the latest `queued` state. `null` = nothing queued.
  const [queued, setQueued] = useState<string | null>(null);
  const queuedRef = useRef<string | null>(null);
  // Set when the user hits Stop, so the completion it triggers does NOT flush the
  // queue (we hold rather than fire a follow-up into a cancelled turn). Cleared
  // on the next completion.
  const cancelledRef = useRef(false);

  // Issue #1: preload the project's curated OVERVIEW.md as context on the FIRST
  // turn of a new project chat. Default ON for project chats. Only sent on the
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

  // The chat's default model: project model for project chats, else keeperDefault.
  const defaultModel = (isProjectChat ? projectModel : keeperDefault) ?? keeperDefault;

  // Session id is kept in a ref (the WS sub needs the latest without re-subscribing).
  const sessionRef = useRef<string | null>(initialSessionId ?? null);
  const jobRef = useRef<string | null>(null);

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
          setTurns(msgs.map(historyToTurn));
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
  }, [projectSlug, initialSessionId]);

  // Persist the unsent draft for this chat so it survives a switch/reload.
  // Writing an empty string removes the stored key, so clearing the composer
  // (setDraft("") on send) forgets the draft without any explicit clear call.
  useEffect(() => {
    writeDraft(initialSessionId, projectSlug, draft);
  }, [draft, initialSessionId, projectSlug]);

  // Auto-focus the composer on mount when asked (e.g. right after forking, so the
  // user can immediately continue the new fork). A normal chat open leaves focus
  // alone.
  useEffect(() => {
    if (autoFocus) composerRef.current?.focus();
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
    const sub = chatClient.subscribe(projectSlug, sessionRef.current, {
      onResponse: (chunk, meta) => {
        if (!framesBelong(meta)) return;
        if (meta.jobId) jobRef.current = meta.jobId;
        if (meta.sessionId) adoptSession(meta.sessionId);
        appendAssistantText(setTurns, chunk);
      },
      onToolCall: (tc, meta) => {
        if (!framesBelong(meta)) return;
        if (meta.jobId) jobRef.current = meta.jobId;
        if (meta.sessionId) adoptSession(meta.sessionId);
        // Seal the streaming text bubble before appending the tool row, so its
        // caret clears the instant the tool call begins. Otherwise the bubble
        // is no longer the trailing turn and nothing can ever clear its caret.
        setTurns((prev) => [...sealStreaming(prev), { kind: "tool", id: nextId(), tool: tc }]);
      },
      onMessageBoundary: (meta) => {
        if (!framesBelong(meta)) return;
        if (meta.jobId) jobRef.current = meta.jobId;
        // Seal the current streaming bubble so the next assistant message
        // renders as a separate turn.
        setTurns((prev) => sealStreaming(prev));
      },
      onComplete: (meta) => {
        if (!framesBelong(meta)) return;
        if (meta.jobId) jobRef.current = meta.jobId;
        streamingRef.current = false;
        setStreaming(false);
        setTurns((prev) => sealStreaming(prev));
        // Stale-by-one-turn context meter: store the last completed turn's
        // usage for this chat (omitted by the server when none was observed).
        if (meta.usage) setUsage(meta.usage);
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
        if (!meta.success && meta.error) setError(meta.error);
        // Pull model: a completed turn may have triggered a sweep that rewrote
        // OVERVIEW.md / CHANGELOG / added files — let the parent re-fetch.
        onTurnComplete?.();
        // Issue #91: the turn is free — auto-send any queued message as the next
        // turn. Hold (don't flush) if this completion was a user Stop or a failed
        // turn; leave the message queued for the user to send/edit instead.
        const cancelled = cancelledRef.current;
        cancelledRef.current = false;
        if (meta.success && !cancelled) flushRef.current();
      },
      onError: (err) => {
        // chat:error carries no session id, so it can't be session-routed.
        // Only surface it when this pane actually has a turn in flight —
        // otherwise it's another chat's error leaking into an idle pane.
        if (!streamingRef.current) return;
        streamingRef.current = false;
        setStreaming(false);
        jobRef.current = null;
        setTurns((prev) => sealStreaming(prev));
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
          .then((msgs) => setTurns(msgs.map(historyToTurn)))
          .catch(() => {
            /* keep whatever we already have */
          });
      },
      onActive: ({ running, jobId }) => {
        // The server reports this chat's live-turn status (#52). On a pane that
        // navigated back to a still-streaming chat this restores the Stop button
        // and the job id needed to cancel — state a remount would otherwise lose.
        if (running) {
          if (jobId) jobRef.current = jobId;
          streamingRef.current = true;
          setStreaming(true);
        } else {
          // The turn ended (possibly while we were away): clear the running UI.
          streamingRef.current = false;
          setStreaming(false);
          jobRef.current = null;
          setTurns((prev) => sealStreaming(prev));
          cancelledRef.current = false;
        }
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
      setTurns((prev) => [
        ...sealStreaming(prev),
        { kind: "user", id: nextId(), content: text },
      ]);
      // Clearing the value doesn't undo the inline height the autosize handler
      // grew the textarea to, so a multi-line message would leave the composer
      // tall until the next keystroke. Reset it back to one row here.
      if (composerRef.current) composerRef.current.style.height = "auto";
      setStreaming(true);
      streamingRef.current = true;
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
      });
    },
    [projectSlug, isProjectChat, preloadContext],
  );

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    // While a turn is in flight we can't send in parallel — queue the message
    // instead of no-opping (issue #91). Append to any already-queued message so
    // the slot stays single (Claude Code's model). The composer clears either
    // way, and the queued toolbar surfaces it above the composer.
    if (streaming) {
      setQueued((prev) => {
        const next = prev ? `${prev}\n${text}` : text;
        queuedRef.current = next;
        return next;
      });
      setDraft("");
      if (composerRef.current) composerRef.current.style.height = "auto";
      return;
    }
    setDraft("");
    sendText(text);
  }, [draft, streaming, sendText]);

  // Auto-send the queued message as the next turn once the current one is free.
  // Reads/clears queuedRef (not `queued` state) so the socket handlers — which
  // close over a stale render — flush the latest queued text. No-op if empty.
  const flushQueued = useCallback(() => {
    const text = queuedRef.current;
    if (!text) return;
    queuedRef.current = null;
    setQueued(null);
    sendText(text);
  }, [sendText]);
  // Keep a ref to the latest flush so the stably-subscribed socket handlers can
  // call it without being torn down/re-subscribed when `sendText` changes.
  const flushRef = useRef(flushQueued);
  flushRef.current = flushQueued;

  // Pop the queued message back into the composer for editing. This CANCELS the
  // pending auto-send (queuedRef → null): if the turn finishes mid-edit it must
  // not fire in the background — it's a draft again until re-submitted (#91).
  const editQueued = useCallback(() => {
    const text = queuedRef.current;
    if (text == null) return;
    queuedRef.current = null;
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

  // Discard the queued message entirely.
  const clearQueued = useCallback(() => {
    queuedRef.current = null;
    setQueued(null);
  }, []);

  const cancel = useCallback(() => {
    // jobId is captured off event metadata in the handlers below. The server
    // emits chat:complete/error on cancel; the UI unlocks there. Mark the turn
    // as cancelled so its completion does NOT flush the queue (#91: hold rather
    // than fire a follow-up into a stopped turn).
    cancelledRef.current = true;
    if (jobRef.current) chatClient.cancel(jobRef.current);
  }, []);

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
            <div className="space-y-4">
              {turns.map((t) => (
                <TurnView key={t.id} turn={t} />
              ))}
            </div>
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
        <div className="mx-auto w-full max-w-3xl px-4 py-3">
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
            forkParent={forkParent}
            onOpenForkParent={onOpenForkParent}
          />
          <div className="relative flex items-end gap-2 rounded-2xl border border-paddock-300 bg-white p-2 shadow-sm focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20 dark:border-paddock-700 dark:bg-paddock-900">
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
            />
            {/* Voice dictation (#voice): renders nothing unless the instance has
                a whisper backend configured. Disabled while a turn streams. */}
            <DictationButton onText={insertDictation} disabled={streaming} />
            {streaming ? (
              <button
                type="button"
                onClick={cancel}
                title="Stop generating"
                className="btn bg-paddock-200 text-paddock-700 hover:bg-paddock-300 dark:bg-paddock-800 dark:text-paddock-200 dark:hover:bg-paddock-700"
              >
                <StopIcon width={15} height={15} />
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={send}
                disabled={!draft.trim()}
                className="btn-primary"
                title="Send (Enter)"
              >
                <SendIcon width={15} height={15} />
                Send
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

/**
 * Issue #1 — the "Preload project context" checkbox shown on a NEW project
 * chat's composer. When checked, the first turn injects the project's curated
 * OVERVIEW.md as context. Disabled (with an explanatory note) until a sweep has
 * produced an overview.
 */
function PreloadToggle({
  checked,
  available,
  onChange,
}: {
  checked: boolean;
  available: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      className={`group mb-2 inline-flex w-fit items-center gap-2 rounded-lg px-1 py-0.5 text-xs ${
        available
          ? "cursor-pointer text-paddock-600 dark:text-paddock-300"
          : "cursor-not-allowed text-paddock-400"
      }`}
      title={
        available
          ? "Inject this project's curated OVERVIEW.md as context on the first message of this new chat, so the agent starts already knowing the project's state."
          : "No project overview yet — a sweep writes OVERVIEW.md after some activity. The agent will still see the project's files."
      }
    >
      <input
        type="checkbox"
        // Reflects the user's intent (default ON); disabled until a sweep has
        // produced an overview to actually inject.
        checked={checked}
        disabled={!available}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 rounded border-paddock-300 accent-accent focus:ring-accent/30 disabled:opacity-50 dark:border-paddock-600"
      />
      <span className="font-medium">Preload project context</span>
      <span className="text-paddock-400 transition-opacity">
        {available ? "(injects OVERVIEW.md)" : "(no overview yet)"}
      </span>
    </label>
  );
}

/**
 * CONTRACT-v3 §8 — a compact status row above the composer: a model picker and
 * a context-window meter for the currently open chat. Deliberately unobtrusive
 * (a status row, not a settings panel). The meter is sourced from the most
 * recent completed turn's usage, so it is intentionally stale-by-one-turn.
 */
function StatusRow({
  models,
  model,
  onSelectModel,
  usage,
  forkParent,
  onOpenForkParent,
}: {
  models: ModelInfo[];
  model: string | null;
  onSelectModel: (id: string) => void;
  usage: ChatCompleteUsage | null;
  forkParent?: { sessionId: string; name: string };
  onOpenForkParent?: (sessionId: string) => void;
}) {
  return (
    <div className="mb-2 flex items-center gap-3 px-1 text-[11px] text-paddock-400">
      <label className="inline-flex items-center gap-1.5">
        <span className="font-medium text-paddock-500 dark:text-paddock-400">Model</span>
        <select
          value={model ?? ""}
          onChange={(e) => onSelectModel(e.target.value)}
          disabled={models.length === 0}
          title="Model for this chat (sent on every message; remembered per chat)"
          className="rounded-md border border-paddock-300 bg-white px-1.5 py-0.5 text-[11px] text-paddock-700 outline-none focus:border-accent focus:ring-1 focus:ring-accent/20 disabled:opacity-50 dark:border-paddock-700 dark:bg-paddock-900 dark:text-paddock-200"
        >
          {/* A placeholder while the selected model isn't among the loaded list
              (e.g. before /api/models resolves) so the <select> stays controlled. */}
          {model && !models.some((m) => m.id === model) && (
            <option value={model}>{model}</option>
          )}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <ContextMeter usage={usage} />
      {/* Fork lineage: this chat was branched from another — link back to it.
          Sits to the right (ml-auto) in the otherwise-empty gap of the row. */}
      {forkParent && (
        <span className="ml-auto inline-flex min-w-0 items-center gap-1">
          <BranchIcon width={11} height={11} className="shrink-0 text-paddock-400" />
          <span className="shrink-0">Fork of</span>
          <button
            type="button"
            onClick={() => onOpenForkParent?.(forkParent.sessionId)}
            title={`Open the chat this was forked from: ${forkParent.name}`}
            className="truncate font-medium text-accent underline-offset-2 hover:underline"
          >
            {forkParent.name}
          </button>
        </span>
      )}
    </div>
  );
}

/**
 * The thin context-window meter. Before any turn completes (no usage yet) it
 * shows a muted "context: —" placeholder. Once a turn has completed it renders
 * "{k}k / {limit}k ({pct}%)" with a thin progress bar that turns amber at ≥80%.
 */
function ContextMeter({ usage }: { usage: ChatCompleteUsage | null }) {
  if (!usage || usage.contextLimit <= 0) {
    return <span className="text-paddock-400">context: —</span>;
  }
  const pct = Math.min(100, Math.max(0, (usage.contextTokens / usage.contextLimit) * 100));
  const warn = pct >= 80;
  const used = Math.round(usage.contextTokens / 1000);
  const limit = Math.round(usage.contextLimit / 1000);
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5"
      title={`Context window used as of the last completed turn (${usage.contextTokens.toLocaleString()} / ${usage.contextLimit.toLocaleString()} tokens)`}
    >
      <span className="h-1 w-20 overflow-hidden rounded-full bg-paddock-200 dark:bg-paddock-800">
        <span
          className={`block h-full rounded-full transition-all ${
            warn ? "bg-amber-500" : "bg-accent"
          }`}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className={warn ? "text-amber-600 dark:text-amber-400" : undefined}>
        {used}k / {limit}k ({Math.round(pct)}%)
      </span>
    </span>
  );
}

/**
 * A persistent "agent is working…" pill shown under the transcript while a turn
 * is in flight (#53). Cycles a few lightweight status phrases (à la Claude Code's
 * "reticulating splines") so it reads as alive even during a quiet thinking gap,
 * and — because it's driven by the turn-level `streaming` state, now restored on
 * return via chat:active — it lights up the moment you come back to a live chat.
 */
const WORKING_PHRASES = [
  "working",
  "thinking",
  "reticulating splines",
  "consulting the keeper",
  "herding electrons",
  "tending the paddock",
];
function WorkingIndicator() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % WORKING_PHRASES.length), 2600);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="mx-auto mb-2 w-full max-w-3xl px-4">
      <div className="inline-flex items-center gap-2 rounded-full border border-paddock-200 bg-paddock-100/70 px-3 py-1 text-xs text-paddock-500 dark:border-paddock-800 dark:bg-paddock-900/50 dark:text-paddock-400">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
        </span>
        <span>{WORKING_PHRASES[i]}…</span>
      </div>
    </div>
  );
}

/**
 * Issue #91 — the slim "queued message" toolbar shown directly above the
 * composer while a message is stacked to auto-send. Shows the queued message's
 * first line + a "queued" indicator; hovering reveals Edit (pop it back into the
 * composer, cancelling the pending auto-send) and Clear (discard it). At most one
 * message is ever queued.
 */
function QueuedMessageBar({
  text,
  onEdit,
  onClear,
}: {
  text: string;
  onEdit: () => void;
  onClear: () => void;
}) {
  const firstLine = text.split("\n", 1)[0];
  // Everything past the first line is hidden by the single-line toolbar. Surface
  // how much more there is so a multi-line queued message doesn't look truncated
  // (issue #91 follow-up) — counts the hidden characters, newline(s) included.
  const moreChars = text.length - firstLine.length;
  return (
    <div className="mx-auto mb-2 w-full max-w-3xl px-4">
      <div className="group flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/[0.06] px-3 py-1.5 text-xs dark:border-accent/40 dark:bg-accent/10">
        <ClockIcon width={13} height={13} className="shrink-0 text-accent" />
        <span className="shrink-0 font-semibold uppercase tracking-wide text-accent">
          queued
        </span>
        <span
          className="min-w-0 flex-1 truncate text-paddock-600 dark:text-paddock-300"
          title={text}
        >
          {firstLine}
        </span>
        {moreChars > 0 && (
          <span
            className="shrink-0 tabular-nums text-paddock-400 dark:text-paddock-500"
            title={`${moreChars} more character${moreChars === 1 ? "" : "s"} not shown — hover Edit to see the full message`}
          >
            +{moreChars} character{moreChars === 1 ? "" : "s"}
          </span>
        )}
        {/* Revealed on hover/focus. Kept in the DOM (not conditionally mounted)
            so they stay keyboard-reachable and testable. */}
        <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            onClick={onEdit}
            title="Edit this message (cancels the pending auto-send)"
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-paddock-600 hover:bg-paddock-200/70 dark:text-paddock-300 dark:hover:bg-paddock-800"
          >
            <PencilIcon width={12} height={12} />
            Edit
          </button>
          <button
            type="button"
            onClick={onClear}
            title="Remove queued message"
            aria-label="Remove queued message"
            className="inline-flex items-center rounded p-1 text-paddock-500 hover:bg-paddock-200/70 hover:text-rose-600 dark:text-paddock-400 dark:hover:bg-paddock-800"
          >
            <XIcon width={12} height={12} />
          </button>
        </span>
      </div>
    </div>
  );
}

function ConnDot({ state }: { state: ConnectionState }) {
  const map = {
    open: { c: "bg-emerald-500", t: "connected" },
    connecting: { c: "bg-amber-500 animate-pulse", t: "connecting" },
    closed: { c: "bg-rose-500", t: "offline" },
  }[state];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 rounded-full ${map.c}`} />
      {map.t}
    </span>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  if (turn.kind === "user") {
    return (
      <div className="flex animate-fade-in justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm text-white shadow-sm">
          {turn.content}
        </div>
      </div>
    );
  }
  if (turn.kind === "tool") {
    return <ToolBlock tool={turn.tool} />;
  }
  // assistant
  return (
    <div className="flex animate-fade-in justify-start">
      <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-white px-4 py-2.5 text-ink shadow-sm ring-1 ring-paddock-200/70 dark:bg-paddock-900 dark:text-ink-dark dark:ring-paddock-800">
        {turn.content ? (
          <div className={turn.streaming ? "streaming-caret" : undefined}>
            <Markdown>{turn.content}</Markdown>
          </div>
        ) : (
          <div className="flex gap-1 py-1">
            <Dot /> <Dot delay="150ms" /> <Dot delay="300ms" />
          </div>
        )}
      </div>
    </div>
  );
}

function Dot({ delay }: { delay?: string }) {
  return (
    <span
      className="h-1.5 w-1.5 animate-bounce rounded-full bg-paddock-400"
      style={{ animationDelay: delay }}
    />
  );
}

function ToolBlock({ tool }: { tool: ToolCall }) {
  const [open, setOpen] = useState(false);
  // For a sub-agent, show its actual run time (from its transcript) rather than
  // the near-instant launch time the Task/Agent tool_call itself records.
  const dur = formatDuration(tool.subagentDurationMs ?? tool.durationMs);
  const isSubagent = SUBAGENT_TOOLS.has(tool.toolName);
  // Expandable-into-steps only when the sub-agent's transcript is on disk.
  const expandable = Boolean(isSubagent && tool.hasSubagent && tool.toolUseId);
  // Sub-agent header reads as "<type> — <description>"; other tools keep the
  // classic "<toolName> <inputSummary>".
  const label = isSubagent ? (tool.subagentType ?? tool.toolName) : tool.toolName;
  const subtitle = isSubagent ? tool.description : tool.inputSummary;
  return (
    <div className="flex justify-start">
      <div
        className={`w-full max-w-[92%] overflow-hidden rounded-xl border text-xs transition-colors ${
          tool.isError
            ? "border-rose-300/70 bg-rose-50/60 dark:border-rose-900/60 dark:bg-rose-950/30"
            : isSubagent
              ? "border-accent/40 bg-accent/[0.06] dark:border-accent/40 dark:bg-accent/10"
              : "border-paddock-200 bg-paddock-100/50 dark:border-paddock-800 dark:bg-paddock-900/40"
        }`}
      >
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left"
        >
          <ChevronRightIcon
            width={13}
            height={13}
            className={`shrink-0 text-paddock-400 transition-transform ${open ? "rotate-90" : ""}`}
          />
          {isSubagent ? (
            <SparkIcon
              width={13}
              height={13}
              className={`shrink-0 ${tool.isError ? "text-rose-500" : "text-accent"}`}
            />
          ) : (
            <WrenchIcon
              width={13}
              height={13}
              className={`shrink-0 ${tool.isError ? "text-rose-500" : "text-paddock-500"}`}
            />
          )}
          <span className="shrink-0 whitespace-nowrap font-mono font-semibold text-paddock-700 dark:text-paddock-200">
            {label}
          </span>
          {isSubagent && (
            <span className="shrink-0 whitespace-nowrap rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
              sub-agent
            </span>
          )}
          {subtitle && (
            <span className="min-w-0 truncate font-mono text-paddock-500 dark:text-paddock-400">
              {subtitle}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {tool.isError && (
              <span className="rounded bg-rose-200/70 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 dark:bg-rose-900/60 dark:text-rose-300">
                error
              </span>
            )}
            {dur && <span className="text-paddock-400">{dur}</span>}
          </span>
        </button>
        {open &&
          (expandable ? (
            <NestedSteps toolUseId={tool.toolUseId!} />
          ) : (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-paddock-200/70 bg-paddock-50/80 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-paddock-700 dark:border-paddock-800 dark:bg-paddock-950/60 dark:text-paddock-300">
              {tool.output || "(no output)"}
            </pre>
          ))}
      </div>
    </div>
  );
}

/**
 * A sub-agent's own step-by-step transcript, lazy-loaded on first expand and
 * rendered inline (issue #37). Reuses TurnView, so any Task/Agent steps the
 * sub-agent itself ran render as further-expandable ToolBlocks — arbitrary depth
 * through the same SubagentFetchContext (sub-agents are flat under the session).
 */
function NestedSteps({ toolUseId }: { toolUseId: string }) {
  const fetchSubagent = useContext(SubagentFetchContext);
  const [msgs, setMsgs] = useState<HistoryMessage[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!fetchSubagent) {
      setError(true);
      return;
    }
    let cancelled = false;
    setMsgs(null);
    setError(false);
    fetchSubagent(toolUseId)
      .then((m) => !cancelled && setMsgs(m))
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
    };
  }, [fetchSubagent, toolUseId]);

  const turns = useMemo(() => (msgs ?? []).map(historyToTurn), [msgs]);

  return (
    <div className="border-t border-paddock-200/70 bg-paddock-50/60 px-3 py-3 dark:border-paddock-800 dark:bg-paddock-950/40">
      {error ? (
        <div className="text-[11.5px] text-rose-500">couldn't load sub-agent steps</div>
      ) : msgs === null ? (
        <div className="flex items-center gap-1.5 text-[11.5px] text-paddock-400">
          <Dot /> <Dot delay="150ms" /> <Dot delay="300ms" />
          <span className="ml-1">loading sub-agent steps…</span>
        </div>
      ) : turns.length === 0 ? (
        <div className="text-[11.5px] text-paddock-400">(no recorded steps)</div>
      ) : (
        <div className="space-y-3 border-l-2 border-accent/30 pl-3">
          {turns.map((t) => (
            <TurnView key={t.id} turn={t} />
          ))}
        </div>
      )}
    </div>
  );
}

// --- transcript reducers -----------------------------------------------------

/** Append streaming assistant text, creating a new streaming bubble if needed. */
function appendAssistantText(
  set: React.Dispatch<React.SetStateAction<Turn[]>>,
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
function sealStreaming(prev: Turn[]): Turn[] {
  if (!prev.some((t) => t.kind === "assistant" && t.streaming)) return prev;
  return prev.map((t) =>
    t.kind === "assistant" && t.streaming ? { ...t, streaming: false } : t,
  );
}

/** Convert a hydrated history message into a rendered turn. */
function historyToTurn(m: HistoryMessage): Turn {
  if (m.role === "tool" && m.toolCall) {
    return { kind: "tool", id: nextId(), tool: m.toolCall };
  }
  if (m.role === "assistant") {
    return { kind: "assistant", id: nextId(), content: m.content, streaming: false };
  }
  return { kind: "user", id: nextId(), content: m.content };
}

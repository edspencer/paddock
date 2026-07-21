import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import { chatClient, type ConnectionState, type ToolCall } from "../lib/ws";
import { Markdown } from "./Markdown";
import { DictationButton } from "./DictationButton";
import { formatDuration } from "../lib/format";
import { api } from "../lib/api";
import { readChatModel, writeChatModel } from "../lib/chatModel";
import { readDraft, writeDraft } from "../lib/draft";
import { readQueued, writeQueued, readQueuedTs, writeQueuedTs } from "../lib/queued";
import { readAttachmentRefs, writeAttachmentRefs } from "../lib/attachmentRefs";
import {
  AlertIcon,
  BranchIcon,
  ChatIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  FileIcon,
  FolderIcon,
  PaperclipIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SendIcon,
  SparkIcon,
  StopIcon,
  WrenchIcon,
  XIcon,
} from "./icons";
import type {
  AttachmentRef,
  AttachmentsConfig,
  AttachmentsOverride,
  BashDetails,
  ChatCompleteUsage,
  ChatHookInfo,
  ChatTriggerInfo,
  ChatUsage,
  EditDiff,
  HistoryMessage,
  MessageSender,
  ModelInfo,
  ReadInfo,
  RecoveryConfig,
  RecoveryOverride,
  SearchInfo,
  SentFile,
  SentFileEnvelope,
  SlashCommand,
  TaskCreateInfo,
} from "../lib/types";
import {
  parseAttachments,
  isTypeAllowed as isAttachmentTypeAllowed,
  acceptAttribute,
} from "../lib/attachments";
import { MessageAttachments, AttachmentTrayItem } from "./MessageAttachments";
import { SCRATCH_SLUG } from "../lib/types";
import {
  formatSessionUsage,
  formatTokens,
  formatUsd,
  isCompactContinuation,
  isTaskNotification,
  isTerminatedTaskStatus,
  slashCommandEcho,
  taskNotificationStatus,
  taskNotificationSummary,
} from "../lib/format";
import { HookCapabilityBanner } from "./HookCapabilityBanner";
import { TriggerCapabilityBanner } from "./TriggerCapabilityBanner";
import { SentFileBlock } from "./SentFileBlock";
import { InlineImage } from "./MediaImage";
import { PaddockManageBody, PaddockManageProjectContext } from "./PaddockManageBlock";
import { mcpToolInfo, parsePaddockManage, paddockManageSummary } from "../lib/mcpTools";

/** One rendered item in the transcript. Assistant boundaries split bubbles. */
type Turn =
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
  | { kind: "notification"; id: string; summary: string; status: string | null };

let idCounter = 0;
const nextId = () => `t${++idCounter}`;

/** Tool names that launch a sub-agent: `Task` (classic Claude Code), `Agent` (SDK). */
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

/** The send_file MCP tool; its payload renders as a rich `file` turn (issue #112). */
const SEND_FILE_TOOL_NAME = "mcp__paddock__send_file";

/** Background-task *ops* (badge only) — they operate on an already-detached task. */
const BACKGROUND_OP_TOOLS = new Set(["BashOutput", "TaskOutput", "TaskStop", "KillShell"]);
/** A `run_in_background` launch echoes this in its output ("…with ID: <id>"). */
const BG_LAUNCH_RE = /running in (?:the )?background with ID: [A-Za-z0-9]+/i;

/**
 * True when a tool call ran detached: a `Monitor`, a background-task op, or a
 * `run_in_background` launch (issue #230). Prefers the server-enriched `background`
 * flag (history), and falls back to sniffing the tool name/output so the live path
 * — whose WS frame carries no enrichment — still gets the badge.
 */
function isBackgroundTool(tool: ToolCall): boolean {
  if (tool.background) return true;
  if (tool.toolName === "Monitor" || BACKGROUND_OP_TOOLS.has(tool.toolName)) return true;
  return BG_LAUNCH_RE.test(tool.output ?? "");
}

/** Tailwind classes for a background task's status chip, by terminal state. */
function statusChipClass(status: string): string {
  switch (status) {
    case "completed":
      return "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300";
    case "killed":
    case "timed out":
      return "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300";
    case "running":
    case "persistent":
      return "bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300";
    default:
      return "bg-paddock-200/70 text-paddock-600 dark:bg-paddock-800 dark:text-paddock-300";
  }
}

/** Per-tool icon for a Paddock `paddock_manage` tool segment (issue #253). */
function paddockMcpIcon(tool: string) {
  switch (tool) {
    case "list_projects":
      return FolderIcon;
    case "create_chat":
      return PlusIcon;
    case "fork_chat":
    case "fork_chat_batch":
      return BranchIcon;
    case "send_message":
      return SendIcon;
    default:
      // list_chats, read_chat, and any future paddock tool.
      return ChatIcon;
  }
}

/**
 * Resolve a `mcp__paddock__send_file` tool call into a renderable SentFile by
 * parsing the JSON envelope the tool returns as its `output` (issue #112). This
 * is the single path for both live (`onToolCall`) and reload (`historyToTurn`):
 * the tool output is preserved verbatim on the live event AND by herdctl's
 * history parser, so a refresh renders identically. A real-file send carries an
 * opaque `attachmentId`; we point `rawUrl` at Paddock's attachment endpoint.
 * Returns null if the tool isn't ours or the output isn't a valid envelope
 * (caller falls back to the generic tool widget).
 */
function sentFileFromToolCall(tc: ToolCall): SentFile | null {
  if (tc.toolName !== SEND_FILE_TOOL_NAME || !tc.output) return null;
  let env: SentFileEnvelope;
  try {
    env = JSON.parse(tc.output) as SentFileEnvelope;
  } catch {
    return null;
  }
  if (!env || env.paddockSendFile !== 1 || typeof env.filename !== "string") return null;
  return {
    filename: env.filename,
    kind: env.kind,
    language: env.language,
    message: env.message,
    source: env.source,
    content: env.source === "inline" ? env.content : undefined,
    rawUrl:
      env.source === "file" && env.attachmentId
        ? api.chatFileRawUrl(env.attachmentId)
        : undefined,
  };
}

/**
 * Fetches a sub-agent's nested steps by its parent tool_use id (issue #37).
 * Provided per-chat (bound to slug + session); consumed by ToolBlock so every
 * depth of nesting can lazy-load through the same call. Null outside a chat.
 */
const SubagentFetchContext = createContext<
  ((toolUseId: string) => Promise<HistoryMessage[]>) | null
>(null);

/**
 * Builds a raw-file URL for an image `Read` rendered inline (issue #239). Bound to
 * the project slug; null for a scratch chat (no servable project-file endpoint), so
 * ToolBlock falls back to the generic block there.
 */
const ToolImageUrlContext = createContext<((relPath: string) => string) | null>(null);

/**
 * Keeper-chat recovery affordance wiring (issue #301, Layer 2), provided per-chat
 * and consumed by the `notification` turn renderer so a KILLED/STOPPED background
 * task can offer a one-click "Continue". `enabled` is the resolved
 * `recovery.surfaceKilledTask` (project override else instance default); `onContinue`
 * re-drives the hung keeper via the WS `chat:continue` action; `busy` disables the
 * button while a turn is already streaming (or the session id isn't known yet).
 * Null for a scratch chat (no keeper session to recover).
 */
interface RecoveryContextValue {
  enabled: boolean;
  busy: boolean;
  onContinue: () => void;
}
const RecoveryContext = createContext<RecoveryContextValue | null>(null);

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
   * For a HOOK chat (Epic G / G3, GG-6): the owning event hook's truthful-from-config
   * capability descriptor. When present, a read-only capability banner floats atop
   * the message history stating that this is a hook agent, its trigger event, and its
   * granted tools. Absent for every non-hook chat.
   */
  hook?: ChatHookInfo;
  /**
   * For a TRIGGER chat (Epic T / T4): the owning trigger's truthful-from-config
   * capability descriptor. When present, a read-only capability banner floats atop the
   * message history stating that this is a trigger agent, its type + firing condition,
   * and its granted tools. Absent for every non-trigger chat (the unified successor to
   * {@link hook}).
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
  hook,
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
        if (!meta.success && meta.error) setError(meta.error);
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
          {/* Read-only capability banner atop a TRIGGER chat (Epic T / T4) or a
              legacy HOOK chat (Epic G / G3, GG-6): a truthful-from-config statement of
              what this agent is + may do. A trigger banner supersedes the hook banner
              (they never co-occur — a chat's agent is one or the other). */}
          {trigger ? (
            <TriggerCapabilityBanner trigger={trigger} projectSlug={projectSlug} />
          ) : (
            hook && <HookCapabilityBanner hook={hook} projectSlug={projectSlug} />
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
                disabled={(!draft.trim() && attachments.length === 0) || uploading}
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
 * Issue #1/#188 — the "Preload project context" checkbox shown on a NEW project
 * chat's composer. When checked, the first turn injects the project's curated
 * OVERVIEW.md (current state) and CHANGELOG.md (history) as context. Disabled
 * (with an explanatory note) until a sweep has produced an overview.
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
          ? "Inject this project's curated OVERVIEW.md (current state) and CHANGELOG.md (history) as context on the first message of this new chat, so the agent starts already knowing the project's state and narrative."
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
        {available ? "(injects OVERVIEW.md + CHANGELOG.md)" : "(no overview yet)"}
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
  sessionUsage,
  forkParent,
  onOpenForkParent,
}: {
  models: ModelInfo[];
  model: string | null;
  onSelectModel: (id: string) => void;
  usage: ChatCompleteUsage | null;
  sessionUsage: ChatUsage | null;
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
      <SessionCost usage={sessionUsage} />
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
 * A compact "this chat has cost N tokens (~$X at API rates)" chip, sitting next
 * to the context meter (issue #152). Unlike the meter (last-turn context fill),
 * this is the chat's *cumulative* consumption. The headline shows the dollar
 * estimate when the model has known pricing, else the total token count; the
 * full breakdown is in the tooltip. Hidden until there's usage.
 */
function SessionCost({ usage }: { usage: ChatUsage | null }) {
  if (!usage || usage.totalTokens <= 0) return null;
  const headline = usage.costUsd != null ? `~${formatUsd(usage.costUsd)}` : formatTokens(usage.totalTokens);
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1"
      title={`Session so far: ${formatSessionUsage(usage)}`}
    >
      <span aria-hidden="true">·</span>
      <span>{headline}</span>
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
        {/* A static dot — the cycling phrase + the ring spinner already signal
            "alive"; the old `animate-ping` was a third perpetual 60fps animation
            (a continuous scale) running for the whole turn, dropped for cost. */}
        <span className="inline-flex h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
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

/**
 * A "conversation compacted" boundary for CC's post-`/compact` continuation
 * summary (issue #106). Shown as a centered divider — the reload-time equivalent
 * of the live "🗜️ Context compacted" note — with the (machine-generated) summary
 * text tucked behind a disclosure so nothing is lost but the chat no longer looks
 * like it ended on a stray user message.
 */
function CompactBoundary({ summary }: { summary: string }) {
  return (
    <div className="animate-fade-in py-1">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-3 text-xs text-ink-subtle dark:text-ink-dark/60">
          <span className="h-px flex-1 bg-paddock-200/70 dark:bg-paddock-800" />
          <span className="whitespace-nowrap">🗜️ conversation compacted</span>
          <span className="h-px flex-1 bg-paddock-200/70 dark:bg-paddock-800" />
        </summary>
        <div className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-paddock-50 px-3 py-2 text-xs text-ink-subtle ring-1 ring-paddock-200/70 dark:bg-paddock-950 dark:text-ink-dark/70 dark:ring-paddock-800">
          {summary}
        </div>
      </details>
    </div>
  );
}

/**
 * A subtle per-message attribution shown above a machine-injected user bubble
 * (issue #290) — the per-MESSAGE analog of the chat-list ProvenanceBadge (#267).
 * A human-typed turn renders none of this (its `sender` is absent), so the
 * transcript stays quiet and only the "who added this?" cases stand out:
 *
 *  - `chat`     — "↩ sent by <name>", linking to the sending chat so you can jump
 *                 to whoever injected it (a manager's report-back, a peer send).
 *  - `schedule` — "⏰ scheduled by <name>" (a schedule fired this turn).
 *  - `agent`    — "↩ sent by an agent" (a machine turn with no richer identity).
 */
function SenderAttribution({ sender }: { sender: MessageSender }) {
  const base =
    "mb-1 flex items-center gap-1 text-[11px] italic text-ink-subtle/80 dark:text-ink-dark/60";
  if (sender.kind === "schedule") {
    return (
      <div className={base} data-sender="schedule">
        <span aria-hidden>⏰</span>
        <span>
          scheduled by <span className="font-medium not-italic">{sender.name}</span>
        </span>
      </div>
    );
  }
  if (sender.kind === "hook") {
    return (
      <div className={base} data-sender="hook">
        <span aria-hidden>⚡</span>
        <span>
          triggered by hook <span className="font-medium not-italic">{sender.name}</span>
        </span>
      </div>
    );
  }
  if (sender.kind === "recovery") {
    return (
      <div className={base} data-sender="recovery">
        <span aria-hidden>⚠</span>
        <span>continued after a background task was terminated</span>
      </div>
    );
  }
  if (sender.kind === "agent") {
    return (
      <div className={base} data-sender="agent">
        <span aria-hidden>↩</span>
        <span>sent by an agent</span>
      </div>
    );
  }
  // chat — link to the sending chat so "who sent this?" is one click away.
  const label = sender.name?.trim() || sender.sessionId.slice(0, 8);
  return (
    <div className={base} data-sender="chat">
      <span aria-hidden>↩</span>
      <span>
        sent by{" "}
        <Link
          to={`/projects/${encodeURIComponent(sender.project)}/chat/${encodeURIComponent(
            sender.sessionId,
          )}`}
          className="font-medium not-italic text-accent hover:underline"
          title={`Open ${label} in ${sender.project}`}
        >
          {label}
        </Link>
      </span>
    </div>
  );
}

// Memoized so unchanged turns bail out of reconciliation when ChatPane state that
// is independent of the transcript churns — composer `draft` (every keystroke),
// streaming appends, the slash menu, connection/model state. `turns` are rebuilt
// (new refs) only when `msgs` changes, so on those unrelated updates every turn's
// prop reference is stable and memo turns the O(N)-per-keystroke reconcile into
// O(changed). (#148)
const TurnView = memo(function TurnView({ turn }: { turn: Turn }) {
  if (turn.kind === "user") {
    return (
      <div className="flex animate-fade-in flex-col items-end">
        {turn.sender ? <SenderAttribution sender={turn.sender} /> : null}
        {turn.attachments && turn.attachments.length > 0 ? (
          <MessageAttachments attachments={turn.attachments} />
        ) : null}
        {turn.content ? (
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm text-white shadow-sm">
            {turn.content}
          </div>
        ) : null}
      </div>
    );
  }
  if (turn.kind === "file") {
    return <SentFileBlock file={turn.file} />;
  }
  if (turn.kind === "tool") {
    return <ToolBlock tool={turn.tool} />;
  }
  if (turn.kind === "command") {
    // A slash-command echo (e.g. `/compact`) — a centered, unobtrusive chip, not
    // a user bubble of raw `<command-name>…` XML (issue #106).
    return (
      <div className="flex animate-fade-in justify-center">
        <span className="rounded-full bg-paddock-100 px-2.5 py-0.5 font-mono text-xs text-ink-subtle ring-1 ring-paddock-200/70 dark:bg-paddock-900 dark:text-ink-dark/70 dark:ring-paddock-800">
          {turn.command}
        </span>
      </div>
    );
  }
  if (turn.kind === "compact") {
    return <CompactBoundary summary={turn.summary} />;
  }
  if (turn.kind === "notification") {
    // A KILLED/STOPPED background task (issue #301): the turn-boundary-kill case
    // (herdctl#374) that leaves the keeper alive-but-idle. Render a distinct amber
    // "keeper is idle" affordance with a one-click Continue instead of the neutral
    // pill, so the silent hang is both visible and recoverable.
    if (isTerminatedTaskStatus(turn.status)) {
      return <KilledTaskNotice summary={turn.summary} />;
    }
    // An internal background-agent `<task-notification>` (issue #181): a subtle,
    // centered system-status line carrying the human-readable summary, never a
    // raw-XML user bubble. Full text on hover for the longer "stopped" variants.
    return (
      <div className="flex animate-fade-in justify-center">
        <span
          className="max-w-[85%] truncate rounded-full bg-paddock-50 px-2.5 py-0.5 text-xs italic text-ink-subtle/80 ring-1 ring-paddock-200/60 dark:bg-paddock-950 dark:text-ink-dark/60 dark:ring-paddock-800/70"
          title={turn.summary}
        >
          {turn.summary}
        </span>
      </div>
    );
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
});

function Dot({ delay }: { delay?: string }) {
  return (
    <span
      className="h-1.5 w-1.5 animate-bounce rounded-full bg-paddock-400"
      style={{ animationDelay: delay }}
    />
  );
}

/**
 * The Layer 2 recovery affordance (issue #301) shown for a KILLED/STOPPED
 * background-task notification: an amber panel stating the keeper was left idle
 * when its background task was terminated at the turn boundary, plus a one-click
 * "Continue" that re-drives it. The button is gated on the resolved
 * `recovery.surfaceKilledTask` (via {@link RecoveryContext}) — when Layer 2 is off,
 * or on a scratch chat (no keeper to recover), only the explanatory notice shows.
 * `busy` disables the button while a turn is already streaming.
 */
function KilledTaskNotice({ summary }: { summary: string }) {
  const recovery = useContext(RecoveryContext);
  const canContinue = Boolean(recovery?.enabled);
  const busy = Boolean(recovery?.busy);
  return (
    <div className="flex animate-fade-in justify-center" data-recovery="killed-task">
      <div className="flex max-w-[90%] flex-col gap-1.5 rounded-lg border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/50 dark:text-amber-200">
        <div className="flex items-start gap-1.5">
          <span aria-hidden className="leading-tight">
            ⚠
          </span>
          <span className="leading-snug">
            A background task was terminated at the turn boundary — the keeper is
            idle and will not continue on its own.
            <span className="mt-0.5 block text-[11px] text-amber-800/80 dark:text-amber-300/70">
              {summary}
            </span>
          </span>
        </div>
        {canContinue && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={recovery?.onContinue}
              disabled={busy}
              data-recovery-action="continue"
              className="rounded-md bg-amber-600 px-2.5 py-1 text-[11px] font-medium text-white shadow-sm transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-amber-700 dark:hover:bg-amber-600"
            >
              {busy ? "Continuing…" : "Continue"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ToolBlock({ tool }: { tool: ToolCall }) {
  // Paddock's own MCP tools (issue #253): a prettified name + brand badge for any
  // `mcp__…` tool (Phase 0), and a structured body parsed from the tool's JSON
  // output for the `paddock_manage` server (Phase 1). send_file is diverted to
  // SentFileBlock before this, so it never reaches here.
  const mcp = mcpToolInfo(tool.toolName);
  const paddockManage = parsePaddockManage(tool.toolName, tool.output);
  const PaddockIcon = mcp.isPaddock ? paddockMcpIcon(mcp.tool) : null;
  // The write actions (create/fork/send/batch) lead with a chat link worth seeing
  // without a click; the potentially long read results (list/read) start collapsed.
  const pmActionDefaultOpen =
    paddockManage != null &&
    (paddockManage.tool === "create_chat" ||
      paddockManage.tool === "fork_chat" ||
      paddockManage.tool === "send_message" ||
      paddockManage.tool === "fork_chat_batch");
  const [open, setOpen] = useState(pmActionDefaultOpen);
  const toolImageUrl = useContext(ToolImageUrlContext);
  // In-flight tool (#175): rendered before it completes — no output/duration
  // yet, just a "running…" affordance so a slow tool/subagent is visibly alive.
  const pending = Boolean(tool.pending);
  // For a sub-agent, show its actual run time (from its transcript) rather than
  // the near-instant launch time the Task/Agent tool_call itself records.
  const dur = formatDuration(tool.subagentDurationMs ?? tool.durationMs);
  // A sub-agent's estimated API-rate cost, priced server-side per-model (issue
  // #166). Rendered next to the duration; null when its model has no pricing.
  const cost = tool.subagentCostUsd != null ? `~${formatUsd(tool.subagentCostUsd)}` : null;
  const isSubagent = SUBAGENT_TOOLS.has(tool.toolName);
  // A detached tool (Monitor / bg Bash / background-task op) — a first-class class
  // distinct from a sub-agent, with a "background" badge + status chip (issue #230).
  const isBg = !isSubagent && isBackgroundTool(tool);
  const events = tool.monitorEvents ?? [];
  // Per-tool detail recovered from the raw `{input, toolUseResult}` sidecar (#237);
  // each is history-hydrated only and gates a richer treatment, else generic block.
  const diff = tool.editDiff;
  const isEdit = Boolean(diff);
  const readInfo = tool.toolName === "Read" ? tool.readInfo : undefined;
  // An image Read that resolves inside the project dir → render it inline (#239).
  const imageUrl =
    readInfo?.isImage && readInfo.projectRelPath && toolImageUrl
      ? toolImageUrl(readInfo.projectRelPath)
      : null;
  const bash = tool.toolName === "Bash" ? tool.bashDetails : undefined;
  const search = tool.searchInfo;
  const taskUpdate = tool.toolName === "TaskUpdate" ? tool.taskUpdate : undefined;
  const taskCreate = tool.toolName === "TaskCreate" ? tool.taskCreate : undefined;
  // Bash renders a split body only when there's a stderr to peel off; otherwise the
  // generic output pre still handles it (we don't duplicate every clean call).
  const bashSplit = Boolean(bash && bash.stderr);
  const searchCount = search ? searchCountLabel(search) : null;
  const readRange = readInfo ? readRangeLabel(readInfo) : null;
  // Expandable-into-steps only when the sub-agent's transcript is on disk — never
  // while pending (the transcript doesn't exist until it produces output, #175).
  const expandable = Boolean(!pending && isSubagent && tool.hasSubagent && tool.toolUseId);
  // Sub-agent header reads as "<type> — <description>"; the detail-bearing tools show
  // a friendlier subtitle; others keep the classic "<toolName> <inputSummary>".
  const label = isSubagent
    ? (tool.subagentType ?? tool.toolName)
    : mcp.isMcp
      ? mcp.display
      : tool.toolName;
  const subtitle = isSubagent
    ? tool.description
    : paddockManage
      ? paddockManageSummary(paddockManage)
      : isEdit
        ? (diff!.filePath?.split("/").pop() ?? diff!.filePath)
        : readInfo
          ? (readInfo.basename ?? readInfo.filePath ?? tool.inputSummary)
          : taskCreate
            ? taskCreate.subject
            : tool.inputSummary;
  // Full path/text on hover — fixes the long-path header cutoff for Read (#237).
  const subtitleTitle = readInfo?.filePath ?? taskCreate?.description ?? subtitle ?? undefined;
  return (
    <div className="flex justify-start">
      <div
        className={`w-full max-w-[92%] overflow-hidden rounded-xl border text-xs transition-colors ${
          tool.isError
            ? "border-rose-300/70 bg-rose-50/60 dark:border-rose-900/60 dark:bg-rose-950/30"
            : isSubagent
              ? "border-accent/40 bg-accent/[0.06] dark:border-accent/40 dark:bg-accent/10"
              : isBg
                ? "border-sky-300/50 bg-sky-50/40 dark:border-sky-900/50 dark:bg-sky-950/20"
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
          ) : isBg ? (
            <ClockIcon
              width={13}
              height={13}
              className={`shrink-0 ${tool.isError ? "text-rose-500" : "text-sky-600 dark:text-sky-400"}`}
            />
          ) : PaddockIcon ? (
            <PaddockIcon
              width={13}
              height={13}
              className={`shrink-0 ${tool.isError ? "text-rose-500" : "text-accent"}`}
            />
          ) : isEdit ? (
            <PencilIcon
              width={13}
              height={13}
              className={`shrink-0 ${tool.isError ? "text-rose-500" : "text-paddock-500"}`}
            />
          ) : readInfo ? (
            <FileIcon
              width={13}
              height={13}
              className={`shrink-0 ${tool.isError ? "text-rose-500" : "text-paddock-500"}`}
            />
          ) : search ? (
            <SearchIcon
              width={13}
              height={13}
              className={`shrink-0 ${tool.isError ? "text-rose-500" : "text-paddock-500"}`}
            />
          ) : taskUpdate || taskCreate ? (
            <CheckIcon
              width={13}
              height={13}
              className={`shrink-0 ${tool.isError ? "text-rose-500" : "text-paddock-500"}`}
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
          {isBg && (
            <span className="shrink-0 whitespace-nowrap rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">
              background
            </span>
          )}
          {mcp.isPaddock && (
            // Paddock's own injected MCP tool — a brand badge so it reads as a
            // first-class Paddock action, not a random tool (issue #253).
            <span className="shrink-0 whitespace-nowrap rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
              Paddock
            </span>
          )}
          {mcp.isMcp && !mcp.isPaddock && (
            <span className="shrink-0 whitespace-nowrap rounded bg-paddock-200/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-paddock-600 dark:bg-paddock-800 dark:text-paddock-300">
              MCP
            </span>
          )}
          {taskUpdate ? (
            // A TaskUpdate status transition: colored from → to pills (#237).
            <span className="flex min-w-0 items-center gap-1.5 truncate font-mono text-paddock-500 dark:text-paddock-400">
              {taskUpdate.taskId && <span className="shrink-0">Task #{taskUpdate.taskId}</span>}
              {taskUpdate.from && taskUpdate.to ? (
                <span className="flex shrink-0 items-center gap-1">
                  <TaskStatusPill status={taskUpdate.from} />
                  <span className="text-paddock-400">→</span>
                  <TaskStatusPill status={taskUpdate.to} />
                </span>
              ) : (
                taskUpdate.updatedFields && (
                  <span className="shrink-0 truncate">{taskUpdate.updatedFields.join(", ")}</span>
                )
              )}
            </span>
          ) : (
            subtitle && (
              <span
                className="min-w-0 truncate font-mono text-paddock-500 dark:text-paddock-400"
                title={subtitleTitle}
              >
                {subtitle}
              </span>
            )
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {tool.isError && (
              <span className="rounded bg-rose-200/70 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 dark:bg-rose-900/60 dark:text-rose-300">
                error
              </span>
            )}
            {pending ? (
              // In-flight tool (#175): a spinner + "running" instead of the
              // completion metadata (events/status/diff/duration) it lacks yet.
              <span className="flex items-center gap-1.5 text-accent" title="Tool is running">
                <span
                  className="h-3 w-3 animate-spin rounded-full border-2 border-accent/30 border-t-accent"
                  aria-hidden="true"
                />
                <span className="text-[10px] font-semibold uppercase tracking-wide">running</span>
              </span>
            ) : (
              <>
                {isBg && events.length > 0 && (
                  <span className="whitespace-nowrap text-[10px] text-sky-600 dark:text-sky-400">
                    {events.length} event{events.length === 1 ? "" : "s"}
                  </span>
                )}
                {isBg && tool.taskStatus && (
                  <span
                    className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold ${statusChipClass(
                      tool.taskStatus,
                    )}`}
                  >
                    {tool.taskStatus}
                  </span>
                )}
                {isEdit && (diff!.additions > 0 || diff!.deletions > 0) && (
                  <span className="whitespace-nowrap font-mono text-[10px] font-semibold tabular-nums">
                    {diff!.additions > 0 && (
                      <span className="text-emerald-600 dark:text-emerald-400">+{diff!.additions}</span>
                    )}
                    {diff!.additions > 0 && diff!.deletions > 0 && " "}
                    {diff!.deletions > 0 && (
                      <span className="text-rose-600 dark:text-rose-400">−{diff!.deletions}</span>
                    )}
                  </span>
                )}
                {readRange && (
                  <span className="whitespace-nowrap font-mono text-[10px] text-paddock-400 tabular-nums">
                    {readRange}
                  </span>
                )}
                {searchCount && (
                  <span className="whitespace-nowrap font-mono text-[10px] font-medium text-paddock-500 tabular-nums dark:text-paddock-400">
                    {searchCount}
                  </span>
                )}
                {bash?.gitHint && (
                  <span className="whitespace-nowrap rounded bg-paddock-200/70 px-1.5 py-0.5 font-mono text-[10px] text-paddock-600 dark:bg-paddock-800 dark:text-paddock-300">
                    {bash.gitHint}
                  </span>
                )}
                {bash?.interrupted && (
                  <span className="whitespace-nowrap rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
                    interrupted
                  </span>
                )}
                {bash?.returnCodeInterpretation && (
                  <span className="max-w-[12rem] truncate whitespace-nowrap text-[10px] italic text-paddock-400">
                    {bash.returnCodeInterpretation}
                  </span>
                )}
                {dur && <span className="text-paddock-400">{dur}</span>}
                {cost && <span className="text-paddock-400">{cost}</span>}
              </>
            )}
          </span>
        </button>
        {open &&
          (expandable ? (
            <NestedSteps toolUseId={tool.toolUseId!} />
          ) : isBg && events.length > 0 ? (
            // Monitor: the streamed events, grouped under the launching call
            // instead of scattered as separate pills (issue #230).
            <div className="max-h-72 overflow-auto border-t border-sky-200/60 bg-sky-50/40 dark:border-sky-900/50 dark:bg-sky-950/20">
              {events.map((e, i) => (
                <div
                  key={i}
                  className="whitespace-pre-wrap break-words border-b border-sky-200/40 px-3 py-1.5 font-mono text-[11.5px] leading-relaxed text-paddock-700 last:border-b-0 dark:border-sky-900/40 dark:text-paddock-300"
                >
                  {e}
                </div>
              ))}
            </div>
          ) : paddockManage ? (
            <PaddockManageBody data={paddockManage} />
          ) : isEdit ? (
            <DiffBody diff={diff!} />
          ) : imageUrl ? (
            <div className="border-t border-paddock-200/70 dark:border-paddock-800">
              <InlineImage src={imageUrl} filename={readInfo?.basename ?? "image"} />
            </div>
          ) : bashSplit ? (
            <BashBody bash={bash!} />
          ) : taskCreate && taskCreate.description ? (
            <TaskCreateBody info={taskCreate} />
          ) : (
            <div className="border-t border-paddock-200/70 dark:border-paddock-800">
              {isBg && tool.taskResultSummary && (
                <div className="border-b border-paddock-200/70 bg-sky-50/50 px-3 py-2 text-[11.5px] font-medium text-paddock-700 dark:border-paddock-800 dark:bg-sky-950/20 dark:text-paddock-200">
                  {tool.taskResultSummary}
                </div>
              )}
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words bg-paddock-50/80 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-paddock-700 dark:bg-paddock-950/60 dark:text-paddock-300">
                {pending ? "Running…" : tool.output || "(no output)"}
              </pre>
            </div>
          ))}
      </div>
    </div>
  );
}

/** Line coloring for a diff line by its kind (`+` add, `-` del, ` ` context). */
function diffLineClass(t: "+" | "-" | " "): string {
  if (t === "+") return "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300";
  if (t === "-") return "bg-rose-50 text-rose-800 dark:bg-rose-950/30 dark:text-rose-300";
  return "text-paddock-600 dark:text-paddock-400";
}

/** Right-align a line number into the fixed-width gutter cell (blank when absent). */
function gutter(n?: number): string {
  return n === undefined ? "" : String(n);
}

/**
 * The inline diff for an Edit/MultiEdit/Write tool call (issue #232 → #237): each
 * hunk rendered with a real `@@ -old +new @@` header, an old/new line-number gutter
 * (from `toolUseResult.structuredPatch`), and the +/- green/red tint. Height-capped
 * + scrollable; a truncated diff notes the cut.
 */
function DiffBody({ diff }: { diff: EditDiff }) {
  return (
    <div className="max-h-96 overflow-auto border-t border-paddock-200/70 bg-paddock-50/80 font-mono text-[11.5px] leading-relaxed dark:border-paddock-800 dark:bg-paddock-950/60">
      {diff.hunks.map((h, hi) => (
        <div
          key={hi}
          className={hi > 0 ? "border-t border-paddock-200/60 dark:border-paddock-800/60" : ""}
        >
          <div className="bg-paddock-100/70 px-3 py-1 font-mono text-[10px] font-semibold text-sky-700/80 dark:bg-paddock-900/50 dark:text-sky-400/80">
            @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
          </div>
          {h.lines.map((l, li) => (
            <div key={li} className={`flex ${diffLineClass(l.t)}`}>
              <span className="w-8 shrink-0 select-none pr-1 text-right tabular-nums opacity-40">
                {gutter(l.oldLine)}
              </span>
              <span className="w-8 shrink-0 select-none pr-1 text-right tabular-nums opacity-40">
                {gutter(l.newLine)}
              </span>
              <span className="w-3 shrink-0 select-none text-center opacity-60">
                {l.t === " " ? "" : l.t}
              </span>
              <span className="whitespace-pre-wrap break-words pr-3">{l.text || " "}</span>
            </div>
          ))}
        </div>
      ))}
      {diff.truncated && (
        <div className="px-3 py-1.5 text-[11px] italic text-paddock-400">
          … diff truncated (see the file for the full change)
        </div>
      )}
    </div>
  );
}

/** Tailwind classes for a task-status pill, by state (issue #237). */
function taskStatusPillClass(status: string): string {
  switch (status) {
    case "completed":
    case "done":
      return "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300";
    case "in_progress":
      return "bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300";
    case "blocked":
    case "failed":
    case "cancelled":
      return "bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300";
    default: // pending & anything else
      return "bg-paddock-200/70 text-paddock-600 dark:bg-paddock-800 dark:text-paddock-300";
  }
}

/** A small colored pill for one task status value (e.g. `pending`, `in_progress`). */
function TaskStatusPill({ status }: { status: string }) {
  return (
    <span
      className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold ${taskStatusPillClass(
        status,
      )}`}
    >
      {status}
    </span>
  );
}

/** The count chip text for a Grep/Glob search result (issue #237). */
function searchCountLabel(s: SearchInfo): string | null {
  const parts: string[] = [];
  if (s.kind === "grep") {
    if (s.numLines !== undefined) parts.push(`${s.numLines} line${s.numLines === 1 ? "" : "s"}`);
    if (s.numFiles !== undefined) parts.push(`${s.numFiles} file${s.numFiles === 1 ? "" : "s"}`);
  } else {
    const n = s.totalMatches ?? s.numFiles;
    if (n !== undefined) parts.push(`${n} match${n === 1 ? "" : "es"}`);
  }
  if (!parts.length) return null;
  return (s.truncated ? "≥" : "") + parts.join(" · ");
}

/** The `lines a–b of N` range chip text for a Read (issue #237). */
function readRangeLabel(r: ReadInfo): string | null {
  if (r.startLine === undefined || r.numLines === undefined) return null;
  const end = r.startLine + Math.max(0, r.numLines - 1);
  const of = r.totalLines !== undefined ? ` of ${r.totalLines}` : "";
  return `lines ${r.startLine}–${end}${of}`;
}

/**
 * A Bash body that splits stdout (plain) from stderr (red), instead of the merged
 * output herdctl produces (issue #237). Only used when there IS a stderr to peel.
 */
function BashBody({ bash }: { bash: BashDetails }) {
  return (
    <div className="max-h-72 overflow-auto border-t border-paddock-200/70 dark:border-paddock-800">
      {bash.stdout && (
        <pre className="whitespace-pre-wrap break-words bg-paddock-50/80 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-paddock-700 dark:bg-paddock-950/60 dark:text-paddock-300">
          {bash.stdout}
        </pre>
      )}
      {bash.stderr && (
        <pre className="whitespace-pre-wrap break-words border-t border-rose-200/50 bg-rose-50/50 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-rose-700 first:border-t-0 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-300">
          {bash.stderr}
        </pre>
      )}
    </div>
  );
}

/** A TaskCreate body: the task subject + description text (issue #237). */
function TaskCreateBody({ info }: { info: TaskCreateInfo }) {
  return (
    <div className="border-t border-paddock-200/70 bg-paddock-50/80 px-3 py-2 dark:border-paddock-800 dark:bg-paddock-950/60">
      {info.subject && (
        <div className="text-[12px] font-semibold text-paddock-700 dark:text-paddock-200">
          {info.subject}
        </div>
      )}
      {info.description && (
        <div className="mt-1 whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-paddock-600 dark:text-paddock-400">
          {info.description}
        </div>
      )}
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

  const turns = useMemo(() => historyToTurns(msgs ?? []), [msgs]);

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

/**
 * Clear the `pending` flag on any in-flight tool rows (#175) that never received
 * a reconciling `chat:tool_call`. Called when a turn ends (complete/error/stop):
 * by then every legitimate completion has already reconciled its row, so any row
 * still pending is orphaned — a lost completion (killed turn) or a tool whose
 * result never reaches the main stream (e.g. a subagent's nested step, which
 * herdctl streams via a separate sidechain session). Settling it stops the
 * spinner from spinning forever; the row renders as a plain finished tool.
 */
function settlePending(prev: Turn[]): Turn[] {
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
function historyToTurn(m: HistoryMessage, id: string): Turn {
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

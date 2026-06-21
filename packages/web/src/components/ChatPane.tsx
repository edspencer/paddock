import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { chatClient, type ConnectionState, type ToolCall } from "../lib/ws";
import { Markdown } from "./Markdown";
import { formatDuration } from "../lib/format";
import {
  AlertIcon,
  ChevronRightIcon,
  SendIcon,
  SparkIcon,
  StopIcon,
  WrenchIcon,
} from "./icons";
import type { HistoryMessage } from "../lib/types";

/** One rendered item in the transcript. Assistant boundaries split bubbles. */
type Turn =
  | { kind: "user"; id: string; content: string }
  | { kind: "assistant"; id: string; content: string; streaming: boolean }
  | { kind: "tool"; id: string; tool: ToolCall };

let idCounter = 0;
const nextId = () => `t${++idCounter}`;

export interface ChatPaneProps {
  /** Project slug, or "scratch" for one-off chats. */
  projectSlug: string;
  /** Existing session to resume, or undefined for a new chat. */
  initialSessionId?: string;
  /** Loads the transcript for a resumed session. */
  loadHistory?: (sessionId: string) => Promise<HistoryMessage[]>;
  /** Called when a brand-new chat first gets a real session id (to refresh lists). */
  onSessionEstablished?: (sessionId: string) => void;
  /** Called whenever a turn completes (pull model: re-fetch project/files for sweeps). */
  onTurnComplete?: () => void;
  /** True for a project chat (vs. a one-off scratch chat). Gates the preload checkbox. */
  isProjectChat?: boolean;
  /** Whether the project has an OVERVIEW.md to preload (issue #1). */
  preloadAvailable?: boolean;
  emptyHint?: string;
  placeholder?: string;
}

export function ChatPane({
  projectSlug,
  initialSessionId,
  loadHistory,
  onSessionEstablished,
  onTurnComplete,
  isProjectChat = false,
  preloadAvailable = false,
  emptyHint,
  placeholder,
}: ChatPaneProps) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [hydrating, setHydrating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conn, setConn] = useState<ConnectionState>(chatClient.state);

  // Issue #1: preload the project's curated OVERVIEW.md as context on the FIRST
  // turn of a new project chat. Default ON for project chats. Only sent on the
  // first message of a never-resumed session (the server ignores it otherwise).
  const [preloadContext, setPreloadContext] = useState(true);
  const showPreload = isProjectChat && !initialSessionId;
  // The checkbox only has an effect once a turn has been sent on a brand-new chat.
  const firstTurnSentRef = useRef(false);

  // Session id is kept in a ref (the WS sub needs the latest without re-subscribing).
  const sessionRef = useRef<string | null>(initialSessionId ?? null);
  const jobRef = useRef<string | null>(null);
  const isNewSessionRef = useRef<boolean>(!initialSessionId);

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

  // --- hydrate a resumed session --------------------------------------------
  useEffect(() => {
    let cancelled = false;
    sessionRef.current = initialSessionId ?? null;
    isNewSessionRef.current = !initialSessionId;
    jobRef.current = null;
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
    return () => {
      cancelled = true;
    };
  }, [projectSlug, initialSessionId, loadHistory]);

  // --- subscribe to the shared socket for this chat -------------------------
  useEffect(() => {
    const sub = chatClient.subscribe(projectSlug, sessionRef.current, {
      onResponse: (chunk, meta) => {
        if (meta.jobId) jobRef.current = meta.jobId;
        if (meta.sessionId) {
          sessionRef.current = meta.sessionId;
          sub.setSessionId(meta.sessionId);
        }
        appendAssistantText(setTurns, chunk);
      },
      onToolCall: (tc, meta) => {
        if (meta.jobId) jobRef.current = meta.jobId;
        setTurns((prev) => [...prev, { kind: "tool", id: nextId(), tool: tc }]);
      },
      onMessageBoundary: (meta) => {
        if (meta.jobId) jobRef.current = meta.jobId;
        // Seal the current streaming bubble so the next assistant message
        // renders as a separate turn.
        setTurns((prev) => sealStreaming(prev));
      },
      onComplete: (meta) => {
        if (meta.jobId) jobRef.current = meta.jobId;
        setStreaming(false);
        setTurns((prev) => sealStreaming(prev));
        if (meta.sessionId) {
          const wasNew = isNewSessionRef.current && sessionRef.current !== meta.sessionId;
          sessionRef.current = meta.sessionId;
          sub.setSessionId(meta.sessionId);
          if (wasNew || isNewSessionRef.current) {
            isNewSessionRef.current = false;
            onSessionEstablished?.(meta.sessionId);
          }
        }
        if (!meta.success && meta.error) setError(meta.error);
        // Pull model: a completed turn may have triggered a sweep that rewrote
        // OVERVIEW.md / CHANGELOG / added files — let the parent re-fetch.
        onTurnComplete?.();
      },
      onError: (err) => {
        setStreaming(false);
        jobRef.current = null;
        setTurns((prev) => sealStreaming(prev));
        setError(err);
      },
    });
    return () => {
      sub.unsubscribe();
    };
    // Re-subscribe when the chat identity changes.
  }, [projectSlug, initialSessionId, onSessionEstablished, onTurnComplete]);

  // --- send / cancel ---------------------------------------------------------
  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || streaming) return;
    setError(null);
    pinnedRef.current = true;
    setTurns((prev) => [
      ...sealStreaming(prev),
      { kind: "user", id: nextId(), content: text },
    ]);
    setDraft("");
    setStreaming(true);
    // Preload only applies to the very first turn of a never-resumed chat.
    const isFirstTurnOfNewChat = isNewSessionRef.current && !firstTurnSentRef.current;
    const preload = isProjectChat && isFirstTurnOfNewChat && preloadContext;
    firstTurnSentRef.current = true;
    chatClient.send(projectSlug, text, sessionRef.current, { preloadContext: preload });
  }, [draft, streaming, projectSlug, isProjectChat, preloadContext]);

  const cancel = useCallback(() => {
    // jobId is captured off event metadata in the handlers below. The server
    // emits chat:complete/error on cancel; the UI unlocks there.
    if (jobRef.current) chatClient.cancel(jobRef.current);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const empty = turns.length === 0 && !hydrating;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* transcript */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto"
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

          <div className="space-y-4">
            {turns.map((t) => (
              <TurnView key={t.id} turn={t} />
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="mx-auto mb-2 flex w-full max-w-3xl items-start gap-2 px-4">
          <div className="flex w-full items-start gap-2 rounded-lg border border-rose-300/60 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/50 dark:text-rose-300">
            <AlertIcon width={16} height={16} className="mt-0.5 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        </div>
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
          <div className="flex items-end gap-2 rounded-2xl border border-paddock-300 bg-white p-2 shadow-sm focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20 dark:border-paddock-700 dark:bg-paddock-900">
            <textarea
              className="max-h-48 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-paddock-400 dark:placeholder:text-paddock-600"
              rows={1}
              value={draft}
              placeholder={placeholder ?? "Message the keeper agent…"}
              onChange={(e) => {
                setDraft(e.target.value);
                const el = e.target;
                el.style.height = "auto";
                el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
              }}
              onKeyDown={onKeyDown}
            />
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
              <kbd className="font-sans">Enter</kbd> to send ·{" "}
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
  const dur = formatDuration(tool.durationMs);
  return (
    <div className="flex justify-start">
      <div
        className={`w-full max-w-[92%] overflow-hidden rounded-xl border text-xs transition-colors ${
          tool.isError
            ? "border-rose-300/70 bg-rose-50/60 dark:border-rose-900/60 dark:bg-rose-950/30"
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
          <WrenchIcon
            width={13}
            height={13}
            className={tool.isError ? "text-rose-500" : "text-paddock-500"}
          />
          <span className="font-mono font-semibold text-paddock-700 dark:text-paddock-200">
            {tool.toolName}
          </span>
          {tool.inputSummary && (
            <span className="truncate font-mono text-paddock-500 dark:text-paddock-400">
              {tool.inputSummary}
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
        {open && (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-paddock-200/70 bg-paddock-50/80 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-paddock-700 dark:border-paddock-800 dark:bg-paddock-950/60 dark:text-paddock-300">
            {tool.output || "(no output)"}
          </pre>
        )}
      </div>
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

/** Mark any trailing streaming assistant bubble as finished. */
function sealStreaming(prev: Turn[]): Turn[] {
  const last = prev[prev.length - 1];
  if (last && last.kind === "assistant" && last.streaming) {
    return [...prev.slice(0, -1), { ...last, streaming: false }];
  }
  return prev;
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

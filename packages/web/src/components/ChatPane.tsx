import { useEffect, useMemo, useRef, useState } from "react";
import { ChatSocket } from "../lib/ws";

interface Turn {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  isError?: boolean;
}

/**
 * A self-contained chat pane that streams over the paddock WS protocol.
 * `target` is a project slug, or "__adhoc__" for one-off chats.
 */
export function ChatPane({
  target,
  initialSessionId,
  title,
}: {
  target: string;
  initialSessionId?: string;
  title?: string;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>(initialSessionId);
  const [connected, setConnected] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const sock = useMemo(() => new ChatSocket(), []);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Reset when switching target/session.
  useEffect(() => {
    setTurns([]);
    setSessionId(initialSessionId);
  }, [target, initialSessionId]);

  useEffect(() => {
    sock.onOpen = () => setConnected(true);
    sock.onClose = () => setConnected(false);
    sock.onResponse = (chunk, meta) => {
      if (meta.sessionId) setSessionId(meta.sessionId);
      setTurns((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === "assistant") {
          return [...prev.slice(0, -1), { ...last, content: last.content + chunk }];
        }
        return [...prev, { role: "assistant", content: chunk }];
      });
    };
    sock.onToolCall = (tc) => {
      setTurns((prev) => [
        ...prev,
        {
          role: "tool",
          toolName: tc.toolName,
          content: tc.output || tc.inputSummary || "",
          isError: tc.isError,
        },
      ]);
    };
    sock.onComplete = (meta) => {
      setStreaming(false);
      if (meta.sessionId) setSessionId(meta.sessionId);
      if (!meta.success && meta.error) setBanner(meta.error);
    };
    sock.onError = (err) => {
      setStreaming(false);
      setBanner(err);
    };
    sock.connect();
    return () => sock.close();
  }, [sock]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || streaming) return;
    setTurns((prev) => [...prev, { role: "user", content: text }]);
    setDraft("");
    setStreaming(true);
    setBanner(null);
    sock.send({ target, message: text, sessionId });
  };

  return (
    <div className="flex h-full flex-col">
      {title && (
        <div className="flex items-center justify-between border-b border-paddock-200 px-4 py-2 text-sm dark:border-paddock-800">
          <span className="font-medium">{title}</span>
          <span className="text-xs text-paddock-500">
            {connected ? "● connected" : "○ offline"}
            {sessionId ? ` · ${sessionId.slice(0, 8)}` : " · new chat"}
          </span>
        </div>
      )}

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {turns.length === 0 && (
          <p className="mt-8 text-center text-sm text-paddock-500">
            Start the conversation. Messages stream from the project's keeper agent.
          </p>
        )}
        {turns.map((t, i) => (
          <Bubble key={i} turn={t} />
        ))}
        <div ref={bottomRef} />
      </div>

      {banner && (
        <div className="mx-4 mb-2 rounded-lg bg-rose-100 px-3 py-2 text-sm text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">
          {banner}
        </div>
      )}

      <form onSubmit={submit} className="border-t border-paddock-200 p-3 dark:border-paddock-800">
        <div className="flex items-end gap-2">
          <textarea
            className="min-h-[44px] flex-1 resize-none rounded-lg border border-paddock-300 bg-paddock-50 px-3 py-2 text-sm outline-none focus:border-paddock-500 dark:border-paddock-700 dark:bg-paddock-950"
            rows={1}
            value={draft}
            placeholder="Message the keeper agent…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) submit(e);
            }}
          />
          <button type="submit" className="btn-primary" disabled={streaming || !draft.trim()}>
            {streaming ? "…" : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Bubble({ turn }: { turn: Turn }) {
  if (turn.role === "tool") {
    return (
      <div className="rounded-lg border border-paddock-200 bg-paddock-100/60 px-3 py-2 text-xs dark:border-paddock-800 dark:bg-paddock-900/60">
        <span
          className={`font-mono font-semibold ${
            turn.isError ? "text-rose-600 dark:text-rose-400" : "text-paddock-600 dark:text-paddock-300"
          }`}
        >
          🔧 {turn.toolName}
        </span>
        {turn.content && (
          <pre className="mt-1 whitespace-pre-wrap break-words text-paddock-600 dark:text-paddock-400">
            {turn.content.slice(0, 1000)}
          </pre>
        )}
      </div>
    );
  }
  const isUser = turn.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm ${
          isUser
            ? "bg-paddock-600 text-white"
            : "bg-paddock-100 text-paddock-900 dark:bg-paddock-800 dark:text-paddock-100"
        }`}
      >
        {turn.content}
      </div>
    </div>
  );
}

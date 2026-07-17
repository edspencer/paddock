// Rich expanded bodies for Paddock's own `mcp__paddock_manage__*` tools (issue
// #253). Every payload carries a `{project, sessionId}` pair and the chat route
// is `/projects/:slug/chat/:sessionId`, so results become real links into the
// spawned/inspected chats — the write tools' whole point. Parsed client-side
// from the tool's JSON output (see lib/mcpTools.ts).

import { createContext, useContext } from "react";
import { Link } from "react-router-dom";
import { chatTitle, type PaddockManage, type PmChat } from "../lib/mcpTools";
import { LinkIcon } from "./icons";

/**
 * The slug of the project the current chat lives in. `fork_chat_batch`'s result
 * payload omits a project (the forks inherit the source chat's project), so its
 * child links fall back to this. Provided by ChatPane around the transcript.
 */
export const PaddockManageProjectContext = createContext<string | null>(null);

const chatHref = (project: string, sessionId: string): string =>
  `/projects/${encodeURIComponent(project)}/chat/${encodeURIComponent(sessionId)}`;

const shortId = (id: string): string => (id.length > 8 ? `${id.slice(0, 8)}…` : id);

/** A pill that navigates to a Paddock chat (client-side route change). */
function ChatLink({
  project,
  sessionId,
  label,
}: {
  project: string;
  sessionId: string;
  label?: string;
}) {
  return (
    <Link
      to={chatHref(project, sessionId)}
      className="inline-flex items-center gap-1 rounded-md bg-accent/10 px-2 py-0.5 font-mono text-[11px] font-medium text-accent no-underline ring-1 ring-accent/20 transition-colors hover:bg-accent/20 dark:bg-accent/15"
      title={`Open ${sessionId}`}
    >
      <LinkIcon width={10} height={10} className="shrink-0" />
      {label ?? shortId(sessionId)}
    </Link>
  );
}

const wrap = "border-t border-paddock-200/70 px-3 py-2.5 dark:border-paddock-800";
const rowKey = "text-paddock-500 dark:text-paddock-400";

/** Small colored status/area chip. */
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-paddock-200/70 px-1.5 py-0.5 text-[10px] font-medium text-paddock-600 dark:bg-paddock-800 dark:text-paddock-300">
      {children}
    </span>
  );
}

/** A labelled block of prompt/message text (kickoff prompt, or a sent message). */
function PromptBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="mt-2">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-paddock-400">
        {label}
      </div>
      <div className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-paddock-100/70 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-paddock-700 dark:bg-paddock-900/60 dark:text-paddock-300">
        {text}
      </div>
    </div>
  );
}

function ChatRow({ chat }: { chat: PmChat }) {
  return (
    <li className="flex items-center gap-2 py-1">
      {chat.running ? (
        <span
          className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500"
          title="running"
        />
      ) : (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-paddock-300 dark:bg-paddock-700" />
      )}
      <span className="min-w-0 flex-1 truncate text-paddock-700 dark:text-paddock-200">
        {chat.name || "(untitled)"}
      </span>
      <ChatLink project={chat.project} sessionId={chat.sessionId} />
    </li>
  );
}

/** The expanded body for a parsed paddock_manage result. */
export function PaddockManageBody({ data }: { data: PaddockManage }) {
  // Fallback project for links whose payload omits one (fork_chat_batch forks).
  const ctxProject = useContext(PaddockManageProjectContext) ?? "";
  switch (data.tool) {
    case "list_projects":
      return (
        <div className={wrap}>
          <ul className="flex flex-wrap gap-1.5">
            {data.projects.map((p) => (
              <li
                key={p.slug}
                className="flex items-center gap-1.5 rounded-md bg-paddock-100/70 px-2 py-1 dark:bg-paddock-900/60"
              >
                <span className="text-[11.5px] font-medium text-paddock-700 dark:text-paddock-200">
                  {p.name}
                </span>
                {p.area && <Chip>{p.area}</Chip>}
                {p.status && p.status !== "active" && <Chip>{p.status}</Chip>}
              </li>
            ))}
          </ul>
        </div>
      );

    case "list_chats":
      return (
        <div className={wrap}>
          <ul className="max-h-72 divide-y divide-paddock-200/50 overflow-auto text-[11.5px] dark:divide-paddock-800/60">
            {data.chats.map((c) => (
              <ChatRow key={c.sessionId} chat={c} />
            ))}
          </ul>
        </div>
      );

    case "read_chat":
      return (
        <div className={wrap}>
          <div className="mb-2 flex items-center gap-2 text-[11px]">
            <span className={rowKey}>
              {data.returned} of {data.total} messages
            </span>
            <ChatLink project={data.project} sessionId={data.sessionId} label="open chat" />
          </div>
          <ul className="max-h-72 space-y-1.5 overflow-auto">
            {data.messages.map((m, i) => (
              <li key={i} className="text-[11.5px] leading-relaxed">
                <span
                  className={`mr-1.5 font-mono text-[10px] font-semibold uppercase ${
                    m.role === "assistant" ? "text-accent" : "text-paddock-400"
                  }`}
                >
                  {m.role}
                </span>
                <span className="whitespace-pre-wrap break-words text-paddock-700 dark:text-paddock-300">
                  {m.text}
                </span>
              </li>
            ))}
          </ul>
        </div>
      );

    case "create_chat":
    case "fork_chat": {
      const verb = data.tool === "create_chat" ? "Created chat" : "Forked chat";
      const title = chatTitle(data.name, data.prompt);
      return (
        <div className={wrap}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]">
            <span className={rowKey}>{verb}</span>
            <span className="font-medium text-paddock-800 dark:text-paddock-100">{title}</span>
            <span className={rowKey}>in {data.project}</span>
            {data.tool === "fork_chat" && data.from && (
              <span className={`font-mono ${rowKey}`}>from {shortId(data.from)}</span>
            )}
            <ChatLink project={data.project} sessionId={data.sessionId} label="open chat" />
          </div>
          {/* The kickoff prompt, when it isn't already the title (i.e. a name was set). */}
          {data.prompt && data.name && <PromptBlock label="Kickoff" text={data.prompt} />}
        </div>
      );
    }

    case "send_message":
      return (
        <div className={wrap}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]">
            <span className={rowKey}>Sent to</span>
            <span className="font-medium text-paddock-800 dark:text-paddock-100">
              {data.project}
            </span>
            <ChatLink project={data.project} sessionId={data.sessionId} label="open chat" />
          </div>
          {data.prompt && <PromptBlock label="Message" text={data.prompt} />}
        </div>
      );

    case "fork_chat_batch":
      return (
        <div className={wrap}>
          <div className="mb-2 flex items-center gap-2 text-[11px]">
            <span className={rowKey}>
              {data.count} {data.count === 1 ? "fork" : "forks"} from {shortId(data.source)}
            </span>
          </div>
          <ol className="max-h-72 space-y-1.5 overflow-auto">
            {data.forks.map((f, i) => (
              <li
                key={f.sessionId}
                className="flex items-start gap-2 rounded-md bg-paddock-100/60 px-2 py-1.5 dark:bg-paddock-900/50"
              >
                <span className="mt-0.5 shrink-0 font-mono text-[10px] font-semibold text-paddock-400">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-paddock-700 dark:text-paddock-300">
                  {f.prompt}
                </span>
                <ChatLink project={ctxProject} sessionId={f.sessionId} />
              </li>
            ))}
          </ol>
        </div>
      );
  }
}

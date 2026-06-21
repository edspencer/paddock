import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api";
import type { Chat, Project } from "../lib/types";
import { StatusPill } from "../components/StatusPill";
import { ChatPane } from "../components/ChatPane";

type Tab = "chat" | "files";

export function ProjectView() {
  const { slug = "" } = useParams();
  const [project, setProject] = useState<Project | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeSession, setActiveSession] = useState<string | undefined>(undefined);
  const [chatKey, setChatKey] = useState(0); // bump to force a fresh chat
  const [tab, setTab] = useState<Tab>("chat");
  const [changelog, setChangelog] = useState("");

  useEffect(() => {
    void (async () => {
      setProject(await api.getProject(slug));
      setChats(await api.listProjectChats(slug));
      setChangelog(await api.changelog(slug));
      setActiveSession(undefined);
      setChatKey((k) => k + 1);
    })();
  }, [slug]);

  if (!project) {
    return <div className="p-6 text-sm text-paddock-500">Loading…</div>;
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="border-b border-paddock-200 px-6 py-4 dark:border-paddock-800">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{project.name}</h1>
          <StatusPill status={project.status} />
        </div>
        {project.summary && (
          <p className="mt-1 text-sm text-paddock-600 dark:text-paddock-400">{project.summary}</p>
        )}
        <div className="mt-2 flex flex-wrap gap-1">
          {project.domain.map((d) => (
            <span key={d} className="tag">
              {d}
            </span>
          ))}
          <span className="text-xs text-paddock-400">· updated {project.updated}</span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Session list */}
        <div className="flex w-64 shrink-0 flex-col border-r border-paddock-200 dark:border-paddock-800">
          <div className="p-3">
            <button
              className="btn-primary w-full"
              onClick={() => {
                setActiveSession(undefined);
                setChatKey((k) => k + 1);
                setTab("chat");
              }}
            >
              + New Chat in project
            </button>
          </div>
          <div className="px-3 text-xs font-semibold uppercase tracking-wide text-paddock-500">
            Chats
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {chats.length === 0 && (
              <p className="px-2 py-2 text-sm text-paddock-500">No chats yet.</p>
            )}
            {chats.map((c) => (
              <button
                key={c.sessionId}
                onClick={() => {
                  setActiveSession(c.sessionId);
                  setChatKey((k) => k + 1);
                  setTab("chat");
                }}
                className={`flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                  activeSession === c.sessionId
                    ? "bg-paddock-200 dark:bg-paddock-800"
                    : "hover:bg-paddock-200/60 dark:hover:bg-paddock-800/60"
                }`}
              >
                <span className="truncate font-medium">{c.name}</span>
                <span className="text-xs text-paddock-400">{c.updatedAt?.slice(0, 16)}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Main: tabs + content */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex gap-1 border-b border-paddock-200 px-4 dark:border-paddock-800">
            <TabButton active={tab === "chat"} onClick={() => setTab("chat")}>
              Chat
            </TabButton>
            <TabButton active={tab === "files"} onClick={() => setTab("files")}>
              Files / Changelog
            </TabButton>
          </div>

          {tab === "chat" ? (
            <ChatPane
              key={chatKey}
              target={project.slug}
              initialSessionId={activeSession}
              title={activeSession ? "Resumed chat" : "New chat"}
            />
          ) : (
            <div className="flex-1 overflow-y-auto p-6">
              <h3 className="mb-2 font-semibold">Changelog</h3>
              <pre className="whitespace-pre-wrap rounded-lg border border-paddock-200 bg-paddock-50 p-4 text-sm dark:border-paddock-800 dark:bg-paddock-950">
                {changelog || "No CHANGELOG.md yet."}
              </pre>
              <p className="mt-4 text-xs text-paddock-400">
                Project directory: <span className="font-mono">{project.dir}</span>
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
        active
          ? "border-paddock-600 text-paddock-800 dark:text-paddock-100"
          : "border-transparent text-paddock-500 hover:text-paddock-700 dark:hover:text-paddock-300"
      }`}
    >
      {children}
    </button>
  );
}

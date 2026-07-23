import type { Chat, Project } from "../../lib/types";
import { Markdown } from "../../components/Markdown";
import { relativeTime } from "../../lib/format";
import { areaLabel } from "../../lib/areas";
import {
  ChatIcon,
  FileIcon,
  LinkIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
} from "../../components/icons";

/**
 * The Home tab: the project's landing/overview. Gives `/projects/:slug` a real
 * destination (instead of silently forwarding into a chat) and is the mobile
 * navigation hub — summary + metadata + edit, recent chats, recent files, and
 * the CHANGELOG, all deep-linkable via `/projects/:slug/home`.
 * (Extracted from ProjectView.tsx, issue #403.)
 */
export function HomePane({
  project,
  chats,
  changelog,
  files,
  runningSessions,
  onOpenChat,
  onNewChat,
  onOpenFile,
  onOpenFiles,
  onEditDetails,
}: {
  project: Project;
  chats: Chat[];
  changelog: string;
  files: string[];
  runningSessions: ReadonlySet<string>;
  onOpenChat: (sessionId: string) => void;
  onNewChat: () => void;
  onOpenFile: (name: string) => void;
  onOpenFiles: () => void;
  onEditDetails: () => void;
}) {
  const recentChats = chats.slice(0, 6);
  const recentFiles = files.slice(0, 6);
  return (
    <div className="flex-1 overflow-y-auto overscroll-contain">
      <div className="mx-auto max-w-3xl px-6 py-6">
        {/* Overview: summary + metadata + edit-details shortcut. */}
        <section className="mb-8">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-paddock-500">
              Overview
            </h3>
            <button
              onClick={onEditDetails}
              className="btn-subtle -mr-1 gap-1.5 px-2 py-1 text-xs"
            >
              <PencilIcon width={13} height={13} />
              Edit details
            </button>
          </div>
          <div className="card">
            {project.summary ? (
              <p className="text-sm text-paddock-700 dark:text-paddock-300">{project.summary}</p>
            ) : (
              <p className="text-sm italic text-paddock-400">No summary set yet.</p>
            )}
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13px] sm:grid-cols-3">
              <Meta label="Status" value={project.status} />
              <Meta label="Area" value={areaLabel(project.group)} />
              <Meta label="Visibility" value={project.visibility} />
              <Meta label="Model" value={project.model} />
              <Meta label="Started" value={project.started} />
              <Meta label="Updated" value={project.updated} />
              {project.domain.length > 0 && (
                <Meta label="Domains" value={project.domain.join(", ")} />
              )}
              {project.repoBacked && project.repo && (
                <Meta label="Repo" value={project.repo} />
              )}
            </dl>
            {project.links && project.links.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {project.links.map((l) => (
                  <a
                    key={l.url}
                    href={l.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-md bg-paddock-100 px-2 py-1 text-xs text-paddock-700 transition-colors hover:bg-paddock-200 dark:bg-paddock-900 dark:text-paddock-300 dark:hover:bg-paddock-800"
                  >
                    <LinkIcon width={12} height={12} />
                    {l.label || l.url}
                  </a>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Chats: recent sessions + a shortcut to start a new one. */}
        <section className="mb-8">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-paddock-500">
              Chats
              {chats.length > 0 && <span className="ml-1.5 text-paddock-400">{chats.length}</span>}
            </h3>
            <button onClick={onNewChat} className="btn-subtle -mr-1 gap-1.5 px-2 py-1 text-xs">
              <PlusIcon width={13} height={13} />
              New chat
            </button>
          </div>
          {recentChats.length === 0 ? (
            <div className="card">
              <p className="text-sm italic text-paddock-400">
                No chats yet. Start one to begin working with the keeper agent.
              </p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-paddock-200 dark:border-paddock-800">
              {recentChats.map((c, i) => (
                <button
                  key={c.sessionId}
                  onClick={() => onOpenChat(c.sessionId)}
                  className={`flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-paddock-100/70 dark:hover:bg-paddock-900/40 ${
                    i > 0 ? "border-t border-paddock-200 dark:border-paddock-800" : ""
                  }`}
                >
                  {runningSessions.has(c.sessionId) ? (
                    <span
                      title="Streaming a response…"
                      aria-label="streaming"
                      className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent"
                    />
                  ) : (
                    <ChatIcon width={14} height={14} className="shrink-0 text-paddock-400" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.name}</span>
                  <span className="shrink-0 text-[11px] text-paddock-400">
                    {relativeTime(c.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Files: a preview of the file index; "View all" jumps to the Files tab. */}
        <section className="mb-8">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-paddock-500">
              Files
              {files.length > 0 && <span className="ml-1.5 text-paddock-400">{files.length}</span>}
            </h3>
            {files.length > recentFiles.length && (
              <button onClick={onOpenFiles} className="btn-subtle -mr-1 px-2 py-1 text-xs">
                View all
              </button>
            )}
          </div>
          {recentFiles.length === 0 ? (
            <div className="card">
              <p className="text-sm italic text-paddock-400">
                No files yet. Files the keeper agent writes appear here.
              </p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-paddock-200 dark:border-paddock-800">
              {recentFiles.map((f, i) => (
                <button
                  key={f}
                  onClick={() => onOpenFile(f)}
                  className={`flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-paddock-100/70 dark:hover:bg-paddock-900/40 ${
                    i > 0 ? "border-t border-paddock-200 dark:border-paddock-800" : ""
                  }`}
                >
                  <FileIcon width={15} height={15} className="shrink-0 text-paddock-400" />
                  <span className="min-w-0 flex-1 truncate font-mono text-sm text-paddock-700 dark:text-paddock-200">
                    {f}
                  </span>
                  {project.pinned.includes(f) && (
                    <PinIcon width={12} height={12} className="shrink-0 text-accent" />
                  )}
                </button>
              ))}
            </div>
          )}
        </section>

        {/* CHANGELOG.md — the curated project log. */}
        <section>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-paddock-500">
            CHANGELOG.md
          </h3>
          <div className="card">
            {changelog.trim() ? (
              <Markdown>{changelog}</Markdown>
            ) : (
              <p className="text-sm italic text-paddock-400">No CHANGELOG.md yet.</p>
            )}
          </div>
        </section>

        <p className="mt-6 text-[11px] text-paddock-400">
          Project directory: <span className="font-mono">{project.dir}</span>
        </p>
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-paddock-400">
        {label}
      </dt>
      <dd className="text-paddock-700 dark:text-paddock-300">{value}</dd>
    </div>
  );
}

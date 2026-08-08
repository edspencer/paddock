import { useState } from "react";
import type { AttentionChat, Project } from "../../lib/types";
import { Markdown } from "../../components/Markdown";
import { relativeTime } from "../../lib/format";
import { ChevronRightIcon, FileIcon, PinIcon, PlusIcon } from "../../components/icons";
import { EmptyState } from "../../components/ui";

/**
 * The Home tab: the workspace's landing page. Gives `/projects/:slug` a real
 * destination (instead of silently forwarding into a chat) and is the mobile
 * navigation hub, all deep-linkable via `/projects/:slug/home`.
 * (Extracted from ProjectView.tsx, issue #403.)
 *
 * Home answers "what needs me?" before "what is this?" (#599). It opens on the
 * chats with a LIVE TURN, then the chats holding an UNREAD reply, then the
 * files, then the curated OVERVIEW.md / CHANGELOG.md.
 *
 * It used to open on a generic list of recent chats, which the sidebar already
 * shows in full — so the front door duplicated the furniture and buried the
 * signal. Running and unread are the two states that actually want a decision.
 *
 * The two feeds arrive pre-derived from the server for this workspace's whole
 * SUBTREE, so the ROOT's Home is fleet-wide (every project plus the root's own
 * chats) and a project's Home is scoped to itself — through one component that
 * never learns which it is rendering. See `useAttentionChats`.
 */
export function HomePane({
  project,
  running,
  unread,
  attentionLoading,
  attentionError,
  changelog,
  overview,
  files,
  onOpenChat,
  onNewChat,
  onOpenFile,
  onOpenFiles,
}: {
  project: Project;
  /** Chats in this workspace's subtree with a turn in flight right now. */
  running: AttentionChat[];
  /** Chats in this workspace's subtree holding a reply the user hasn't seen. */
  unread: AttentionChat[];
  attentionLoading: boolean;
  attentionError: string | null;
  changelog: string;
  overview: string;
  files: string[];
  onOpenChat: (sessionId: string, projectSlug: string) => void;
  onNewChat: () => void;
  // Files is optional so the ROOT project (issue #516) can render Home before
  // its Files tab exists. Omitting the handler hides the affordance it drives,
  // rather than pointing it at a dead URL.
  onOpenFile?: (name: string) => void;
  onOpenFiles?: () => void;
}) {
  const recentFiles = files.slice(0, 6);
  return (
    <div className="flex-1 overflow-y-auto overscroll-contain">
      <div className="mx-auto max-w-3xl px-6 py-6">
        {/* Running: the live work, and the shortcut to start more. */}
        <section className="mb-8">
          <div className="mb-2 flex items-center justify-between">
            <SectionLabel label="Running" count={running.length} />
            <button onClick={onNewChat} className="btn-subtle -mr-1 gap-1.5 px-2 py-1 text-xs">
              <PlusIcon width={13} height={13} />
              New chat
            </button>
          </div>
          {attentionError ? (
            <div className="card">
              <p className="text-sm text-danger">{attentionError}</p>
            </div>
          ) : (
            <ChatRows
              chats={running}
              workspaceSlug={project.slug}
              loading={attentionLoading}
              empty="Nothing running right now."
              onOpenChat={onOpenChat}
              kind="running"
            />
          )}
        </section>

        {/* Unread: replies that landed while the user was elsewhere. */}
        {!attentionError && (
          <section className="mb-8">
            <div className="mb-2 flex items-center justify-between">
              <SectionLabel label="Unread" count={unread.length} />
            </div>
            <ChatRows
              chats={unread}
              workspaceSlug={project.slug}
              loading={attentionLoading}
              empty="No unread replies. All caught up."
              onOpenChat={onOpenChat}
              kind="unread"
            />
          </section>
        )}

        {/* Files: a preview of the file index; "View all" jumps to the Files tab.
            Omitted entirely where there is no Files tab to jump TO. */}
        {onOpenFile && (
          <section className="mb-8">
            <div className="mb-2 flex items-center justify-between">
              <SectionLabel label="Files" count={files.length} />
              {files.length > recentFiles.length && (
                <button onClick={onOpenFiles} className="btn-subtle -mr-1 px-2 py-1 text-xs">
                  View all
                </button>
              )}
            </div>
            {recentFiles.length === 0 ? (
              <EmptyState title="No files yet. Files Claude writes appear here." />
            ) : (
              <div className="overflow-hidden rounded-2xl border border-edge">
                {recentFiles.map((f, i) => (
                  <button
                    key={f}
                    onClick={() => onOpenFile(f)}
                    className={`flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-surface-hover ${
                      i > 0 ? "border-t border-edge" : ""
                    }`}
                  >
                    <FileIcon width={15} height={15} className="shrink-0 text-fg-subtle" />
                    <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg">
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
        )}

        {/* The two curated notes files, as sibling collapsible cards (#599).
            OVERVIEW.md leads: it says what this workspace IS and where the work
            has got to, which is the context you want before the log of how it
            got there. Both are long prose, so both fold away — and the choice
            sticks per workspace, per browser. */}
        {/* Keyed by workspace: the collapse state is read from localStorage in a
            `useState` initializer, so navigating between workspaces has to
            REMOUNT the section or it would keep showing the previous
            workspace's fold. */}
        <NotesSection
          key={`${project.slug}:overview`}
          id={`${project.slug}:overview`}
          title="OVERVIEW.md"
          body={overview}
          emptyLabel="No OVERVIEW.md yet."
        />
        <NotesSection
          key={`${project.slug}:changelog`}
          id={`${project.slug}:changelog`}
          title="CHANGELOG.md"
          body={changelog}
          emptyLabel="No CHANGELOG.md yet."
        />

        <p className="mt-6 text-2xs text-fg-subtle">
          Project directory: <span className="font-mono">{project.dir}</span>
        </p>
      </div>
    </div>
  );
}

/** A Home section heading + its count, in Home's shared visual language. */
function SectionLabel({ label, count }: { label: string; count: number }) {
  return (
    <h3 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">
      {label}
      {count > 0 && <span className="ml-1.5 text-fg-subtle">{count}</span>}
    </h3>
  );
}

/**
 * The wide chat rows shared by the Running and Unread sections.
 *
 * `workspaceSlug` is the workspace whose Home this is, and the ONLY thing the
 * project label keys off: a row from somewhere else names its project, a row
 * from here doesn't. On the root's Home that labels every project's chat and
 * leaves the root's own chats bare; on a project's Home nothing is labelled,
 * because nothing can be from elsewhere. No `root`-flag needed.
 *
 * Note this compares against `workspaceSlug` with `!==`, not a truthiness test:
 * the root workspace's slug is `""`, so `row.projectSlug || "…"` would label
 * every root chat as foreign.
 */
function ChatRows({
  chats,
  workspaceSlug,
  loading,
  empty,
  onOpenChat,
  kind,
}: {
  chats: AttentionChat[];
  workspaceSlug: string;
  loading: boolean;
  empty: string;
  onOpenChat: (sessionId: string, projectSlug: string) => void;
  kind: "running" | "unread";
}) {
  if (loading && chats.length === 0) {
    return (
      <div
        className="h-[52px] animate-pulse rounded-2xl border border-edge bg-surface-raised"
        aria-busy="true"
      />
    );
  }
  if (chats.length === 0) {
    return <EmptyState title={empty} />;
  }
  return (
    <div
      className="overflow-hidden rounded-2xl border border-edge"
      data-testid={`home-${kind}-chats`}
    >
      {chats.map((c, i) => (
        <button
          key={`${c.projectSlug}:${c.sessionId}`}
          onClick={() => onOpenChat(c.sessionId, c.projectSlug)}
          className={`flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-surface-hover ${
            i > 0 ? "border-t border-edge" : ""
          }`}
        >
          {kind === "running" ? (
            <span
              title="Streaming a response…"
              aria-label="streaming"
              className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent-solid"
            />
          ) : (
            <span
              title="Unread reply"
              aria-label="unread"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-solid"
            />
          )}
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.name}</span>
          {c.projectSlug !== workspaceSlug && (
            <span className="shrink-0 truncate rounded-md bg-surface-active px-1.5 py-0.5 text-2xs text-fg-muted">
              {c.projectName}
            </span>
          )}
          <span className="shrink-0 text-2xs text-fg-subtle">
            {relativeTime(kind === "unread" ? (c.lastTurnCompletedAt ?? c.updatedAt) : c.updatedAt)}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * One collapsible curated-notes card (OVERVIEW.md / CHANGELOG.md).
 *
 * Collapse state persists per workspace + file, so folding a project's giant
 * changelog away doesn't fold every other workspace's too. Default is EXPANDED:
 * the notes are the reason this part of the page exists, and the changelog has
 * always rendered open — a default that hid it would read as "the content
 * disappeared" rather than "it's tidied away".
 */
function NotesSection({
  id,
  title,
  body,
  emptyLabel,
}: {
  id: string;
  title: string;
  body: string;
  emptyLabel: string;
}) {
  const [collapsed, toggle] = useCollapsed(id);
  const open = !collapsed;
  const hasBody = body.trim().length > 0;
  return (
    <section className="mb-8">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="mb-2 -ml-1 flex w-full items-center gap-1.5 rounded-lg px-1 py-1 text-left transition-colors hover:bg-surface-hover"
      >
        <ChevronRightIcon
          width={14}
          height={14}
          className={`shrink-0 text-fg-subtle transition-transform ${open ? "rotate-90" : ""}`}
        />
        <h3 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">{title}</h3>
      </button>
      {open &&
        (hasBody ? (
          <div className="card">
            <Markdown>{body}</Markdown>
          </div>
        ) : (
          <EmptyState title={emptyLabel} />
        ))}
    </section>
  );
}

/**
 * Read/persist one Home notes section's collapsed state in localStorage.
 * Default expanded. Keyed per workspace + section so each remembers
 * independently across reloads. (localStorage is wrapped because it throws in
 * private-mode / storage-disabled browsers, where "always expanded" is the
 * right fallback.)
 */
function useCollapsed(key: string): [boolean, () => void] {
  const storageKey = `paddock:home-collapsed:${key}`;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  return [collapsed, toggle];
}

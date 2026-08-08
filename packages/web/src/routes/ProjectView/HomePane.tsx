import { useState } from "react";
import type { AttentionChat, Project } from "../../lib/types";
import { Markdown } from "../../components/Markdown";
import { relativeTime } from "../../lib/format";
import { ChevronRightIcon, FileIcon, PinIcon, PlusIcon } from "../../components/icons";
import { Button, EmptyState } from "../../components/ui";

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
      <div className="mx-auto max-w-3xl px-6 py-8">
        {/*
         * Home is two things, and vellum makes them look like two things.
         *
         * Above: THE INDEX — running, unread, files. Live state, set as a ruled
         * list directly on the board. No boxes: an index is a list of pointers,
         * and giving each entry its own card is what made this screen read as
         * five identical rounded boxes stacked down the page.
         *
         * Below: THE RECORD — OVERVIEW.md and CHANGELOG.md, as actual pages.
         * That is the deliberate break in the repeated pattern, and it encodes
         * something true: everything above is what is happening now, everything
         * below is what has been written down.
         */}

        {/* Running: the live work, and the shortcut to start more. */}
        <IndexSection
          label="Running"
          count={running.length}
          action={
            <Button size="sm" variant="subtle" onClick={onNewChat}>
              <PlusIcon width={13} height={13} />
              New chat
            </Button>
          }
        >
          {attentionError ? (
            <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              {attentionError}
            </p>
          ) : (
            <ChatRows
              chats={running}
              workspaceSlug={project.slug}
              loading={attentionLoading}
              empty="Nothing running right now."
              emptyBody="Start a chat and its live turns show up here."
              emptyAction={
                <Button size="sm" variant="ghost" onClick={onNewChat}>
                  <PlusIcon width={13} height={13} />
                  New chat
                </Button>
              }
              onOpenChat={onOpenChat}
              kind="running"
            />
          )}
        </IndexSection>

        {/* Unread: replies that landed while the user was elsewhere. */}
        {!attentionError && (
          <IndexSection label="Unread" count={unread.length}>
            <ChatRows
              chats={unread}
              workspaceSlug={project.slug}
              loading={attentionLoading}
              empty="All caught up."
              emptyBody="Replies that land while you are elsewhere collect here."
              onOpenChat={onOpenChat}
              kind="unread"
            />
          </IndexSection>
        )}

        {/* Files: a preview of the file index; "View all" jumps to the Files tab.
            Omitted entirely where there is no Files tab to jump TO. */}
        {onOpenFile && (
          <IndexSection
            label="Files"
            count={files.length}
            action={
              files.length > recentFiles.length && (
                <Button size="sm" variant="subtle" onClick={onOpenFiles}>
                  View all
                </Button>
              )
            }
          >
            {recentFiles.length === 0 ? (
              <EmptyState
                title="No files yet."
                body="Anything Claude writes into this project shows up here."
              />
            ) : (
              <ul>
                {recentFiles.map((f) => (
                  <li key={f}>
                    <button
                      onClick={() => onOpenFile(f)}
                      className="motion-fast flex w-full items-center gap-2.5 border-b border-edge-subtle px-2 py-2.5 text-left transition-[background-color] hover:bg-surface-hover"
                    >
                      <FileIcon width={15} height={15} className="shrink-0 text-fg-subtle" />
                      <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg">
                        {f}
                      </span>
                      {project.pinned.includes(f) && (
                        <PinIcon width={12} height={12} className="shrink-0 text-accent" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </IndexSection>
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

/**
 * One section of Home's INDEX — the repeated pattern.
 *
 * An eyebrow (label, count, a rule that runs out to the section's action) over
 * a ruled list. The rule is the only decoration and it does a job: it ties the
 * label to its optional action across the width, so three sections stack
 * without three boxes. The record sections below deliberately do NOT use this.
 */
function IndexSection({
  label,
  count,
  action,
  children,
}: {
  label: string;
  count: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <div className="mb-1 flex items-center gap-3">
        <h3 className="text-2xs font-semibold uppercase tracking-wider text-fg-muted">{label}</h3>
        {count > 0 && <span className="tabular text-2xs text-fg-subtle">{count}</span>}
        <span aria-hidden className="h-px min-w-4 flex-1 bg-edge" />
        {action}
      </div>
      {children}
    </section>
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
  emptyBody,
  emptyAction,
  onOpenChat,
  kind,
}: {
  chats: AttentionChat[];
  workspaceSlug: string;
  loading: boolean;
  empty: string;
  emptyBody?: string;
  emptyAction?: React.ReactNode;
  onOpenChat: (sessionId: string, projectSlug: string) => void;
  kind: "running" | "unread";
}) {
  if (loading && chats.length === 0) {
    return <div className="h-[46px] animate-pulse border-b border-edge-subtle" aria-busy="true" />;
  }
  if (chats.length === 0) {
    return <EmptyState title={empty} body={emptyBody} action={emptyAction} />;
  }
  return (
    <ul data-testid={`home-${kind}-chats`}>
      {chats.map((c) => (
        <li key={`${c.projectSlug}:${c.sessionId}`}>
          <button
            onClick={() => onOpenChat(c.sessionId, c.projectSlug)}
            className="motion-fast flex w-full items-center gap-2.5 border-b border-edge-subtle px-2 py-2.5 text-left transition-[background-color] hover:bg-surface-hover"
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
            {/* Timestamps are compared row-to-row, so they get tabular figures. */}
            <span className="tabular shrink-0 text-2xs text-fg-subtle">
              {relativeTime(
                kind === "unread" ? (c.lastTurnCompletedAt ?? c.updatedAt) : c.updatedAt,
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
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
    <section className="mb-10">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="motion-fast -ml-1 mb-2 flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left transition-[background-color] hover:bg-surface-hover"
      >
        <ChevronRightIcon
          width={14}
          height={14}
          className={`shrink-0 text-fg-subtle transition-transform ${open ? "rotate-90" : ""}`}
        />
        {/* These are filenames, so they are set as filenames. */}
        <h3 className="font-mono text-xs font-medium text-fg-muted">{title}</h3>
      </button>
      {open &&
        (hasBody ? (
          /*
           * The break in the pattern. Everything above this point is a ruled
           * list on the board; the two curated notes files are PAGES — the
           * raised surface, real padding, and `prose-doc`, which is the
           * document typography (Literata at a 68ch measure).
           *
           * They rendered through the compact CHAT markdown scope inside a
           * `.card` before this: OVERVIEW.md, the document that says what a
           * project is, was typeset as a chat bubble.
           */
          <article className="prose-doc page px-6 py-6 sm:px-9 sm:py-8">
            <Markdown>{body}</Markdown>
          </article>
        ) : (
          <EmptyState
            title={emptyLabel}
            body="Paddock's sweeper curates this after each turn — it appears once there is something to say."
          />
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

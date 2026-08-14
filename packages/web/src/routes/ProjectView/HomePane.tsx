import { useState } from "react";
import type { AttentionChat, Project } from "../../lib/types";
import { Markdown } from "../../components/Markdown";
import { relativeTime } from "../../lib/format";
import {
  BoltIcon,
  ChatIcon,
  ChevronRightIcon,
  FileIcon,
  PinIcon,
  PlusIcon,
  SparkIcon,
} from "../../components/icons";
import { Button, EmptyState, cx } from "../../components/ui";
import { DiscoverView } from "../../components/DiscoverView";
import { EntryCard } from "../../components/onboarding/EntryCard";
import { TIPS } from "../../lib/onboarding/tips";
import { WHATS_NEW } from "../../lib/onboarding/whats-new";

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
 * chats) and a project's Home is scoped to itself. See `useAttentionChats`.
 *
 * ## It now learns which it is rendering, and that is a real cost (#865)
 *
 * This comment used to be proud that one component served both without ever
 * asking. That held while every word on the page was about a workspace — and
 * stopped holding the moment the instance's ONBOARDING had to live somewhere,
 * because onboarding is instance-level and there is exactly one root.
 *
 * So `root` is threaded in explicitly rather than sniffed from `project.slug`
 * (which is `""` at the root — a falsy value three bugs have already been filed
 * about). Everything the flag gates is additive: a project's Home renders
 * exactly what it rendered before, and the gate is one prop rather than a
 * different component, because the day the two diverge for real is the day this
 * should split — not before.
 *
 * ## What an EMPTY instance's Home shows instead
 *
 * `instanceEmpty` (zero projects AND zero root chats — `useInstanceEmpty`) puts
 * Discovery inline at the top, full width, and SUPPRESSES running and unread
 * entirely. Not softened: removed. Zero chats means neither widget can say
 * anything true, and "Nothing is running and there are no unread replies" is
 * noise on an instance that has never run anything.
 *
 * That supersedes the all-caught-up panel below for this one case. The panel is
 * the screen's only primary action on an ordinary quiet Home, so it is not
 * dropped lightly — but on an empty instance the first-run content IS the
 * primary action, and two competing invitations is worse than one.
 *
 * `null` means undecided, and renders NEITHER. Guessing costs a visible flash
 * on exactly the fresh install this exists for: guess "not empty" and the
 * onboarding content lands a beat late, under feeds that then disappear.
 *
 * ## The empty states are invitations, not voids
 *
 * A quiet workspace used to render five near-identical rounded boxes down one
 * viewport, four of them dead ends: "Nothing running right now.", "No unread
 * replies. All caught up.", "No files yet.", "No OVERVIEW.md yet." — a wall of
 * grey with nothing to do about any of it, and the first two saying the same
 * thing twice in a row.
 *
 * So: the two attention feeds collapse into ONE panel when both are empty,
 * because both empty IS one state, and that panel is the only place on the
 * screen carrying a primary action. Everything else stays quiet and merely says
 * who fills it in and when — which is the answer the reader actually lacked, the
 * notes files being written by the post-turn sweeper rather than by hand. One
 * moment of weight, three quiet lines: repeated pattern, then a deliberate
 * break, rather than four identical boxes.
 */
export function HomePane({
  project,
  root = false,
  instanceEmpty = false,
  onInstanceRecheck,
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
  /**
   * Is this the ROOT workspace's Home? Gates the instance-level onboarding
   * content — see the note above about why this component now has to know.
   */
  root?: boolean;
  /**
   * Has this instance nothing in it at all? `null` = not known yet. Only ever
   * meaningful with `root`, and ignored without it.
   */
  instanceEmpty?: boolean | null;
  /** Re-ask whether the instance is still empty — adopting is what changes it. */
  onInstanceRecheck?: () => void;
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
  // Both attention feeds empty is ONE state, not two. Rendered as two sections it
  // was two dead ends in a row — "Nothing running right now." above "No unread
  // replies. All caught up." — saying the same thing twice and offering nothing
  // to do about it. It collapses into a single invitation instead: the screen's
  // one moment of weight, and the only place the primary action appears.
  //
  // Deliberately NOT shown while `attentionLoading`: claiming all is caught up
  // before the answer has arrived is a lie the user acts on.
  const allCaughtUp =
    !attentionError && !attentionLoading && running.length === 0 && unread.length === 0;

  // The onboarding surface is the ROOT's alone. `firstRun` is the empty
  // instance's extra content on top of it, and stays `null` until the answer is
  // known so nothing has to be un-rendered a frame later.
  const onboarding = root;
  const firstRun = root ? instanceEmpty : false;
  // How many of the two cards have anything to say. Either list can be empty —
  // What's New is capped and hand-maintained (#866), tips are a separate file —
  // and a lone card at half width with a hole beside it looks like a failed
  // render, so the row drops to one column when only one survives.
  const onboardingCards = [WHATS_NEW.length, TIPS.length].filter((n) => n > 0).length;
  // Suppressed on a first run, not merely quiet: see the class doc. Tested
  // `=== false` rather than `!== true`, so the UNDECIDED root (`null`) renders
  // neither these nor the first-run content — the whole reason the state is
  // tri-valued. A project is always `false` here and so always shows them.
  const showAttention = firstRun === false;

  return (
    <div className="flex-1 overflow-y-auto overscroll-contain">
      {/* Below XL this is the single stacked column it has always been. At XL the
          root's Home has enough to say to earn two: the width is there, and the
          alternative is a metre of scroll made of half-empty cards. `max-w-3xl`
          stays the ceiling for a PROJECT's Home, which has exactly as much
          content as it did before and would only get thinner columns. */}
      <div className={cx("mx-auto px-6 py-6", onboarding ? "max-w-6xl" : "max-w-3xl")}>
        {firstRun === true && (
          <section className="mb-8" data-testid="home-first-run">
            {/* Full width and at the top: on an instance with history to adopt,
                adopting it is the fastest route to a Paddock worth having. */}
            <DiscoverView firstRun embedded onLeave={onInstanceRecheck} onStartChat={onNewChat} />
          </section>
        )}

        {onboarding && onboardingCards > 0 && (
          <div
            className={cx(
              // Side by side at XL, stacked below it. NOT `items-start`: these
              // two share a row and doing the same job, so they have to be the
              // same height — unequal cards read as broken rather than as
              // considerate of a short one. Grid items stretch by default, and
              // each card is a flex column whose pager is bottom-anchored, so
              // the height the shorter card gains is spent putting both pagers
              // on one baseline rather than left as a lake of padding.
              "mb-8 grid gap-4",
              onboardingCards === 2 ? "xl:grid-cols-2" : "",
            )}
          >
            {/* What's New takes the left slot — the one Getting Started used to
                hold. It is the card with a reason to be looked FOR (what changed
                in the release you just took), so it gets the position the eye
                reaches first; Tips is the one you graze. */}
            <EntryCard
              label="What's New"
              icon={BoltIcon}
              entries={WHATS_NEW}
              itemNoun="Entry"
              testId="home-whats-new"
            />
            <EntryCard
              label="Tips"
              icon={SparkIcon}
              entries={TIPS}
              itemNoun="Tip"
              testId="home-tips-panel"
            />
          </div>
        )}

        {showAttention &&
          (attentionError ? (
            <section className="mb-8">
              <div className="mb-2 flex items-center justify-between">
                <SectionLabel label="Running" count={running.length} />
                <NewChatButton onNewChat={onNewChat} />
              </div>
              <div className="card">
                <p className="text-sm text-danger">{attentionError}</p>
              </div>
            </section>
          ) : allCaughtUp ? (
            <section className="mb-8">
              <EmptyState
                variant="panel"
                icon={<ChatIcon width={22} height={22} />}
                title="All caught up"
                body="Nothing is running and there are no unread replies. Start a chat and it will appear here the moment it wants you."
                action={
                  <Button
                    variant="primary"
                    icon={<PlusIcon width={14} height={14} />}
                    onClick={onNewChat}
                  >
                    New chat
                  </Button>
                }
              />
            </section>
          ) : (
            /* Two half-width widgets at XL: they are the same shape of thing —
               a short list of chats wanting a decision — and side by side you
               can see both without scrolling one off the top. `items-start`
               keeps a two-row Unread from stretching to a ten-row Running. */
            <div className="mb-8 grid items-start gap-4 xl:grid-cols-2">
              {/* Running: the live work, and the shortcut to start more. */}
              <section>
                <div className="mb-2 flex items-center justify-between">
                  <SectionLabel label="Running" count={running.length} />
                  <NewChatButton onNewChat={onNewChat} />
                </div>
                <ChatRows
                  chats={running}
                  workspaceSlug={project.slug}
                  loading={attentionLoading}
                  empty="Nothing running right now."
                  onOpenChat={onOpenChat}
                  kind="running"
                />
              </section>

              {/* Unread: replies that landed while the user was elsewhere. */}
              <section>
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
            </div>
          ))}

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
              <EmptyState
                title="No files yet"
                body="Anything Claude writes in this project shows up here, newest first."
              />
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
        {/* Side by side at XL. They are siblings by construction — one says what
            this is, the other how it got here — and stacked they put a metre of
            prose between the reader and anything below. `items-start` so a
            one-line CHANGELOG doesn't inherit a long OVERVIEW's height. */}
        <div className="grid items-start gap-x-6 xl:grid-cols-2">
          <NotesSection
            key={`${project.slug}:overview`}
            id={`${project.slug}:overview`}
            title="OVERVIEW.md"
            body={overview}
            emptyTitle="No OVERVIEW.md yet"
            emptyBody="The sweeper writes this after a chat — what this workspace is, and where the work has got to."
          />
          <NotesSection
            key={`${project.slug}:changelog`}
            id={`${project.slug}:changelog`}
            title="CHANGELOG.md"
            body={changelog}
            emptyTitle="No CHANGELOG.md yet"
            emptyBody="The sweeper writes this after a chat — a running log of what actually changed."
          />
        </div>

        <p className="mt-6 text-2xs text-fg-subtle">
          Project directory: <span className="font-mono">{project.dir}</span>
        </p>
      </div>
    </div>
  );
}

/**
 * The quiet "New chat" affordance in the Running header. Quiet on purpose: when
 * there IS live work the header is not the thing to look at, and when there is
 * not, the all-caught-up panel carries the same action at full weight instead.
 */
function NewChatButton({ onNewChat }: { onNewChat: () => void }) {
  return (
    <Button variant="subtle" size="sm" className="-mr-1" icon={<PlusIcon width={13} height={13} />} onClick={onNewChat}>
      New chat
    </Button>
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
  emptyTitle,
  emptyBody,
}: {
  id: string;
  title: string;
  body: string;
  emptyTitle: string;
  /**
   * One line saying who fills this in and when. These two files are written by
   * the post-turn sweeper, not by hand, so "No OVERVIEW.md yet." on its own left
   * the reader with no idea whether that was theirs to fix.
   */
  emptyBody: string;
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
          <EmptyState title={emptyTitle} body={emptyBody} />
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

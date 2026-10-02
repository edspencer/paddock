import { useState } from "react";
import type { AttentionChat, Project } from "../../lib/types";
import { Markdown } from "../../components/Markdown";
import { relativeTime } from "../../lib/format";
import { chatClient } from "../../lib/ws";
import {
  BoltIcon,
  ChatIcon,
  ChevronRightIcon,
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
 * Home answers "what needs me?" before "what is this?" (#599). It opens on
 * Running & Recent — the chats with a LIVE TURN, then every other chat newest
 * activity first with the UNREAD ones marked — then the curated OVERVIEW.md /
 * CHANGELOG.md.
 *
 * It carried a Files preview between those two halves until #880. It answered
 * neither question — a truncated listing of the first six top-level entries,
 * duplicating a Files tab one click away in the same tab bar that browses
 * subdirectories properly (#259) — and on a fresh install it rendered "No files
 * yet" under a heading, a void on the page whose job is getting a new user to
 * their first chat (#865). The Files TAB is untouched: this removed a duplicate
 * preview, not a capability.
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
 * That supersedes the no-chats panel below for this one case. The panel is
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
 * thing twice in a row. (The files one is gone entirely since #880; the shape of
 * the problem, and the fix below, are unchanged by that.)
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
  recent,
  attentionLoading,
  attentionError,
  changelog,
  overview,
  onOpenChat,
  onNewChat,
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
  /**
   * The subtree's most recently active non-running chats, newest first, read
   * or not. Unread rows are marked within it by membership in `unread`.
   */
  recent: AttentionChat[];
  attentionLoading: boolean;
  attentionError: string | null;
  changelog: string;
  overview: string;
  onOpenChat: (sessionId: string, projectSlug: string) => void;
  onNewChat: () => void;
}) {
  // A workspace with no chats at all gets ONE invitation rather than an empty
  // table: the screen's one moment of weight, and the only place the primary
  // action appears at full strength. (When the feed was two tables this was
  // "both empty"; since it became Running & Recent, any chat at all — read or
  // not — fills the table, so the panel is for a workspace with nothing in it.)
  //
  // Deliberately NOT shown while `attentionLoading`: claiming there is nothing
  // here before the answer has arrived is a lie the user acts on.
  const noChats =
    !attentionError &&
    !attentionLoading &&
    running.length === 0 &&
    unread.length === 0 &&
    recent.length === 0;

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

        {/* The project's one-line summary. It used to sit under the name in the
            header; the header is now one row — name and tabs (#919) — and Home
            is the tab that says what a project IS. */}
        {project.summary && (
          <p className="mb-6 text-sm text-fg-muted" data-testid="home-summary">
            {project.summary}
          </p>
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
                <SectionLabel label="Running & Recent" />
                <NewChatButton onNewChat={onNewChat} />
              </div>
              <div className="card">
                <p className="text-sm text-danger">{attentionError}</p>
              </div>
            </section>
          ) : noChats ? (
            <section className="mb-8">
              <EmptyState
                variant="panel"
                icon={<ChatIcon width={22} height={22} />}
                title="No chats yet"
                body="Nothing is running and nothing has happened here yet. Start a chat and it will appear here the moment it wants you."
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
            /* ONE feed, not two (Running and Unread used to sit side by side).
               In practice Running held one or two rows and Unread dozens, so the
               pair rendered as a stub beside a column — and Unread had no order a
               reader could see, putting weeks-old replies above one that landed a
               minute ago. Now: live turns first, then everything else newest
               activity first, with unread rows marked rather than segregated. */
            <section className="mb-8">
              <div className="mb-2 flex items-center justify-between gap-3">
                <SectionLabel
                  label="Running & Recent"
                  detail={[
                    running.length > 0 ? `${running.length} running` : null,
                    unread.length > 0 ? `${unread.length} unread` : null,
                  ]}
                />
                <NewChatButton onNewChat={onNewChat} />
              </div>
              <AttentionRows
                running={running}
                recent={recent}
                unread={unread}
                workspaceSlug={project.slug}
                loading={attentionLoading}
                onOpenChat={onOpenChat}
              />
            </section>
          ))}

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
 * not, the no-chats panel carries the same action at full weight instead.
 */
function NewChatButton({ onNewChat }: { onNewChat: () => void }) {
  return (
    <Button
      variant="subtle"
      size="sm"
      className="-mr-1 shrink-0 whitespace-nowrap"
      icon={<PlusIcon width={13} height={13} />}
      onClick={onNewChat}
    >
      New chat
    </Button>
  );
}

/**
 * A Home section heading, with an optional quiet detail after it ("2 running ·
 * 5 unread"). Null parts are dropped, so a caller can pass every count and let
 * the zeros fall away.
 */
function SectionLabel({ label, detail = [] }: { label: string; detail?: (string | null)[] }) {
  const parts = detail.filter((d): d is string => !!d);
  // Wraps between the label and the detail, never inside either: on a phone
  // "Running & Recent" and "2 running · 9 unread" stack as two clean lines
  // rather than breaking mid-phrase.
  return (
    <h3 className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">
      <span className="whitespace-nowrap">{label}</span>
      {parts.length > 0 && (
        <span className="whitespace-nowrap font-normal normal-case tracking-normal text-fg-subtle">
          {parts.join(" · ")}
        </span>
      )}
    </h3>
  );
}

/**
 * How many recent (non-running) rows show before "Show more". Running rows are
 * never folded away — they are the live work, and there are only ever a few.
 */
const RECENT_VISIBLE = 10;

/** Epoch ms of a chat's last sign of life — the same rule the server sorts by. */
function activityAt(c: AttentionChat): number {
  const a = Date.parse(c.updatedAt ?? "");
  const b = Date.parse(c.lastTurnCompletedAt ?? "");
  return Math.max(Number.isFinite(a) ? a : 0, Number.isFinite(b) ? b : 0);
}

/**
 * The Running & Recent rows: live turns on top, then everything else newest
 * activity first, as one list. An UNREAD row is marked — accent dot, full-weight
 * name — rather than filed into a list of its own; a read one is quiet. Each row
 * carries `data-state` (`running` / `unread` / `read`) so tests and the fleet
 * strip's ordering talk about the same three states.
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
function AttentionRows({
  running,
  recent,
  unread,
  workspaceSlug,
  loading,
  onOpenChat,
}: {
  running: AttentionChat[];
  recent: AttentionChat[];
  unread: AttentionChat[];
  workspaceSlug: string;
  loading: boolean;
  onOpenChat: (sessionId: string, projectSlug: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const key = (c: AttentionChat) => `${c.projectSlug}:${c.sessionId}`;
  const unreadKeys = new Set(unread.map(key));
  // `recent` is capped server-side, and a very old unread chat can fall off its
  // end. It is still unread — the counts say so — so it joins the tail rather
  // than vanishing; ordering by activity puts it where it belongs, at the back.
  const recentKeys = new Set(recent.map(key));
  const rest = [...recent, ...unread.filter((c) => !recentKeys.has(key(c)))].sort(
    (a, b) => activityAt(b) - activityAt(a),
  );

  if (loading && running.length === 0 && rest.length === 0) {
    return (
      <div
        className="h-[52px] animate-pulse rounded-2xl border border-edge bg-surface-raised"
        aria-busy="true"
      />
    );
  }

  // Running rows in the SAME order as the fleet strip's channels: the
  // longest-running turn first (the one most likely to be wedged), unknown
  // starts last. The strip is this list laid out left to right, and the two
  // disagreeing about which live turn comes first would read as a bug.
  const runningOrdered = [...running].sort(
    (a, b) =>
      (chatClient.turnStartedAt(a.sessionId) ?? Infinity) -
      (chatClient.turnStartedAt(b.sessionId) ?? Infinity),
  );

  const shownRest = expanded ? rest : rest.slice(0, RECENT_VISIBLE);
  const hiddenCount = rest.length - shownRest.length;
  const rows: { chat: AttentionChat; state: "running" | "unread" | "read" }[] = [
    ...runningOrdered.map((chat) => ({ chat, state: "running" as const })),
    ...shownRest.map((chat) => ({
      chat,
      state: unreadKeys.has(key(chat)) ? ("unread" as const) : ("read" as const),
    })),
  ];

  return (
    <div className="overflow-hidden rounded-2xl border border-edge" data-testid="home-attention-chats">
      {rows.map(({ chat: c, state }, i) => (
        <button
          key={key(c)}
          data-state={state}
          onClick={() => onOpenChat(c.sessionId, c.projectSlug)}
          className={cx(
            "flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-surface-hover",
            i > 0 && "border-t border-edge",
          )}
        >
          {state === "running" ? (
            <span
              title="Streaming a response…"
              aria-label="running"
              className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent-solid"
            />
          ) : state === "unread" ? (
            <span
              title="Unread reply"
              aria-label="unread"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn-solid"
            />
          ) : (
            // Same width as the dots so names align down the column.
            <span className="h-1.5 w-1.5 shrink-0" aria-hidden="true" />
          )}
          <span
            className={cx(
              "min-w-0 flex-1 truncate text-sm",
              state === "read" ? "text-fg-muted" : "font-medium text-fg",
            )}
          >
            {c.name}
          </span>
          {c.projectSlug !== workspaceSlug && (
            <span className="shrink-0 truncate rounded-md bg-surface-active px-1.5 py-0.5 text-2xs text-fg-muted">
              {c.projectName}
            </span>
          )}
          <span
            className={cx(
              "w-16 shrink-0 text-right text-2xs",
              state === "running" ? "font-medium text-accent" : "text-fg-subtle",
            )}
          >
            {state === "running"
              ? "running"
              : activityAt(c) > 0
                ? relativeTime(new Date(activityAt(c)).toISOString())
                : ""}
          </span>
        </button>
      ))}
      {(hiddenCount > 0 || expanded) && rest.length > RECENT_VISIBLE && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="flex w-full items-center justify-center border-t border-edge px-3 py-2 text-2xs font-medium text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
        >
          {expanded ? "Show fewer" : `Show ${hiddenCount} more`}
        </button>
      )}
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

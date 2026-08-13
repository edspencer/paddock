/**
 * Getting Started — the slideshow's content (issue #865).
 *
 * Six slides for someone who has just installed Paddock and has never used it.
 * Every claim here is grounded in `website/src/content/docs/` — see the note
 * above each slide for the page it comes from. If a claim stops being true, the
 * doc is the thing that moved; fix both.
 *
 * ── On the diagrams ────────────────────────────────────────────────────────
 * They are HTML + CSS built from the design tokens, NOT inline SVG. Three media
 * were drawn and rendered side by side across all four themes and both modes
 * before this was decided; inline SVG looked fine at its design width and lost
 * on two things it cannot fix from inside a `viewBox`:
 *
 *   1. Type is rubber. SVG text scales with the container, so the same diagram
 *      renders at ~9px in a narrow card and ~17px in a wide one — it cannot sit
 *      on the type scale (docs/DESIGN.md §5) the way the surrounding copy does.
 *   2. Geometry cannot follow the tokens. `rx` is a fixed number, so a diagram
 *      keeps its rounded corners in `scifi`, which deliberately sets every
 *      `--radius-*` to 0.
 *
 * Both are free in CSS: `text-2xs` is `text-2xs` at every width, and
 * `rounded-lg` is whatever the active theme says it is. So a diagram here is
 * ordinary tokenised markup — no colour literals, no `dark:` variants, nothing
 * a theme cannot restyle (docs/DESIGN.md §7).
 *
 * A slide with no diagram is the normal case, not a gap. Three of the six carry
 * one, because three of them describe a relationship a sentence handles badly.
 */
import type { ReactNode } from "react";

/**
 * The slide shape. This mirrors `./types.ts`, which a sibling PR owns along
 * with the slideshow component; when that lands, this local declaration is
 * deleted and the type is imported from `./types.js` instead.
 */
export interface Slide {
  /** Stable kebab-case slug. Safe to deep-link to; do not renumber. */
  id: string;
  title: string;
  /** 1–3 sentences, plain text. This is a half-width card, not a document. */
  body: string;
  /** Omitted entirely when the slide reads better without one. */
  diagram?: ReactNode;
}

/* -------------------------------------------------------------------------- */
/* Diagram parts                                                              */
/* -------------------------------------------------------------------------- */

/** A caption above or below a diagram row. Never the diagram's only content. */
function Caption({ children }: { children: ReactNode }) {
  return <div className="text-3xs uppercase tracking-wide text-fg-subtle">{children}</div>;
}

/** The label in a diagram's left gutter. Fixed width so rows stay in a column. */
function Lane({ name, children }: { name: string; children: ReactNode }) {
  return (
    <>
      <span className="self-center text-right text-3xs leading-none text-fg-subtle">{name}</span>
      {children}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Diagram — "a project is a directory"                                       */
/* -------------------------------------------------------------------------- */

function FileRow({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return (
    <div className={muted ? "truncate text-2xs text-fg-subtle" : "truncate text-2xs text-fg-muted"}>
      {children}
    </div>
  );
}

/**
 * Two boxes, side by side, that never touch: the folder you pointed Paddock at,
 * and the folder Paddock keeps its own things in. The gap between them is the
 * point — an imported project has nothing written into it.
 * Source: concepts/projects.md, using/creating-and-organizing-projects.md.
 */
function ProjectDiagram() {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1.5">
        <Caption>your folder</Caption>
        <div className="space-y-1 rounded-lg border border-edge bg-surface-sunken px-2 py-1.5">
          <FileRow>src/</FileRow>
          <FileRow>README.md</FileRow>
          {/* short on purpose: this row must not truncate in a narrow card,
              and "untouched" is the word doing the work */}
          <FileRow muted>…untouched</FileRow>
        </div>
      </div>
      <div className="space-y-1.5">
        <Caption>Paddock&rsquo;s own folder</Caption>
        <div className="space-y-1 rounded-lg border border-edge-strong bg-surface-sunken px-2 py-1.5">
          <FileRow>project.yaml</FileRow>
          <FileRow>OVERVIEW.md</FileRow>
          <FileRow>CHANGELOG.md</FileRow>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Diagram — "close the browser, the turn keeps running"                      */
/* -------------------------------------------------------------------------- */

/**
 * Two lanes on one time axis. Your lane breaks where you close the tab;
 * Paddock's lane does not. The break-versus-continuity IS the claim, and it is
 * the one thing on these six slides a sentence conveys least well.
 * Source: concepts/chats.md ("resumable across page reloads, socket
 * reconnects, server restarts, and even different devices").
 */
function PersistenceDiagram() {
  return (
    <div className="grid grid-cols-[3rem_1fr] gap-x-2">
      {/* the three moments, labelling the lane below them */}
      <span />
      <div className="grid grid-cols-[1fr_1.3fr_1fr] text-2xs leading-none">
        <span className="text-fg-muted">you send</span>
        <span className="text-center text-fg-subtle">tab closed</span>
        <span className="text-right text-fg-muted">you&rsquo;re back</span>
      </div>

      <Lane name="You">
        {/* Two runs and a real gap. A dashed rule through the gap read as "the
            line continues", which is the opposite of the point. */}
        <div className="mt-2 grid h-2.5 grid-cols-[1fr_1.3fr_1fr] items-center">
          <span className="h-0.5 self-center border-r-2 border-edge-strong bg-edge-strong" />
          <span />
          <span className="h-0.5 self-center border-l-2 border-edge-strong bg-edge-strong" />
        </div>
      </Lane>

      {/* drops from each end cap onto Paddock's lane, so the two line up */}
      <span />
      <div className="grid h-3 grid-cols-[1fr_1.3fr_1fr]">
        <span className="justify-self-end border-l border-dashed border-edge-strong" />
        <span />
        <span className="justify-self-start border-l border-dashed border-edge-strong" />
      </div>

      <Lane name="Paddock">
        <div className="flex items-center gap-2 rounded-lg border border-edge-strong bg-surface-sunken px-2.5 py-1.5">
          <span className="size-2 shrink-0 rounded-full bg-success-solid" />
          <span className="min-w-0 text-2xs text-fg">the turn runs, and keeps running</span>
        </div>
      </Lane>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The slides                                                                 */
/* -------------------------------------------------------------------------- */

export const SLIDES: Slide[] = [
  {
    // getting-started.md: Discover reads the directories you have actually run
    // `claude` in; transcripts are COPIED, originals never moved.
    // using/creating-and-organizing-projects.md: "You never have to decide up
    // front." Both halves matter — this card renders on an instance with no
    // history at all, so it must not assert that you have some.
    id: "start-with-what-you-have",
    title: "Start anywhere",
    body: "If you have been running Claude Code in a terminal on this machine, Discover offers those directories as projects, with their past conversations attached and resumable. If you haven't, just start a chat — you can promote it to a project later. You never have to decide up front.",
  },
  {
    // concepts/projects.md: "a directory plus a project.yaml". An imported
    // project is unmanaged and points at your path — Paddock "writes nothing
    // into it whatsoever". OVERVIEW.md / CHANGELOG.md are curated after your
    // turns (concepts/sweeper.md).
    id: "projects-are-directories",
    title: "A project is a directory",
    body: "Not a workspace to migrate into — a folder on this machine, plus a little metadata Paddock keeps on the side. Importing a directory creates nothing inside it. Paddock keeps its own notes, an OVERVIEW and a CHANGELOG it writes for you after each turn.",
    diagram: <ProjectDiagram />,
  },
  {
    // concepts/chats.md: a chat IS a Claude Code session; the transcript JSONL
    // is written by the CLI and Paddock only reads it; the working directory is
    // the session key.
    id: "chats-are-sessions",
    title: "A chat is a Claude Code session",
    body: "Not Paddock's record of one — the session itself, the same transcript file the terminal writes, keyed by its working directory. That is why your terminal history can be picked up here, and why nothing you do in Paddock is trapped in Paddock.",
  },
  {
    // concepts/chats.md: resumable across reloads, reconnects, server restarts
    // and devices; SessionHub replays buffered frames so "a live turn keeps
    // streaming to whoever attaches".
    id: "work-carries-on",
    title: "Close the browser. The work carries on",
    body: "The turn runs on the server, not in this tab. Shut the laptop mid-answer and it keeps going; open Paddock again on your phone and you reattach to the same live stream.",
    diagram: <PersistenceDiagram />,
  },
  {
    // concepts/workspaces.md: root Home's feeds are derived for the whole
    // subtree, so it is fleet-wide. using/working-in-chats.md: the fleet readout
    // is pinned across every route; unread is set when a chat you are NOT
    // looking at finishes a turn.
    id: "home-is-the-fleet",
    title: "Home tells you what needs you",
    body: "Once you have a few projects, several answers can be arriving at once. Home gathers every chat with a turn in flight and every chat holding a reply you haven't read, across all your projects — and the strip along the top says the same thing from wherever you are.",
  },
  {
    // concepts/schedules.md + concepts/hooks.md: a trigger is when + what +
    // enabled; a firing is a real, badged, resumable chat. New triggers are
    // created disabled. NOTE: the `webhook` type is reserved and nothing fires
    // it yet — deliberately not mentioned here.
    // No diagram: a first pass drew "a when → a what → a chat" and it only
    // restated the sentence above it in boxes. Two diagrams that are both
    // load-bearing beats three with a passenger.
    id: "unattended-work",
    title: "It can work while you're away",
    body: "A trigger is a time or an event, plus a prompt to run. When one fires it opens an ordinary chat you can read, reply in and carry on — so you come back to work already done, not to a log. New triggers start switched off until you enable them.",
  },
];

import type { Slide } from "./types";

/**
 * Getting Started slides for the root Home (#865).
 *
 * PLACEHOLDER — enough slides to build and test against, including one WITHOUT
 * a diagram, because "no diagram" is a supported shape and the renderer has to
 * be exercised against it. The real slides (and the decision about what medium
 * their diagrams are authored in) are written separately and replace this file's
 * contents wholesale.
 *
 * Diagrams are HTML/CSS built from the design tokens, NOT inline SVG. Inline SVG
 * was the opening bet and #868 settled against it on rendered evidence: SVG text
 * does not hold the type scale across the card's width range, and `rx` cannot
 * follow `--radius-*`, so Sci-Fi's square corners come out rounded. The one
 * below is a placeholder in the shape of the real thing — token-driven divs,
 * inheriting `currentColor` and the theme's own radii — so it survives all four
 * themes plus light/dark without a per-theme asset.
 */
export const SLIDES: Slide[] = [
  {
    id: "what-is-paddock",
    title: "Paddock runs agents that stay",
    body: "A keeper agent lives in each project directory and keeps working between your visits — Paddock is the enclosure it lives in, not a wrapper around one command.",
    diagram: (
      <div
        className="flex h-20 w-full items-center justify-center gap-0 text-fg-subtle"
        role="img"
        aria-label="A project directory with a keeper agent attached"
      >
        <span className="rounded-xl border border-edge px-4 py-3 text-2xs">directory</span>
        <span className="h-px w-8 bg-edge-strong" />
        <span className="rounded-xl border border-edge px-4 py-3 text-2xs">keeper</span>
      </div>
    ),
  },
  {
    id: "chats-are-durable",
    title: "Chats are durable",
    body: "Every conversation is a resumable session on disk. Close the tab, restart the server, come back tomorrow — the chat is still there and still knows what it was doing.",
  },
  {
    id: "start-a-chat",
    title: "Start with one chat",
    body: "You do not need a project to begin. Start a chat in this workspace and turn it into a project later, once it has earned one.",
  },
];

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
 * A diagram is inline SVG using `currentColor` so it survives all four themes
 * plus light/dark without a per-theme asset. Anything that needs a colour of its
 * own should use a theme token, never a hex literal.
 */
export const SLIDES: Slide[] = [
  {
    id: "what-is-paddock",
    title: "Paddock runs agents that stay",
    body: "A keeper agent lives in each project directory and keeps working between your visits — Paddock is the enclosure it lives in, not a wrapper around one command.",
    diagram: (
      <svg viewBox="0 0 240 80" className="h-20 w-full" role="img" aria-label="A project directory with a keeper agent attached">
        <rect x="8" y="16" width="92" height="48" rx="8" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
        <rect x="140" y="16" width="92" height="48" rx="8" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
        <path d="M100 40h40" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
        <circle cx="136" cy="40" r="3" fill="currentColor" />
      </svg>
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

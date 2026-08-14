import type { Tip } from "./types";

/**
 * Tip-of-the-day content for the root Home's Tips panel (#865).
 *
 * PLACEHOLDER — enough entries to build and test against. The real list is
 * written separately and replaces this file's contents wholesale; the panel is
 * written against {@link Tip} and the length of this array, never against these
 * particular entries.
 */
export const TIPS: Tip[] = [
  {
    id: "sidebar-new-project",
    title: "Every project gets its own keeper",
    body: "A project is a directory plus a long-lived agent that knows it. Add one from the Projects header in the sidebar.",
    href: "/docs/guides/projects/",
  },
  {
    id: "adopt-terminal-history",
    title: "Bring terminal history in",
    body: "Discover finds directories you have already used Claude Code in and adopts their conversations as projects.",
    href: "/docs/guides/discover/",
  },
  {
    id: "chats-resume",
    title: "Chats survive a restart",
    body: "Sessions are resumable, so closing the tab — or restarting the server — does not lose the conversation.",
  },
];

import type { Tip } from "./types";

/**
 * Tip-of-the-day content for the root Home's Tips panel (#865).
 *
 * PLACEHOLDER — the minimum that makes the app build and the panel paginate.
 * The real list is #867 (31 tips) and replaces this file wholesale. The panel is
 * written against {@link Tip} and the LENGTH of this array, never against these
 * particular entries, so shortening this file cannot weaken its coverage: the
 * empty, single-entry and multi-entry cases are all exercised in
 * `TipsPanel.test.tsx` against fixtures of its own.
 *
 * Say **Claude** in UI microcopy, and **Claude Code** where the product is
 * meant. Paddock has no other user-facing noun for the thing running in a
 * project — see #871, which is retiring the last internal ones and adding a
 * guard so they stop regrowing.
 */
export const TIPS: Tip[] = [
  {
    id: "adopt-terminal-history",
    title: "Bring your terminal history in",
    body: "Discover finds directories on this machine you have already used Claude Code in, and adopts their conversations as projects.",
    href: "/docs/guides/discover/",
  },
  {
    id: "chats-are-resumable",
    title: "Chats survive a restart",
    body: "Every conversation is a resumable session on disk, so closing the tab — or restarting the server — does not lose it.",
  },
];

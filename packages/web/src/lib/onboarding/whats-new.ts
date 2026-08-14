import type { WhatsNewEntry } from "./types";

/**
 * What's New content for the root Home's What's New tab (#865).
 *
 * PLACEHOLDER — enough entries to build and test against. The real list, its
 * ~12-entry cap and the process that keeps it current at release time are #866;
 * this file's contents are replaced wholesale by that work.
 */
export const WHATS_NEW: WhatsNewEntry[] = [
  {
    id: "v0-71-triggers",
    version: "0.71",
    title: "Triggers",
    body: "Schedules, webhooks and events that start a chat without you.",
    href: "https://paddock.dev/docs/guides/triggers/",
  },
  {
    id: "v0-70-discover",
    version: "0.70",
    title: "Discover",
    body: "Adopt directories you have already used Claude Code in as projects.",
    href: "https://paddock.dev/docs/guides/discover/",
  },
];

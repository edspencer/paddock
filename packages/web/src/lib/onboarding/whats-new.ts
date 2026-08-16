import type { WhatsNewEntry } from "./types";
// The live What's New list: the twelve most recent entries from the website's
// What's New page, in the same order, newest first.
//
// Two constraints govern the writing here, both from #865/#866:
//
//  1. **Read in isolation, out of order.** The Home card shows exactly ONE
//     entry, chosen at random, with nothing around it. No entry may refer to
//     another, imply a position in a list, or assume the reader has seen the
//     one above it.
//  2. **Still true today.** An entry describes a release *as it shipped*, and
//     some are later superseded on the website, which carries forward-links for
//     them. The one line kept here is deliberately the part that is still true
//     in the current version — the website entry has the full history for anyone
//     who follows the link.
//
// Screenshots and videos stay on the website. The card has no room for them.
//
// Capped at 12 by `whats-new.test.ts`, which fails the build at 13. Adding an
// entry means bumping the oldest out of `whats-new.mdx` into
// `whats-new-archive.mdx` and deleting it from here. See #866.

// The sibling PR for #865 lands `./types.js` with these exact interfaces and
// will consolidate this declaration; it did not exist on main when this file
// was written.

/** Maximum live entries. Adding a thirteenth is a build failure — see #866. */
export const WHATS_NEW_MAX = 12;

const WHATS_NEW_PAGE = "https://paddock.edspencer.net/whats-new/";

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    id: "0-72-posture-profiles",
    version: "0.72",
    title: "One key for the whole posture",
    body: "One profile key — paranoid, balanced or yolo — sets an instance's security posture across the Claude sharing modes, spawn depth and capability toggles, without touching your port, bind address or auth.",
    href: `${WHATS_NEW_PAGE}#072--one-key-for-the-whole-posture`,
  },
  {
    id: "0-71-2-service-control",
    version: "0.71.2",
    title: "Service control",
    body: "An installed Paddock service restarts after any stop rather than only after a crash, and paddock service gained start, stop and restart, which wait for the URL to answer before claiming success.",
    href: `${WHATS_NEW_PAGE}#0712--service-control`,
  },
  {
    id: "0-71-1-front-door",
    version: "0.71.1",
    title: "The front door",
    body: "The root workspace's Home is the front door: Discovery sits inline while the instance is empty, and What's New and Tips cards each show one entry chosen at random.",
    href: `${WHATS_NEW_PAGE}#0711--the-front-door`,
  },
  {
    id: "0-71-0-stop-one-thing",
    version: "0.71.0",
    title: "Stop one thing, not everything",
    body: "Every row in the running-work bar has a ✕, and a Stop all appears once more than one thing is running — so a session with fifteen stray shells no longer has to be reaped whole.",
    href: `${WHATS_NEW_PAGE}#0710--stop-one-thing-not-everything`,
  },
  {
    id: "0-70-1-linked-directories",
    version: "0.70.1",
    title: "Linked directories, all the way through",
    body: "The Changes tab, the file browser and the Push button act on a linked project's own directory rather than on the backing store, so untracked files render and Push pushes the right repository.",
    href: `${WHATS_NEW_PAGE}#0701--linked-directories-all-the-way-through`,
  },
  {
    id: "0-70-inline-code",
    version: "0.70",
    title: "Inline code you can see",
    body: "Inline code in a chat message has its background back after a token change closed the contrast against the card underneath it to 1.04:1, and blockquotes have their colour again.",
    href: `${WHATS_NEW_PAGE}#070--inline-code-you-can-see`,
  },
  {
    id: "0-69-background-work",
    version: "0.69",
    title: "Background work you can see",
    body: "A bar above the composer names every background task still running, what it is doing and how long it has been going — and a chat with live work no longer reports itself idle.",
    href: `${WHATS_NEW_PAGE}#069--background-work-you-can-see`,
  },
  {
    id: "0-68-discover",
    version: "0.68",
    title: "Discover, and --here is gone",
    body: "Discover reads your Claude Code history and offers the directories you have actually been working in as projects, importing a directory without writing anything into it.",
    href: `${WHATS_NEW_PAGE}#068--discover-and---here-is-gone`,
  },
  {
    id: "0-67-themes-and-fleet-readout",
    version: "0.67",
    title: "A design system, four themes, and the fleet readout",
    body: "Four themes and an accent picker that solves any colour you pick for contrast, in Config under Appearance, plus a live strip above every screen saying what the fleet is doing.",
    href: `${WHATS_NEW_PAGE}#067--a-design-system-four-themes-and-the-fleet-readout`,
  },
  {
    id: "0-66-2-nothing-goes-missing",
    version: "0.66.2",
    title: "Nothing you typed goes missing",
    body: "Five ways work could quietly vanish are fixed: a file staged mid-turn no longer rides your next message, and reloading during a turn no longer discards the reply.",
    href: `${WHATS_NEW_PAGE}#0662--nothing-you-typed-goes-missing`,
  },
  {
    id: "0-66-1-queued-messages",
    version: "0.66.1",
    title: "Queued messages",
    body: "A message typed while a turn is running is held reliably, drains however that turn ends, merges rather than overwrites across two tabs, and comes back to the composer if you press Stop.",
    href: `${WHATS_NEW_PAGE}#0661--queued-messages`,
  },
  {
    id: "0-66-0-config-screen-and-port",
    version: "0.66.0",
    title: "Config screen, and a new default port",
    body: "The instance Config screen gained a section rail, a Modified-only lens and a filter that matches environment variable names — and the default port moved from 4000 to 7233.",
    href: `${WHATS_NEW_PAGE}#0660--config-screen-and-a-new-default-port`,
  },
];

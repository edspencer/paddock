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
//  2. **Still true today.** An entry describes a release *as it shipped*, and a
//     few of these were later superseded on the website (0.61.0 and 0.61.1 both
//     carry forward-links there). The one line kept here is deliberately the
//     part that is still true in the current version — the website entry has the
//     full history for anyone who follows the link.
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
  {
    id: "0-65-promote-project",
    version: "0.65",
    title: "promote_project over MCP",
    body: "An agent can turn its own notebook project into a repo-backed one without losing the chats in it, instead of stopping to ask or starting a second project.",
    href: `${WHATS_NEW_PAGE}#065--promote_project-over-mcp`,
  },
  {
    id: "0-64-linked-directories",
    version: "0.64",
    title: "Linked directories, managed and unmanaged",
    body: "A project can point at a directory that already exists and use it in place — no copy, no clone, nothing written into it — and deleting the project never touches it.",
    href: `${WHATS_NEW_PAGE}#064--linked-directories-managed-and-unmanaged`,
  },
  {
    id: "0-63-host-plugins",
    version: "0.63",
    title: "Host plugins and MCP server fidelity",
    body: "A plugin installed in your own Claude Code works here, and the MCP servers it brings are allow-listed automatically rather than connecting and having every call silently denied.",
    href: `${WHATS_NEW_PAGE}#063--host-plugins-and-mcp-server-fidelity`,
  },
  {
    id: "0-62-claude-inheritance",
    version: "0.62",
    title: "Granular host Claude inheritance options",
    body: "Five independent keys under claude: — transcripts, credentials, instructions, hooks and mcpServers — each decide whether this instance uses its own or the machine's Claude Code state.",
    href: `${WHATS_NEW_PAGE}#062--granular-host-claude-inheritance-options`,
  },
  {
    id: "0-61-1-cli-login-and-symlinks",
    version: "0.61.1",
    title: "CLI login, and symlinks into your Claude home",
    body: "Paddock stopped planting transcript symlinks in a Claude home it does not own, names any leftover ones at startup, and stopped hiding a perfectly good macOS Keychain login.",
    href: `${WHATS_NEW_PAGE}#0611--cli-login-and-symlinks-into-your-claude-home`,
  },
  {
    id: "0-61-0-own-claude-home",
    version: "0.61.0",
    title: "Paddock's own Claude home",
    body: "Transcripts moved out of your ~/.claude and into Paddock's data directory, the last state that still lived outside it; Paddock only ever reads your Claude home now.",
    href: `${WHATS_NEW_PAGE}#0610--paddocks-own-claude-home`,
  },
];

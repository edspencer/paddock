---
title: "Chats are Claude Code sessions"
description: "How chats map to persisted, resumable Claude Code sessions."
---

A **chat** in Paddock is not a Paddock-invented construct — it *is* a **Claude
Code session**, persisted on disk as a transcript and resumable across page
reloads, socket reconnects, server restarts, and even different devices. Paddock
adds the UI, the streaming transport, and the project attribution; the session
itself is Claude Code's.

## Persisted on disk as a transcript

Each chat is one JSONL transcript file, `<sessionId>.jsonl`, **written by the
Claude Code CLI** — Paddock only reads it. Claude Code stores transcripts under
`~/.claude/projects/<encoded-cwd>/`, where the encoded name is the agent's
absolute working directory with non-alphanumeric characters replaced by `-`. So
**the working directory is the session key** — no separate database of chats.

Paddock makes chats portable by symlinking that encoded directory to the
project's `.chats/` folder (`ensureProjectChats()` in `transcripts.ts`), so the
transcript physically lives inside the project directory and rides the same
backup. Listing, reading, resuming, and deleting all resolve transparently through
the symlink.

The transcript is the **authoritative record** of the conversation. Everything
else about a chat is either derived from it (previews, token/context usage, the
rendered message list) or a small piece of side-metadata in a
[server sidecar](/architecture/overview#3-data-model--the-three-storage-classes) —
its archived flag (`ArchiveStore`), your last-seen timestamp (`ReadStateStore`),
and any queued follow-up message (`QueuedMessageStore`).

## Resumable

Starting a chat sends `chat:send` with `sessionId: null`; the session id is
minted by Claude Code and arrives mid-stream (Paddock captures it and attributes
the running session to the project so the chat appears in the sidebar *before*
the turn finishes — issue #100). Every later turn on that chat sends the same
`sessionId`, and the keeper resumes the existing session (`resume: <sessionId>`).

Resumption is robust to interruptions at several layers:

- **Reload / new device** — the client hydrates the chat from the REST transcript
  endpoint; because the transcript is on disk and per-user read-state is a server
  sidecar, the same chat (and its unread state) appears anywhere you log in.
- **Mid-turn reconnect** — the client re-attaches over the WebSocket with
  `chat:subscribe { wantReplay: true, lastSeq }`, and the
  [SessionHub](/architecture/overview#4-websocket--session-flow) replays the buffered
  frames it missed (or tells it to re-hydrate from REST if the buffer aged out).
  A live turn keeps streaming to whoever attaches.
- **Server restart** — the transcript and all sidecars are on disk, so chats
  survive; a resumed turn picks up from the persisted session.

## Forking

A chat can be **forked** into a parallel child: `forkSession` *copies* the
transcript and mints a new session id, so the child diverges without touching the
parent. (Contrast with promotion, which *moves* a scratch chat into a project —
see [Keeper vs. scratch](/concepts/keeper-and-scratch).) Forked children run under the
same keeper (up to `KEEPER_MAX_CONCURRENT` in parallel) and appear as their own
chats in the sidebar.

## In one line

> A chat is a resumable Claude Code session whose transcript lives on disk inside
> its project; Paddock streams it live and lets you pick it back up from anywhere.

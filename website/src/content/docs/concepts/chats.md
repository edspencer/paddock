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
`<claudeHome>/projects/<encoded-cwd>/`, where the encoded name is the agent's
absolute working directory with non-alphanumeric characters replaced by `-`. So
**the working directory is the session key** — no separate database of chats.
Paddock always runs Claude Code against a Claude home it owns —
`<dataDir>/claude-home` — so that path is
`<dataDir>/claude-home/projects/<encoded-cwd>/`.

Paddock then symlinks that encoded directory, and
[`claude.transcripts`](/configuration/config-file/#transcripts) decides where the
symlink points (`ensureProjectChats()` in `transcripts.ts`). Under the default
`transcripts: own` it targets the project's `.chats/` folder, so the transcript
physically lives inside the project directory and rides the same backup. Under
`transcripts: host` it targets the user's real `~/.claude/projects/<encoded-cwd>/`
instead, so chats are shared with the machine's own terminal `claude` history.

Listing, reading, and resuming resolve transparently through the symlink either
way. **Deleting does not.** Under `transcripts: host` the transcript is the user's
own `claude` history rather than Paddock's copy, so `HerdctlService.deleteSession`
*releases* the chat instead of removing it (`{removed: false, retained: true}`) and
the file stays on disk. Releasing only drops the adoption record, so the chat is
**still listed** afterwards — the engine rediscovers the transcript structurally on
the next listing. That gap is tracked as
[issue #693](https://github.com/edspencer/paddock/issues/693).

The transcript is the **authoritative record** of the conversation. Everything
else about a chat is either derived from it (previews, token/context usage, the
rendered message list) or a small piece of side-metadata in a
[server sidecar](/architecture/overview#3-data-model--the-three-storage-classes) —
its archived flag (`ArchiveStore`), its starred flag (`StarStore`), your
last-seen timestamp (`ReadStateStore`), your manual "mark unread" override
(`UnreadStore`), and any queued follow-up message (`QueuedMessageStore`).
Archive and star are shared; read-state and the unread override are per user.

## Resumable

Starting a chat sends `chat:send` with `sessionId: null`; the session id is
minted by Claude Code and arrives mid-stream (Paddock captures it and attributes
the running session to the project so the chat appears in the sidebar *before*
the turn finishes — issue #100). Every later turn on that chat sends the same
`sessionId`, and Claude resumes the existing session (`resume: <sessionId>`).

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

## Token-by-token streaming

A reply can accrete into the live bubble **token-by-token** as the model produces
it, rather than landing in one drop when the turn ends. This is a
property of the **runtime**, not the transport:

- **Session mode (SDK runtime)** opts into partial (streaming) assistant messages
  — herdctl surfaces incremental `text_delta` chunks, which the WebSocket layer
  forwards as `chat:response` frames that append to the bubble as they arrive.
- **Batch mode (CLI runtime)** renders each assistant message **whole** when it
  completes; there's no intra-message streaming.

The drive mode is set by `PADDOCK_DRIVE_MODE` (with a per-project
`driveMode` override) — see
[Agents](/configuration/environment/#agents). Everything else about a chat is
identical either way: the transport was already delta-shaped, so
re-attach and replay behave the same whether or not tokens stream.

## Forking

A chat can be **forked** into a parallel child: `forkSession` *copies* the
transcript and mints a new session id, so the child diverges without touching the
parent. (Contrast with promotion, which *moves* a root chat into a project of its own —
see [Agents](/concepts/agents).) Forked children run under the same agent (up to
`KEEPER_MAX_CONCURRENT` in parallel) and are full chats in their own right —
resumable, forkable, archivable.

A fork you make yourself is **named before it exists**, whichever way you start
it: both the sidebar's per-chat fork button and the transcript's *Fork a new chat
from here* open the same dialog, pre-filled with *"Fork of ⟨chat⟩"*. They differ
only in how much of the parent comes along — the whole transcript, or just the
prefix up to the message you branched at.

In the sidebar a fork is **filed underneath the chat it was forked from**, so
splitting a conversation three ways gives you one foldable family rather than
three unrelated rows. That's true however the fork was made — by you from the
message hover rail, or by Claude calling `fork_chat` — and note it nests under
its **source**, which for a Claude-made fork isn't necessarily the chat that made
it. See [Provenance](/concepts/provenance/#from-badge-to-structure) for how
that edge is recorded, and for the spawn-depth consequence of forking a fork.

## A queued follow-up is shared chat state

Type a second message while a turn is running and it goes into the chat's
**queue slot** — one slot per chat, not one per device. Since #629 the slot is
shared state: a write **merges** contributions and is broadcast to every socket
attached to the chat (`chat:queued_state`), so both devices render the same
pending text and the same staged attachments. Before that, a second client
silently overwrote the first's text, and the drain later rendered — as that
user's own bubble — a message they had never typed.

Pressing **Stop** does *not* send the queued message. It returns it to your
composer (`chat:queued_returned`), where it is visible and editable, and goes
only when you say so. Stop means "give me control back"; auto-sending would have
the agent start working again the instant you stopped it.

## Destructive operations wait for the turn to die

`claude` — not Paddock — writes the transcript, straight through the symlink, so
deleting or rewriting the file while a turn runs is a race against a live
subprocess that still holds that path. It used to lose the conversation: the
unlink landed, and ~45 seconds later the still-running process re-created the
same file containing only its own tail.

So since #731, **delete**, **batch delete**, **revert** and
[promote](/concepts/agents#promotion-giving-a-chat-its-own-project) all
**quiesce** the chat first. Paddock cancels the turn, reaps the managed session
(cancelling alone only ends the model turn — the session and its subprocess stay
alive for the next message), and then *polls two liveness signals* until both
agree the session is dead. Only then does it touch the file. If it cannot get
that answer within 10 seconds it refuses, returning
**`409 { code: "turn_running" }`** rather than mutating; a successful call
reports `cancelledTurn` so the UI can say what it stopped.

**Forking is deliberately exempt.** A fork copies rather than mutates, and
forking mid-turn is a designed feature — so instead of stopping your turn, the
copy is trimmed back to the last fully-paired `tool_use` boundary.

## In one line

> A chat is a resumable Claude Code session whose transcript lives on disk inside
> its project; Paddock streams it live and lets you pick it back up from anywhere.

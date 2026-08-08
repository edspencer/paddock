---
title: "WebSocket protocol"
description: "The /ws frame protocol behind Paddock's live chat: envelope, routing, and every client and server frame."
---

The chat back-and-forth runs over a single WebSocket at **`/ws`**, registered
behind the same auth hook as REST. The web client opens one shared socket
(`packages/web/src/lib/ws.ts`), auto-reconnects, and keeps it alive with a JSON
`ping`/`pong` every 25s (plus protocol-level WS pings server-side).

This protocol is deliberately **not** part of the [OpenAPI spec](/api/) — that
document is generated from Fastify route schemas and can only describe the HTTP
surface. This page is the hand-maintained contract for the WebSocket, and the
only place it is written down.

## Envelope

Every frame is a JSON object **`{ type, payload }`** (`ping`/`pong` are just
`{ type }`, no payload). `type` is the message kind.

Server→client **chat events** carry a common **`Routing`** block in `payload`:

| Field | Type | Notes |
|-------|------|-------|
| `projectSlug` | `string` | Workspace key — a project slug, or `""` for the root workspace. |
| `sessionId` | `string \| null` | Null until a brand-new chat's id first streams back. |
| `jobId` | `string \| null` | The cancellable job id, when known. |
| `seq` | `number?` | Per-turn monotonic sequence for reconnect/gap-replay. Absent on frames not stamped by the hub's `emit` — `chat:error`, `chat:resync`, `chat:active`, `chat:queued_flushed`, `chat:queued_state`, `chat:queued_returned`, `chat:killed_task`, `pong`. Those last four go out via `hub.broadcast`, which reaches the origin socket **and** every subscriber without seq-stamping or buffering, precisely so an out-of-band signal still reaches a client that reconnected on a new socket. |

Client→server payloads carry `projectSlug`. Invalid JSON / unknown kinds get a `chat:error` reply.

## Client → server

| Kind | When it fires | Payload (beyond `projectSlug`) |
|------|---------------|------------------------------------------|
| `chat:subscribe` | On (re)connect, to attach a socket to a session's live stream and replay any missed gap. | `sessionId: string`, `wantReplay?: boolean`, `lastSeq?: number` |
| `chat:send` | User (or a server-side queue drain) sends a message / starts or resumes a turn. | `sessionId?: string \| null` (null ⇒ new chat), `message: string`, `preloadContext?: boolean`, `model?: string`, `attachments?: AttachmentRef[]` |
| `chat:command` | User runs a slash command (e.g. `/compact`) in the current chat. | `sessionId?: string \| null`, `command: string` (full text incl. leading slash) |
| `chat:cancel` | User clicks Stop; cancels the running turn's job. | `jobId: string` |
| `chat:set_queue` | Write/clear the chat's single queue slot server-side (survives browser close, and is **shared** across clients — see `chat:queued_state`). | `sessionId?: string \| null`, `text?: string \| null` (null/empty ⇒ clear), `qid?: string \| null`, `attachments?: AttachmentRef[]`, `ts?: number \| null` *(legacy)* |
| `chat:continue` | The **Continue** button on a killed-task notice — re-drives a hung chat with a recovery-attributed nudge (`sender: { kind: "recovery" }`). Refused server-side when the resolved `recovery.surfaceKilledTask` is off, so a client can't re-drive an instance whose operator turned Layer 2 off. | `sessionId: string` (**required** — recovery needs a chat), `projectSlug?: string` |
| `ping` | Client keepalive every 25s. | *(none)* |

**`AttachmentRef`** (on `chat:send` and `chat:set_queue`):
`{ id: string, filename: string, kind?: string }`. Each references an attachment
already uploaded via
[`POST …/chats/:id/upload`](/reference/api/) — the frame carries the reference,
never the bytes. Project chats only.

:::note[`qid`, and why `ts` is legacy]
`qid` is the **opaque** identity of a queue slot: minted once when the queue is
first created and kept across edits, appends and reloads, so the server can tell
this client updating its own queue apart from another client queueing alongside
it, and a stale re-assert of an already-drained message apart from a new one.

`ts` was the original identity and is still accepted — an older client sends only
that, and the server folds it into an id. But it is compared for **equality only**
and is never stored as the enqueue time; the server stamps that itself. Treating
it as an *ordered* identity is what let one client with a fast clock poison the
dedup marker and silently destroy every later queued message on that chat, from
any client ([#736](https://github.com/edspencer/paddock/issues/736)). Send `qid`.
:::

## Server → client

| Kind | When it fires | Payload (beyond `Routing`) |
|------|---------------|-----------------------------|
| `chat:active` | A session's live-turn status changed (start/stop); broadcast to all clients, and sent as a snapshot to a newly-connected or subscribing socket. | `sessionId: string`, `jobId: string \| null`, `running: boolean` (this frame carries its own `projectSlug`/`sessionId`, no `seq`) |
| `chat:response` | A streamed assistant text delta. Also surfaces a `/compact` boundary as a synthetic note. | `chunk: string` |
| `chat:tool_start` | A tool_use begins (before it runs) — renders a pending "running…" row. | `toolName: string`, `inputSummary?: string`, `toolUseId?: string`, `parentToolUseId: string \| null`, `subagentType?: string`, `description?: string`, `hasSubagent?: boolean` |
| `chat:tool_call` | A tool completes (paired tool_use→tool_result); reconciles the pending row. | `toolName: string`, `inputSummary?: string`, `output: string`, `isError: boolean`, `durationMs?: number`, `toolUseId?: string`, `subagentType?: string`, `description?: string`, `hasSubagent?: boolean` |
| `chat:message_boundary` | An assistant message bubble ended. | *(Routing only)* |
| `chat:complete` | The turn finished (success or failure); carries final usage/model. | `success: boolean`, `error?: string`, `model?: string`, `usage?: ChatCompleteUsage` |
| `chat:error` | A turn threw before/without a resolved session (sent to the origin socket only); also the reply to invalid JSON / unknown frames. | `projectSlug: string`, `error: string` (no `sessionId`/`jobId`/`seq`) |
| `chat:resync` | Reconnect fallback: the live turn's frame buffer aged out past the requested gap, so the client must re-hydrate from the transcript. | `projectSlug: string`, `sessionId: string` |
| `chat:injected` | A **resumed** turn received its prompt. Emitted once per turn, and only on a resume, so a client can render the injected message attributed to whoever (or whatever) sent it. | `sender: MessageSender`, `content: string`, `timestamp: string` (ISO) |
| `chat:queued_flushed` | The server auto-drained the queued message after a turn (or when idle). | `projectSlug: string`, `sessionId: string`, `text?: string` (present ⇒ render as a user bubble; absent ⇒ just clear a stale copy), `attachments?: AttachmentRef[]` (only alongside `text`) |
| `chat:queued_state` | The chat's queue slot was written. **Broadcast to every socket attached to the session**, so the queue is shared chat state that all clients render identically. | `projectSlug: string`, `sessionId: string`, `text: string \| null` (null ⇒ the slot is now empty), `attachments?: AttachmentRef[]`, `qid?: string` (adopt it, so your next edit updates this slot in place rather than appending beside it), `reason?: "returned"` |
| `chat:queued_returned` | A user pressed Stop, so the message queued behind that turn is handed **back** to them. Sent **only to the socket that issued `chat:cancel`**; the other clients get a `chat:queued_state` with `reason: "returned"` instead. | `projectSlug: string`, `sessionId: string`, `text: string`, `attachments?: AttachmentRef[]` |
| `chat:killed_task` | A background task the chat was waiting on was killed. Broadcast **live**, the moment the recovery engine detects it — otherwise the notification sits in the SDK input queue until some later turn flushes it, and the "Claude is idle / Continue" affordance only appears after a manual refresh. Rendered as the amber killed-task notice. Gated on `recovery.surfaceKilledTask`, which is **on by default**. | `projectSlug: string`, `sessionId: string`, `summary: string` (the killed `<task-notification>`'s `<summary>`, or a generic fallback), `timestamp: string` (ISO, used client-side to dedup replays) |
| `chat:notice` | A turn dead-ended without a normal reply — a usage/subscription limit, the max-turns cap, or an error (network, API 5xx-overloaded, auth, crash). Emitted **inline during the turn** and session-routed like the other turn frames, so the chat says *why* it stopped instead of looking dead. | `notice: TurnNotice` (carries the reset time for a usage limit, and `retryable` for the Retry/Continue affordance) |
| `pong` | Reply to a client `ping`. | *(none)* |

**`ChatCompleteUsage`** (on `chat:complete`): `inputTokens`, `outputTokens`,
`cacheReadTokens`, `cacheCreationTokens`, `contextTokens` (= input + cacheRead +
cacheCreation), `contextLimit` (= the model's context limit). Stale-by-one-turn by
design.

## The queue frames

The queued message is **shared chat state**, not per-client state, and that takes
four frames plus the inbound `chat:set_queue`. Which one you get says what
happened to the slot:

| Frame | Direction | Meaning |
|---|---|---|
| `chat:set_queue` | client → server | Write or clear the slot. Contributions **merge**; attachments union by id, so one client's write can never silently drop another's file. |
| `chat:queued_state` | server → **all** attached sockets | The slot changed; here is its full current contents. This is what makes the merge visible. |
| `chat:queued_flushed` | server → all | The slot was **drained and sent** as a turn. Render `text` as the user bubble — the drained turn streams only the reply. |
| `chat:queued_returned` | server → **the stopping socket only** | Stop was pressed; the message was **not** sent and goes back into that user's composer. |

The `_returned` / `_flushed` split is deliberate and not a flag on one frame:
`_flushed` means "this text was sent, render it as the user's bubble", and a
returned message is precisely one that was *not* sent. Overloading it would put a
phantom user turn in the transcript for a message the agent never received.

> Notes: There is **no** `chat:tool_end` (completion is `chat:tool_call`), no
> bare `chat:queued`, and no dedicated snapshot frame — `chat:active` doubles as
> the on-connect snapshot, and reconnect/replay flows through `chat:subscribe` →
> (replay | `chat:resync`). A `/compact` compaction is folded into a
> `chat:response` chunk + `chat:message_boundary`, not its own kind.

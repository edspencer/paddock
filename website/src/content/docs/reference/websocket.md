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
| `seq` | `number?` | Per-turn monotonic sequence for reconnect/gap-replay. Absent on frames not stamped by the hub's `emit` — `chat:error`, `chat:resync`, `chat:active`, `chat:queued_flushed`, `chat:queued_state`, `chat:queued_returned`, `chat:killed_task`, `chat:background`, `pong`. Those last five (`chat:queued_flushed` through `chat:background`) go out via `hub.broadcast`, which reaches the origin socket **and** every subscriber without seq-stamping or buffering, precisely so an out-of-band signal still reaches a client that reconnected on a new socket. |

Client→server payloads carry `projectSlug`. Invalid JSON / unknown kinds get a `chat:error` reply.

## Client → server

| Kind | When it fires | Payload (beyond `projectSlug`) |
|------|---------------|------------------------------------------|
| `chat:subscribe` | On (re)connect, to attach a socket to a session's live stream and replay any missed gap. | `sessionId: string`, `wantReplay?: boolean`, `lastSeq?: number` |
| `chat:send` | User (or a server-side queue drain) sends a message / starts or resumes a turn. | `sessionId?: string \| null` (null ⇒ new chat), `message: string`, `preloadContext?: boolean`, `model?: string`, `attachments?: AttachmentRef[]` |
| `chat:command` | User runs a slash command (e.g. `/compact`) in the current chat. | `sessionId?: string \| null`, `command: string` (full text incl. leading slash) |
| `chat:cancel` | User clicks Stop; cancels the running turn's job. | `jobId: string` |
| `chat:stop_task` | Stop **one** piece of background work from the running-work bar ([#848](https://github.com/edspencer/paddock/issues/848)), leaving the session and everything else it is running alone — the finer-grained sibling of `chat:cancel`. Keyed on the **session**, not a job or turn id, because background work outlives the turn that started it. Answered by exactly one `chat:stop_task_result`. Both ids must be non-empty. | `sessionId: string`, `taskId: string` (the SDK `task_id`, = `LiveBackgroundTaskWire.id`) |
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
| `chat:active` | A session's live-turn status changed (start/stop); broadcast to all clients, and sent as a snapshot to a newly-connected or subscribing socket. Since [#604](https://github.com/edspencer/paddock/issues/604) it also fires when the session's background-task set flips it between busy and idle — but only when the answer actually changes, so a task starting or stopping mid-turn does not re-broadcast. | `sessionId: string`, `jobId: string \| null`, `running: boolean`, `turnRunning?: boolean`, `startedAt?: number` (epoch-ms the turn began, from the hub — the only thing that knows, since a job record is written when a turn *ends* and the transcript's timestamps are the model's; present on the stop frame too, where it describes the turn that just ended. This frame carries its own `projectSlug`/`sessionId`, no `seq`) |
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
| `chat:background` | A session's set of live background tasks changed ([#604](https://github.com/edspencer/paddock/issues/604)). **A LEVEL frame with REPLACE semantics** — `tasks` is the complete set, and an empty array means "nothing is running". A client swaps its whole set rather than pairing start/stop edges, so a dropped frame cannot wedge a stale indicator. Broadcast on every membership change, and replayed to a newly-connected socket, so a remount or a reload learns what is in flight without polling. | `projectSlug: string`, `sessionId: string`, `tasks: LiveBackgroundTaskWire[]` |
| `chat:stop_task_result` | The answer to one `chat:stop_task` ([#848](https://github.com/edspencer/paddock/issues/848)). **Unicast to the asking socket** — it answers one client's request, and a second viewer should not be shown an error for a click it did not make; both still agree on the result, because a row's actual removal travels on the broadcast `chat:background`. The **only frame with no `Routing`**: a session id is already globally unique, so no `projectSlug` is carried. `stopping` = accepted, hold the row until the runtime's terminal notification removes it (also the idempotent case — a click that raced a natural completion). `gone` = no live session, so the work died with it; **not** an error, and the server has already dropped the task from its own registry because nothing is left to notify. `error` = the stop did **not** happen and the task is **still running** (notably a `monitor_mcp` task, which the CLI has no kill strategy for). Because this frame is unicast and unrouted, the hub neither buffers nor replays it, so a socket drop between the send and the reply loses it outright — a client must therefore put its own deadline on the held row rather than waiting forever. | `sessionId: string`, `taskId: string`, `outcome: "stopping" \| "gone" \| "error"`, `message?: string` (only on `error`) |
| `chat:notice` | A turn dead-ended without a normal reply — a usage/subscription limit, the max-turns cap, or an error (network, API 5xx-overloaded, auth, crash). Emitted **inline during the turn** and session-routed like the other turn frames, so the chat says *why* it stopped instead of looking dead. | `notice: TurnNotice` (carries the reset time for a usage limit, and `retryable` for the Retry/Continue affordance) |
| `pong` | Reply to a client `ping`. | *(none)* |

**`ChatCompleteUsage`** (on `chat:complete`): `inputTokens`, `outputTokens`,
`cacheReadTokens`, `cacheCreationTokens`, `contextTokens` (= input + cacheRead +
cacheCreation), `contextLimit` (= the model's context limit). Stale-by-one-turn by
design.

**`LiveBackgroundTaskWire`** (on `chat:background`): `id`, `type`, `role`,
`description`, `startedAt` (epoch-ms), plus the optional `toolUseId`,
`agentType`, `command`, `workflowName`, `server`, `tool`, `lastToolName`,
`toolUses`, `skipTranscript` and `stoppable`.

`type` is the **raw SDK discriminant** — `local_bash`, `local_agent`,
`monitor_mcp`, … — carried verbatim so an unexpected kind stays diagnosable from
the wire. `role` ([#846](https://github.com/edspencer/paddock/issues/846)) is the
rendering role the server derives from it (`shell` | `subagent` | `monitor` |
`workflow` | `task`, falling back to the raw discriminant for a kind the server
does not know). **Render from `role`, not `type`**; treat an unknown value as a
task, not as an error.

`stoppable` ([#848](https://github.com/edspencer/paddock/issues/848)) says
whether `chat:stop_task` may be sent for this task. It is resolved on the server
from `type`, and sent rather than left to the client because it is a fact about
the *runtime's* capability rather than about rendering — the server owns which
task types the CLI has a kill strategy for, and a second copy of that list in the
client is a second place to forget when the SDK gains one. `role` alone is not
enough either: `monitor_ws` and `monitor_mcp` share the `monitor` role and only
the first is killable. Absent means stoppable, so a client older than the field
still offers the button.
Which of the optionals are populated depends on the kind of work: a shell carries
`command`, a workflow `workflowName`, a sub-agent `agentType`.

Nothing here is reconstructed from disk — the signal is per-process. After a
server restart the set is empty until the next change, which is correct: Paddock
stops the fleet with `waitForJobs: false`, so those tasks are dead.

:::note[`running` and `turnRunning` answer different questions]
Since `chat:background` exists, `chat:active.running` is true whenever a **model
turn** is in flight **or** the session is holding live background work. That is
what status readouts want — the sidebar dot, the [fleet
readout](/using/working-in-chats/#what-the-whole-fleet-is-doing), the Home
in-flight badge, the running-only filter — because a chat with a `Monitor` in it
genuinely is busy.

`turnRunning` is the narrower signal: a model turn, and nothing else. The web
client gates the composer lock and the working indicator on it, because a
background task can run for an hour and locking the composer for that hour would
misdescribe what is happening. It is **optional on the wire**, so a client built
against an older server still parses the frame; such a client should fall back to
`running`, which is what it read before.
:::

:::note[This page documents what the server sends, not what the types say]
Two places in the code currently understate the protocol, so neither is a safe
source to "correct" this page against:

- **`chat:injected` is not a member of the server's `ServerMessage` union.** It is
  emitted through a loosely-typed seam, so the union is not the authoritative
  frame list — [#772](https://github.com/edspencer/paddock/issues/772).
- **The web client's mirrored frame types are stale on the queue attachments**,
  with inline casts hiding the drift, so the client mirror understates
  `chat:queued_flushed`, `chat:queued_state` and `chat:queued_returned` —
  [#773](https://github.com/edspencer/paddock/issues/773).

The payloads above are taken from `ws-protocol.ts` and the emit sites, which is
what actually goes on the wire.
:::

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

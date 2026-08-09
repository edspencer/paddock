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
| `seq` | `number?` | Per-turn monotonic sequence for reconnect/gap-replay. Absent on frames not routed through the hub (`chat:error`, `chat:resync`, `chat:active`, `chat:queued_flushed`, `pong`). |

Client→server payloads carry `projectSlug`. Invalid JSON / unknown kinds get a `chat:error` reply.

## Client → server

| Kind | When it fires | Payload (beyond `projectSlug`) |
|------|---------------|------------------------------------------|
| `chat:subscribe` | On (re)connect, to attach a socket to a session's live stream and replay any missed gap. | `sessionId: string`, `wantReplay?: boolean`, `lastSeq?: number` |
| `chat:send` | User (or a server-side queue drain) sends a message / starts or resumes a turn. | `sessionId?: string \| null` (null ⇒ new chat), `message: string`, `preloadContext?: boolean`, `model?: string` |
| `chat:command` | User runs a slash command (e.g. `/compact`) in the current chat. | `sessionId?: string \| null`, `command: string` (full text incl. leading slash) |
| `chat:cancel` | User clicks Stop; cancels the running turn's job. | `jobId: string` |
| `chat:set_queue` | Persist/clear the single-slot composer queue server-side (survives browser close). | `sessionId?: string \| null`, `text?: string \| null` (null/empty ⇒ clear), `ts?: number \| null` |
| `chat:continue` | The **Continue** button on a killed-task notice — re-drives a hung chat with a recovery-attributed nudge (`sender: { kind: "recovery" }`). Refused server-side when the resolved `recovery.surfaceKilledTask` is off, so a client can't re-drive an instance whose operator turned Layer 2 off. | `sessionId: string` (**required** — recovery needs a chat), `projectSlug?: string` |
| `ping` | Client keepalive every 25s. | *(none)* |

## Server → client

| Kind | When it fires | Payload (beyond `Routing`) |
|------|---------------|-----------------------------|
| `chat:active` | A session's live-turn status changed (start/stop); broadcast to all clients, and sent as a snapshot to a newly-connected or subscribing socket. | `sessionId: string`, `jobId: string \| null`, `running: boolean`, `startedAt?: number` (epoch-ms the turn began, from the hub — the only thing that knows, since a job record is written when a turn *ends* and the transcript's timestamps are the model's; present on the stop frame too, where it describes the turn that just ended. This frame carries its own `projectSlug`/`sessionId`, no `seq`) |
| `chat:response` | A streamed assistant text delta. Also surfaces a `/compact` boundary as a synthetic note. | `chunk: string` |
| `chat:tool_start` | A tool_use begins (before it runs) — renders a pending "running…" row. | `toolName: string`, `inputSummary?: string`, `toolUseId?: string`, `parentToolUseId: string \| null` |
| `chat:tool_call` | A tool completes (paired tool_use→tool_result); reconciles the pending row. | `toolName: string`, `inputSummary?: string`, `output: string`, `isError: boolean`, `durationMs?: number`, `toolUseId?: string` |
| `chat:message_boundary` | An assistant message bubble ended. | *(Routing only)* |
| `chat:complete` | The turn finished (success or failure); carries final usage/model. | `success: boolean`, `error?: string`, `model?: string`, `usage?: ChatCompleteUsage` |
| `chat:error` | A turn threw before/without a resolved session (sent to the origin socket only); also the reply to invalid JSON / unknown frames. | `projectSlug: string`, `error: string` (no `sessionId`/`jobId`/`seq`) |
| `chat:resync` | Reconnect fallback: the live turn's frame buffer aged out past the requested gap, so the client must re-hydrate from the transcript. | `projectSlug: string`, `sessionId: string` |
| `chat:queued_flushed` | The server auto-drained the persisted queued message after a turn (or when idle). | `projectSlug: string`, `sessionId: string`, `text?: string` (present ⇒ render as a user bubble; absent ⇒ just clear a stale copy) |
| `chat:killed_task` | A background task the chat was waiting on was killed. Broadcast **live**, the moment the recovery engine detects it — otherwise the notification sits in the SDK input queue until some later turn flushes it, and the "Claude is idle / Continue" affordance only appears after a manual refresh. Rendered as the amber killed-task notice. Gated on `recovery.surfaceKilledTask`, which is **on by default**. | `projectSlug: string`, `sessionId: string`, `summary: string` (the killed `<task-notification>`'s `<summary>`, or a generic fallback), `timestamp: string` (ISO, used client-side to dedup replays) |
| `chat:notice` | A turn dead-ended without a normal reply — a usage/subscription limit, the max-turns cap, or an error (network, API 5xx-overloaded, auth, crash). Emitted **inline during the turn** and session-routed like the other turn frames, so the chat says *why* it stopped instead of looking dead. | `notice: TurnNotice` (carries the reset time for a usage limit, and `retryable` for the Retry/Continue affordance) |
| `pong` | Reply to a client `ping`. | *(none)* |

**`ChatCompleteUsage`** (on `chat:complete`): `inputTokens`, `outputTokens`,
`cacheReadTokens`, `cacheCreationTokens`, `contextTokens` (= input + cacheRead +
cacheCreation), `contextLimit` (= the model's context limit). Stale-by-one-turn by
design.

> Notes: There is **no** `chat:tool_end` (completion is `chat:tool_call`), no
> `chat:queued` (drain is `chat:queued_flushed`), and no dedicated snapshot frame —
> `chat:active` doubles as the on-connect snapshot, and reconnect/replay flows
> through `chat:subscribe` → (replay | `chat:resync`). A `/compact` compaction is
> folded into a `chat:response` chunk + `chat:message_boundary`, not its own kind.

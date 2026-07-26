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
| `projectSlug` | `string` | Project slug, or `"scratch"` for one-off chats. |
| `target` | `string` | Legacy alias for `projectSlug` (server emits both). |
| `sessionId` | `string \| null` | Null until a brand-new chat's id first streams back. |
| `jobId` | `string \| null` | The cancellable job id, when known. |
| `seq` | `number?` | Per-turn monotonic sequence for reconnect/gap-replay. Absent on frames not routed through the hub (`chat:error`, `chat:resync`, `chat:active`, `chat:queued_flushed`, `pong`). |

Client→server payloads accept **either** `projectSlug` **or** the legacy `target`
alias. Invalid JSON / unknown kinds get a `chat:error` reply.

## Client → server

| Kind | When it fires | Payload (beyond `projectSlug`/`target`) |
|------|---------------|------------------------------------------|
| `chat:subscribe` | On (re)connect, to attach a socket to a session's live stream and replay any missed gap. | `sessionId: string`, `wantReplay?: boolean`, `lastSeq?: number` |
| `chat:send` | User (or a server-side queue drain) sends a message / starts or resumes a turn. | `sessionId?: string \| null` (null ⇒ new chat), `message: string`, `preloadContext?: boolean`, `model?: string` |
| `chat:command` | User runs a slash command (e.g. `/compact`) in the current chat. | `sessionId?: string \| null`, `command: string` (full text incl. leading slash) |
| `chat:cancel` | User clicks Stop; cancels the running turn's job. | `jobId: string` |
| `chat:set_queue` | Persist/clear the single-slot composer queue server-side (survives browser close). | `sessionId?: string \| null`, `text?: string \| null` (null/empty ⇒ clear), `ts?: number \| null` |
| `ping` | Client keepalive every 25s. | *(none)* |

## Server → client

| Kind | When it fires | Payload (beyond `Routing`) |
|------|---------------|-----------------------------|
| `chat:active` | A session's live-turn status changed (start/stop); broadcast to all clients, and sent as a snapshot to a newly-connected or subscribing socket. | `sessionId: string`, `jobId: string \| null`, `running: boolean` (this frame carries its own `projectSlug`/`target`/`sessionId`, no `seq`) |
| `chat:response` | A streamed assistant text delta. Also surfaces a `/compact` boundary as a synthetic note. | `chunk: string` |
| `chat:tool_start` | A tool_use begins (before it runs) — renders a pending "running…" row. | `toolName: string`, `inputSummary?: string`, `toolUseId?: string`, `parentToolUseId: string \| null` |
| `chat:tool_call` | A tool completes (paired tool_use→tool_result); reconciles the pending row. | `toolName: string`, `inputSummary?: string`, `output: string`, `isError: boolean`, `durationMs?: number`, `toolUseId?: string` |
| `chat:message_boundary` | An assistant message bubble ended. | *(Routing only)* |
| `chat:complete` | The turn finished (success or failure); carries final usage/model. | `success: boolean`, `error?: string`, `model?: string`, `usage?: ChatCompleteUsage` |
| `chat:error` | A turn threw before/without a resolved session (sent to the origin socket only); also the reply to invalid JSON / unknown frames. | `projectSlug: string`, `target: string`, `error: string` (no `sessionId`/`jobId`/`seq`) |
| `chat:resync` | Reconnect fallback: the live turn's frame buffer aged out past the requested gap, so the client must re-hydrate from the transcript. | `projectSlug: string`, `target: string`, `sessionId: string` |
| `chat:queued_flushed` | The server auto-drained the persisted queued message after a turn (or when idle). | `projectSlug: string`, `target: string`, `sessionId: string`, `text?: string` (present ⇒ render as a user bubble; absent ⇒ just clear a stale copy) |
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

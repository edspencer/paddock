# API reference

Paddock exposes a **REST API** under `/api` (`packages/server/src/routes.ts`) and a
single **WebSocket** endpoint at `/ws` for live chat (`packages/server/src/ws.ts`,
`session-hub.ts`). REST handles reads, project/chat management, and git; the actual
back-and-forth of a chat turn happens over the WebSocket.

## Authentication

Every request passes through the auth layer (`packages/server/src/auth.ts`) chosen
by `PADDOCK_AUTH_MODE` (see [CONFIGURATION.md](CONFIGURATION.md) and
[AUTH.md](../AUTH.md)):

- In **`none`** mode (default) every request is the frozen anonymous principal —
  the API is fully open.
- In **`trusted-header`** / **`jwt`** modes the proxy/IdP identity becomes
  `req.user`, and per-user **read-state** (unread/seen) is keyed by username.
- **`GET /api/health` is always exempt** (liveness probe).
- There is **no per-resource authorization** — chat visibility is deliberately not
  gated (#189). "Auth" below means "the configured mode must admit the request".

In the tables, the **Auth** column is `gated` for the standard path and `exempt`
for the health probe. Responses are JSON unless noted; `:slug`/`:sessionId` errors
return `{ error, code }` with `404` (not found), `409` (exists), or `400`
(invalid); unexpected errors return `500`.

---

## REST endpoints

### System & identity

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| GET | `/api/health` | Liveness probe → `{ ok: true }`. | exempt |
| GET | `/api/me` | The authenticated principal (`req.user`); anonymous `{ username: "anonymous", anonymous: true }` in `none` mode. | gated |
| GET | `/api/models` | Selectable models + agent/sweeper defaults + `driveModeDefault`. | gated |
| GET | `/api/fleet` | Fleet status + agents (`{ status, agents }`; `error` on failure). | gated |

### Git backing store & GitHub

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| GET | `/api/git` | Backing-store remote + GitHub connection state (`{ ...remote, github }`). | gated |
| POST | `/api/git/push` | Push the working tree to the configured remote. | gated |
| POST | `/api/git/github/connect` | Begin the GitHub device-flow auth. | gated |
| POST | `/api/git/github/poll` | Poll the device flow — body `{ deviceCode }`. | gated |
| POST | `/api/git/github/disconnect` | Disconnect GitHub → `{ ok: true }`. | gated |

### Voice dictation

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| GET | `/api/transcription` | Dictation capability probe → `{ available, mode, model }`. | gated |
| POST | `/api/transcribe` | Transcribe a recorded audio blob (multipart `file`) → `{ text, model, mode, durationMs }`. `503` if disabled, `413` oversize. | gated |

### Projects

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| GET | `/api/projects` | `{ projects, root }` — the root workspace's CHILDREN, each with a compact `chatTurns` unread signal, plus the `root` workspace itself carrying the same field (never a member of `projects`, so the sidebar's Home badge and a project row's badge fold one payload). `root` is `null` only if the record could not be read. | gated |
| POST | `/api/projects` | Create a project (+ its agent & sweeper) → `201 { project }`. | gated |
| GET | `/api/projects/:slug` | One project + its `changelog` + `overview` (raw `CHANGELOG.md` / `OVERVIEW.md` text, `""` when absent) + `chats`. | gated |
| PATCH | `/api/projects/:slug` | Update project metadata (model, permissionMode, maxTurns, docker, driveMode, …); re-registers the agent. `400` on invalid field. | gated |
| DELETE | `/api/projects/:slug` | Delete the project dir + unregister its agents → `{ ok, slug }`. | gated |

### Project files & pins

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| GET | `/api/projects/:slug/files` | List the project's freeform files. | gated |
| GET | `/api/projects/:slug/files/:name` | One file + render-kind hint (`markdown`/`html`/`text`/`image`). `?raw=1` streams raw bytes (locked-down CSP). | gated |
| GET | `/api/projects/:slug/changelog` | Raw `CHANGELOG.md` (`text/markdown`). | gated |
| GET | `/api/projects/:slug/overview` | Raw `OVERVIEW.md` (sweep-curated; `""` if none). | gated |
| GET | `/api/projects/:slug/commands` | Slash commands for the project's agent. | gated |
| PUT | `/api/projects/:slug/pins` | Pin a file as a sibling tab — body `{ file }`. | gated |
| DELETE | `/api/projects/:slug/pins/:file` | Unpin a file (URL-encoded name). | gated |
| GET | `/api/chat-files/:id` | Raw bytes of a file an agent shared via `mcp__paddock__send_file`; honors HTTP `Range` (`206`). | gated |

### Project git

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| GET | `/api/projects/:slug/git/status` | Uncommitted changes in the project subtree (`{ repo: false }` if not a work tree). | gated |
| GET | `/api/projects/:slug/git/diff` | Unified diff (working tree vs HEAD), or one file via `?file=` (`text/plain`). | gated |
| POST | `/api/projects/:slug/git/commit` | Commit the project's pending changes — body `{ message? }`. | gated |

### Project chats (sessions)

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| GET | `/api/projects/:slug/chats` | List the project's chats (no usage rings). | gated |
| POST | `/api/projects/:slug/chats` | Thin: validate the project + return the WS target → `201`. The real chat is created lazily over `/ws`. | gated |
| GET | `/api/projects/:slug/chats/attention` | `{ running, unread }` — the chats in this workspace's **subtree** with a live turn, or holding an unread reply; each row is a chat DTO plus `projectSlug`/`projectName`. Drives the Home tab's two feeds (#599). Because the root's key (`""`) prefixes every workspace key, `/api/root/chats/attention` is fleet-wide while a project's is scoped to itself — one handler, no branch. `running` is read from the live session hub; a chat is never in both lists. Archived chats are excluded from `unread` but a running one still lists. | gated |
| GET | `/api/projects/:slug/chats/usage` | Bulk context-window usage keyed by session id. `?scope=` `active` (default) / `archived` / `all` — usage is derived by streaming each transcript, so the collapsed Archived group is not paid for until it is opened (#537). | gated |
| GET | `/api/projects/:slug/chats/:sessionId/messages` | A chat's messages, enriched with tool details. | gated |
| GET | `/api/projects/:slug/chats/:sessionId/context` | Context-window usage from the transcript's last turn. | gated |
| GET | `/api/projects/:slug/chats/:sessionId/subagents/:toolUseId/messages` | Transcript of a sub-agent launched from a Task/Agent tool block. | gated |
| PATCH | `/api/projects/:slug/chats/:sessionId` | Rename (or clear name) — body `{ name? }`. | gated |
| DELETE | `/api/projects/:slug/chats/:sessionId` | Delete a chat (removes its transcript + attachments). | gated |
| POST | `/api/projects/:slug/chats/:sessionId/fork` | Fork a chat into a new resumable session — body `{ name? }` → `201 { sessionId }`. | gated |
| POST | `/api/projects/:slug/chats/:sessionId/archive` | Archive/unarchive (non-destructive) — body `{ archived? }`. | gated |
| POST | `/api/projects/:slug/chats/:sessionId/seen` | Mark seen (server-side read-state) — body `{ when? }`. | gated |
| POST | `/api/projects/:slug/chats/:sessionId/promote` | Promote the chat into a NEW project (re-homes its transcript) — body `{ name, slug?, group?, summary?, domain? }` → `201 { project, promoted, sessionId }`. | gated |
| POST | `/api/projects/:slug/chats/:sessionId/detach` | Detach a chat from its parent so it renders at the top level of the chat tree — body `{ detached? }`. An override checked AHEAD of both parent-resolution tiers (recorded + inferred); `false` re-attaches. | gated |
| POST | `/api/projects/:slug/chats/batch/archive` | Archive/unarchive a SET of chats in one atomic sidecar write — body `{ sessionIds, archived? }` → `{ ok, archived, changed }`. | gated |
| POST | `/api/projects/:slug/chats/batch/unread` | Mark a SET of chats read/unread — body `{ sessionIds, unread? }`. `unread:false` also advances each last-seen watermark. | gated |
| POST | `/api/projects/:slug/chats/batch/delete` | Delete a SET of chats — body `{ sessionIds }` → `{ ok, removed, failed }`. Best-effort per chat: filesystem deletes can't be atomic, so the response names what it couldn't remove. | gated |

### Importing native Claude Code chats

The terminal `claude` sessions a user already has for a workspace's working
directory can be imported so they list and resume like any other chat
(`AdoptableIndex` in `adoptable.ts`, `HerdctlService.adoptChats` in
`herdctl.ts`). Transcripts are **copied** — the user's `~/.claude` history is
never mutated — and keep their original mtimes, which are both the chat-list
sort key and the metadata cache key. Imported chats carry the `adopted`
provenance origin.

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| GET | `/api/projects/:slug/adoptable-chats` | What this workspace could import → `{ count, sources: [{ sourceCwd, sessionIds }], filtered }`. The count is LIVE (recomputed, cached on transcript-dir mtimes, dropped after every import), so it returns if new terminal sessions accrue and reaches `0` only when there is genuinely nothing left. Empty and slash-command-only transcripts are withheld as noise and explained under `filtered`. | gated |
| POST | `/api/projects/:slug/adopt-chats` | Import every detected source, or just one — body `{ sourceCwd? }` → `{ adopted, skipped }`. Invalidates the workspace's session cache. | gated |

> Like the rest of the chat routes these live in the dual-mounted plugin
> (`registerChatWorkspaceRoutes` in `routes/chats.ts`), so the **root workspace**
> gets them at `/api/root/adoptable-chats` and `/api/root/adopt-chats` with no
> extra handler. `packages/server/src/cli/import-chats.ts` is the headless
> equivalent (`npm run import-chats -w @paddock/server`), for when the
> transcripts and the server do not share a filesystem view.

---

## WebSocket protocol (`/ws`)

The chat back-and-forth runs over a single WebSocket at **`/ws`**, registered
behind the same auth hook as REST. The web client opens one shared socket
(`packages/web/src/lib/ws.ts`), auto-reconnects, and keeps it alive with a JSON
`ping`/`pong` every 25s (plus protocol-level WS pings server-side).

### Envelope

Every frame is a JSON object **`{ type, payload }`** (`ping`/`pong` are just
`{ type }`, no payload). `type` is the message kind.

Server→client **chat events** carry a common **`Routing`** block in `payload`:

| Field | Type | Notes |
|-------|------|-------|
| `projectSlug` | `string` | Project slug, or `"scratch"` for one-off chats. |
| `sessionId` | `string \| null` | Null until a brand-new chat's id first streams back. |
| `jobId` | `string \| null` | The cancellable job id, when known. |
| `seq` | `number?` | Per-turn monotonic sequence for reconnect/gap-replay. Absent on frames not routed through the hub (`chat:error`, `chat:resync`, `chat:active`, `chat:queued_flushed`, `pong`). |

Invalid JSON / unknown kinds get a `chat:error` reply.

### Client → server

| Kind | When it fires | Payload (beyond `projectSlug`) |
|------|---------------|--------------------------------|
| `chat:subscribe` | On (re)connect, to attach a socket to a session's live stream and replay any missed gap. | `sessionId: string`, `wantReplay?: boolean`, `lastSeq?: number` |
| `chat:send` | User (or a server-side queue drain) sends a message / starts or resumes a turn. | `sessionId?: string \| null` (null ⇒ new chat), `message: string`, `preloadContext?: boolean`, `model?: string` |
| `chat:command` | User runs a slash command (e.g. `/compact`) in the current chat. | `sessionId?: string \| null`, `command: string` (full text incl. leading slash) |
| `chat:cancel` | User clicks Stop; cancels the running turn's job. | `jobId: string` |
| `chat:set_queue` | Persist/clear the single-slot composer queue server-side (survives browser close). | `sessionId?: string \| null`, `text?: string \| null` (null/empty ⇒ clear), `ts?: number \| null` |
| `ping` | Client keepalive every 25s. | *(none)* |

### Server → client

| Kind | When it fires | Payload (beyond `Routing`) |
|------|---------------|-----------------------------|
| `chat:active` | A session's live-turn status changed (start/stop); broadcast to all clients, and sent as a snapshot to a newly-connected or subscribing socket. | `sessionId: string`, `jobId: string \| null`, `running: boolean` (this frame carries its own `projectSlug`/`sessionId`, no `seq`) |
| `chat:response` | A streamed assistant text delta. Also surfaces a `/compact` boundary as a synthetic note. | `chunk: string` |
| `chat:tool_start` | A tool_use begins (before it runs) — renders a pending "running…" row. | `toolName: string`, `inputSummary?: string`, `toolUseId?: string`, `parentToolUseId: string \| null` |
| `chat:tool_call` | A tool completes (paired tool_use→tool_result); reconciles the pending row. | `toolName: string`, `inputSummary?: string`, `output: string`, `isError: boolean`, `durationMs?: number`, `toolUseId?: string` |
| `chat:message_boundary` | An assistant message bubble ended. | *(Routing only)* |
| `chat:complete` | The turn finished (success or failure); carries final usage/model. | `success: boolean`, `error?: string`, `model?: string`, `usage?: ChatCompleteUsage` |
| `chat:error` | A turn threw before/without a resolved session (sent to the origin socket only); also the reply to invalid JSON / unknown frames. | `projectSlug: string`, `error: string` (no `sessionId`/`jobId`/`seq`) |
| `chat:resync` | Reconnect fallback: the live turn's frame buffer aged out past the requested gap, so the client must re-hydrate from the transcript. | `projectSlug: string`, `sessionId: string` |
| `chat:queued_flushed` | The server auto-drained the persisted queued message after a turn (or when idle). | `projectSlug: string`, `sessionId: string`, `text?: string` (present ⇒ render as a user bubble; absent ⇒ just clear a stale copy) |
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

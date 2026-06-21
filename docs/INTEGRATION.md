# Paddock ↔ `@herdctl/core` Integration Contract

> The public-npm API surface paddock depends on, verified against the
> **installed** `@herdctl/core@5.10.1` (the public npm package — NOT the local
> symlink). Every claim here was checked against the shipped `.d.ts`
> declarations and proven by a real spike (`packages/server/src/spike.ts`,
> which typechecks and runs against the package, constructing + initializing a
> FleetManager and a SessionDiscoveryService).
>
> Pinned versions inspected: `@herdctl/core@5.10.1` (used),
> `@herdctl/web@0.9.10` and `@herdctl/chat@0.3.14` (referenced for protocol
> shape only — see question f).

## TL;DR verdict

| Need | Public API supports it? | Mechanism |
|---|---|---|
| Construct + run a fleet | ✅ Yes | `new FleetManager({configPath, stateDir})` → `initialize()` → `start()` |
| **Add an agent at runtime** | ⚠️ **Only via yaml + `reload()`** | No `addAgent()`. Generate per-agent yaml files + a `herdctl.yaml`, then `reload()`. **This works and is what paddock does.** |
| Stream a prompt's output | ✅ Yes | `trigger(agent, undefined, {prompt, resume, onMessage})` |
| New vs resume session | ✅ Yes | `resume: null` (new) / `resume: <id>` (resume); final id on `TriggerResult.sessionId` |
| List sessions + messages | ✅ Yes | `SessionDiscoveryService.getAgentSessions()` / `getSessionMessages()` |
| FleetManager events | ✅ Yes | EventEmitter: `job:output`, `job:completed`, `config:reloaded`, … |
| Reuse a web/chat transport | ❌ No (in core) | Transport lives in `@herdctl/web`/`@herdctl/chat`, not core. Build our own (we did, in `ws.ts`). |

The integration is viable on the public package **today**. The only real
constraint is dynamic agents (yaml+reload, not a programmatic registry) — which
is acceptable because paddock owns the generated config dir.

---

## Package shape

`@herdctl/core@5.10.1` ships as ESM (`"type": "module"`), `main:
./dist/index.js`, `types: ./dist/index.d.ts`. **There is no `exports` map** —
just `main` + `types`. Everything is re-exported flat from the root, so a single
import works:

```ts
import {
  FleetManager,
  SessionDiscoveryService,
  type SDKMessage,
  type TriggerResult,
  type AgentInfo,
  type FleetStatus,
  type DiscoveredSession,
  type ChatMessage,
} from "@herdctl/core";
```

Runtime deps of core: `@anthropic-ai/claude-agent-sdk`, `chokidar`,
`cron-parser`, `dockerode`, `dotenv`, `execa`, `yaml`, `zod`.

---

## a. Construct + initialize a FleetManager (minimal setup)

```ts
import { FleetManager } from "@herdctl/core";

const fleet = new FleetManager({
  configPath: "/abs/path/to/herdctl.yaml", // file or dir; auto-discovers if omitted
  stateDir: "/abs/path/to/.herdctl",        // created if missing
  // optional: logger, checkInterval (ms, default 1000), configOverrides
});

await fleet.initialize();   // loads + validates config, preps state dir
await fleet.start();        // starts the scheduler (and chat connectors, if any)
```

`FleetManagerOptions` (verified):
```ts
interface FleetManagerOptions {
  configPath?: string;          // file, dir, or omitted (auto-discover up from cwd)
  stateDir: string;             // required
  logger?: FleetManagerLogger;
  checkInterval?: number;       // default 1000ms
  configOverrides?: FleetConfigOverrides; // only overrides fleet.web {enabled,port,host}
}
```

There is also `initializeWebOnly({port?, host?})` — a zero-agent mode that serves
session data from `~/.claude/` without a `herdctl.yaml`. Paddock does not use it
(we always have at least the scratch agent), but it's available.

**Config-file requirements discovered the hard way** (the spike caught these — a
naive inline config 400s):

- The `fleet` block is **strict**: only `name` and `description` are allowed.
  `log_level` is NOT a fleet field (it's a chat/connector concern).
- The `agents` array accepts **only path references** — `{ path: string,
  overrides?: object }`. **You cannot inline an agent definition** in
  `herdctl.yaml`. Each agent must live in its own yaml file referenced by path.
- `defaults` (deep-merged into every agent) accepts `runtime`, `model`,
  `max_turns`, `permission_mode`, `allowed_tools`, `denied_tools`, `docker`, etc.
- An agent yaml requires only `name`; everything else is optional and merged
  with `defaults`.

Minimal working pair (what `spike.ts` writes):

```yaml
# herdctl.yaml
version: 1
fleet: { name: paddock-spike, description: spike fleet }
agents:
  - path: /abs/scratch.agent.yaml
```
```yaml
# scratch.agent.yaml
name: scratch
working_directory: /abs/dir
runtime: cli
max_turns: 3
permission_mode: default
system_prompt: "You are a spike agent…"
allowed_tools: []
```

---

## b. CRITICAL — adding agents at runtime

**There is NO programmatic agent-registration API.** The `FleetManager` class
exposes (verified from `fleet-manager.d.ts`): `initialize`, `start`, `stop`,
`getFleetStatus`, `getAgentInfo`, `getAgentInfoByName`, `getSchedules`,
`enable/disableSchedule`, **`reload`**, `trigger`, `cancelJob`, `forkJob`,
`streamLogs`/`streamJobOutput`/`streamAgentLogs`, plus getters. **No
`addAgent` / `registerAgent` / `removeAgent`.**

Agents come from the config file on disk. The supported way to add one at
runtime is therefore:

1. Write a new per-agent yaml file (`working_directory` = the project dir).
2. Regenerate the `herdctl.yaml` to reference it (path reference).
3. Call `await fleet.reload()`.

`reload()` (from `config-reload.d.ts`):
- Re-reads + re-validates the config from `configPath`.
- On validation failure, **keeps the old config** (fails gracefully).
- Running jobs keep their original config; new triggers use the new one.
- Updates the scheduler with new agents/schedules.
- Emits `config:reloaded` with a `ConfigChange[]` diff (added/removed/modified ×
  agent/schedule/defaults).

```ts
// paddock's HerdctlService.ensureProjectAgent()
await regenerateConfigFiles(allProjects); // writes agents/<name>.yaml + herdctl.yaml
const payload = await fleet.reload();      // hot-reload; no restart
// payload.changes => [{type:"added", category:"agent", name:"keeper-foo"}, ...]
```

**This is proven at runtime** (paddock smoke test): creating a project writes
the files, calls `reload()`, and the new `keeper-<slug>` agent immediately shows
up in `getFleetStatus().counts.totalAgents` / `getAgentInfo()` while the fleet
keeps running.

Config-dir layout paddock owns (regenerated, never hand-edited):
```
<PADDOCK_DATA_DIR>/
  herdctl.yaml                 # fleet + defaults + agent path refs
  agents/
    scratch.yaml               # one-off chats agent
    keeper-<slug>.yaml         # one per project, working_directory = project dir
  .herdctl/                    # state dir (state.yaml, jobs/, sessions/, …)
  scratch/                     # scratch agent working dir
  projects/<slug>/             # project dirs (project.yaml, CHANGELOG.md, …)
```

> **GAP (minor, app-managed):** dynamic agents require file generation +
> `reload()` rather than an in-memory call. Acceptable because paddock owns the
> config dir. A future herdctl enhancement (`fleet.addAgent(resolvedAgent)`)
> would remove the file round-trip — see Gap list.

---

## c. Trigger + stream + sessions

```ts
const result: TriggerResult = await fleet.trigger("keeper-foo", undefined, {
  prompt: "Summarize the current state of this project.",
  resume: null,            // null = NEW session; <id> = resume; undefined = agent fallback
  triggerType: "web",      // "discord"|"slack"|"web"|"manual"
  onJobCreated: (jobId) => { /* enable a stop button, etc. */ },
  onMessage: (m: SDKMessage) => {
    if (m.session_id) currentSession = m.session_id;     // session id arrives mid-stream
    if (m.type === "assistant" && typeof m.content === "string") {
      stream(m.content);                                 // plain assistant text
    }
    // m.type can also be: system | stream_event | result | user
    //   | tool_progress | auth_status | error | tool_use | tool_result
  },
});

result.sessionId; // final SDK session id (trust only when result.success === true)
result.jobId;     // job id
result.success;   // boolean
result.error;     // Error | undefined
```

`TriggerOptions` (verified) also has: `workItems`, `bypassConcurrencyLimit`,
`injectedMcpServers` (runtime MCP tool injection), `systemPromptAppend`
(per-trigger system-prompt suffix — used by chat connectors for "be concise on
Discord"-style hints).

**`SDKMessage`** is a wide struct (`runner/types.d.ts`): `type`, `subtype?`,
`content?`, `session_id?`, `name?`, `input?`, `tool_use_id?`, `tool_name?`,
`tool_use_result?`, `message?`, `event?`, `result?`, `success?`, `code?`, plus
`[key: string]: unknown`. Assistant text is either `m.content` (string) or
nested text blocks in `m.message.content[]` (paddock's `ws.ts` handles both).

**New vs resume vs continue:**
- New chat → `resume: null`.
- Resume a specific session → `resume: "<sessionId>"`.
- `resume: undefined` → agent-level session fallback (for CLI/schedule use).

---

## d. Sessions + working-directory model

Sessions are **not** a first-class FleetManager method; they're read via two
layers, both keyed on an agent's `working_directory` (Claude Code stores
transcripts under `~/.claude/projects/<cwd-with-slashes-as-dashes>/`, so the
project dir IS the session key — no manual tagging):

### `SessionDiscoveryService` (the one paddock uses)
```ts
import { SessionDiscoveryService } from "@herdctl/core";

const discovery = new SessionDiscoveryService({
  stateDir: "/abs/.herdctl",
  claudeHomePath: "/home/ed/.claude", // default: ~/.claude
  // cacheTtlMs?: number               // default 30s
});

// list a project's chats (sorted by mtime desc)
const sessions: DiscoveredSession[] = await discovery.getAgentSessions(
  "keeper-foo",          // agent qualified name
  "/abs/projects/foo",   // working directory
  false,                 // dockerEnabled
  { limit: 50 },         // optional
);
// DiscoveredSession: { sessionId, workingDirectory, mtime, origin, agentName,
//                      resumable, customName, autoName, preview }

// all sessions grouped by directory
const groups = await discovery.getAllSessions(
  [{ name: "keeper-foo", workingDirectory: "/abs/projects/foo", dockerEnabled: false }],
  { limit: 100 },
);

// a session's messages
const messages: ChatMessage[] = await discovery.getSessionMessages(
  "/abs/projects/foo", "<sessionId>", { dockerEnabled: false },
);
// ChatMessage: { role: "user"|"assistant"|"tool", content, timestamp, toolCall? }

await discovery.getSessionMetadata(dir, id);  // SessionMetadata (counts, previews, branch…)
await discovery.getSessionUsage(dir, id);     // { inputTokens, turnCount, hasData }
discovery.invalidateAttributionCache(dir);    // call after a new chat creates a session
```

### Lower-level `state/*` helpers (also exported)
- `listSessions(sessionsDir, opts)` / `getSessionInfo` / `updateSessionInfo` /
  `clearSession` — these operate on `.herdctl/sessions/<qualified-name>.json`
  (the agent's *current* session pointer, not the full transcript list).
- `parseSessionMessages(file)`, `extractSessionMetadata(file)`,
  `extractSessionUsage(file)` — raw JSONL parsers.
- `SessionMetadataStore` — custom session names. (Paddock TODO: use it to let
  users rename chats up-front; see `routes.ts` POST `/api/projects/:slug/chats`.)

---

## e. FleetManager events

`FleetManager extends EventEmitter`. Typed event map (`event-types.d.ts`):

| Event | Payload |
|---|---|
| `initialized` | — |
| `started` | — |
| `stopped` | — |
| `config:reloaded` | `{ agentCount, agentNames, configPath, changes[], timestamp }` |
| `agent:started` / `agent:stopped` | agent payloads |
| `schedule:triggered` / `schedule:skipped` | schedule payloads |
| `job:created` | `{ job, agentName, scheduleName?, timestamp }` |
| `job:output` | `{ jobId, agentName, output, outputType, timestamp }` |
| `job:completed` | `{ job, agentName, exitReason, durationSeconds, timestamp }` |
| `job:failed` | `{ job, agentName, error, exitReason, durationSeconds?, timestamp }` |
| `job:cancelled` / `job:forked` | job payloads |
| `slack:*` | slack connector events |
| `error` | `Error` |

`job:output.outputType ∈ stdout|stderr|assistant|tool|system`. For paddock's WS
streaming we use the per-trigger `onMessage` callback (finer-grained, gives
`SDKMessage`), and reserve events for fleet-wide UI (status, reloads).

---

## f. Reusing web/chat transport

**No — not from `@herdctl/core`.** Core has zero HTTP/WS server code. The
transport lives in sibling packages:

- `@herdctl/web` (`0.9.10`) — Fastify + WS dashboard. Its `ws/types.ts` defines
  the chat protocol (`chat:send` → `chat:response`/`chat:tool_call`/
  `chat:complete`/`chat:error`, plus `subscribe`/`job:output` for live logs) and
  its `chat/web-chat-manager.ts` does the SDKMessage→protocol translation.
- `@herdctl/chat` (`0.3.14`) — shared session/streaming primitives.

Core only exposes `IChatManager` (an interface) + `getChatManager(platform)` —
i.e. core can *host* a chat manager you (or a sibling package) provide, but it
ships none for HTTP.

**Decision: paddock builds its own transport** (`packages/server/src/ws.ts`),
modeling the message shapes on `@herdctl/web`'s protocol for familiarity, and
wiring real streaming through `FleetManager.trigger({onMessage})`. We do NOT
depend on `@herdctl/web` at runtime (it pulls React/Fastify dashboard weight we
don't need; paddock's UI is its own SPA). We did read its `ws/types.ts` for the
protocol contract — that's the only "reuse."

> Richer tool-call extraction (tool_use blocks nested in assistant content,
> paired tool_result blocks) is what `@herdctl/web`'s web-chat-manager does;
> core exposes the building blocks (`extractToolUseBlocks`, `extractToolResults`,
> `getToolInputSummary` in `state/tool-parsing`). Paddock's `ws.ts` has a TODO to
> wire these for inline tool rendering parity.

---

## Gaps requiring a local herdctl change (→ PR later)

These are the points where the public API can't (yet) do what paddock's project
model wants cleanly. None are blockers today — each has a working app-layer
workaround — but they're the candidates for an upstream local fix + PR.

1. **Programmatic dynamic agents (primary).** Add a public
   `FleetManager.addAgent(agent)` / `removeAgent(name)` (or
   `registerAgents(ResolvedAgent[])`) so paddock can register a project's keeper
   agent in-memory instead of writing yaml + `reload()`. The internals already
   re-key the scheduler on reload, so the plumbing exists; it just isn't exposed.
   *Workaround in use:* generate `agents/<name>.yaml` + `herdctl.yaml`, call
   `reload()`. Works, but couples paddock to herdctl's on-disk config format and
   forces a full re-read on every project create.

2. **First-class session list on FleetManager.** Session enumeration requires
   instantiating `SessionDiscoveryService` separately and passing each agent's
   `{name, workingDirectory, dockerEnabled}` by hand. A
   `fleet.getAgentSessions(agentName)` / `fleet.getSessionMessages(agentName,
   sessionId)` that derives the working dir from the loaded config would remove
   the duplication and the chance of cwd/agent mismatch. *Workaround in use:*
   paddock's `HerdctlService` keeps its own `SessionDiscoveryService` and maps
   slugs→dirs.

3. **Reusable HTTP/WS chat transport in (or alongside) core.** The
   SDKMessage→`chat:*` translation + tool-call extraction lives in
   `@herdctl/web`, tangled with the dashboard. A small transport-agnostic
   `@herdctl/chat`-level helper (`streamTriggerToHandlers(trigger, handlers)`)
   would let paddock drop its hand-rolled `ws.ts` translation and stay in sync
   with herdctl's message handling. *Workaround in use:* paddock reimplements the
   translation in `ws.ts` (with a TODO for tool-block parity).

4. **Trigger that returns before completion (streaming handle).** `trigger()`
   resolves only when the job finishes; paddock streams via `onMessage` during
   the call, which is fine, but a returned async handle/stream (job id + an async
   iterator) would make cancellation and backpressure cleaner for the WS layer.
   *Workaround in use:* `onJobCreated` gives the job id mid-flight, and
   `cancelJob(jobId)` exists — sufficient, but a unified streaming handle would
   be nicer.

---

## Files

- Real wrapper: `packages/server/src/herdctl.ts` (`HerdctlService`).
- Real spike (typechecks + runs vs public API): `packages/server/src/spike.ts`.
- WS protocol + streaming: `packages/server/src/ws.ts`.
- Project layer: `packages/server/src/projects.ts` (`ProjectStore`).

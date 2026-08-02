---
title: "herdctl integration contract"
description: "The exact public @herdctl/core API surface Paddock depends on, re-verified against 5.27.0."
---

> The public-npm API surface Paddock depends on. Every claim was checked against
> the shipped `.d.ts` declarations of the **installed** package.

:::note[Re-verified 2026-07-31 against `@herdctl/core@5.27.0`]
Paddock depends on `@herdctl/core@^5.29.0` and `@herdctl/chat@^0.8.0`
(`packages/server/package.json`).

This page was originally written against **5.10.1**, and its headline finding has
since inverted: **all four "gaps" it asked herdctl for have shipped**, and Paddock
uses every one of them. Sections below are current unless a callout says
otherwise; where the 5.10.1 answer is load-bearing history it is kept in a
*Superseded* note rather than deleted.

`@herdctl/web` was inspected at `0.9.10` for protocol shape only and is **not**
installed — see section f.
:::

## TL;DR verdict

| Need | Public API supports it? | Mechanism |
|---|---|---|
| Construct + run a fleet | ✅ Yes | `new FleetManager({configPath, stateDir})` → `initialize()` → `start()` |
| **Add an agent at runtime** | ✅ Yes | `fleet.addAgent(config, {replace})` / `removeAgent(name)` — in-memory, no yaml, no `reload()`. At 5.10.1 this was yaml+`reload()` only; see section b. |
| Run a one-shot turn | ✅ Yes | `trigger(agent, undefined, {prompt, resume, onMessage})` |
| **Drive a persistent chat session** | ✅ Yes | `openChatSession(agent, opts)` → `RuntimeSession`. **Always the SDK runtime**, whatever the agent's `runtime` says — see section c. |
| New vs resume session | ✅ Yes | `resume: null` (new) / `resume: <id>` (resume); final id on `TriggerResult.sessionId` |
| List sessions + messages | ✅ Yes | `fleet.getAgentSessions(name, {limit})` / `getAgentSessionMessages(name, id)` — derives the working dir from config |
| FleetManager events | ✅ Yes | EventEmitter: `job:output`, `job:completed`, `config:reloaded`, … |
| Reuse a chat-message translator | ✅ Yes | `createSDKMessageHandler()` from `@herdctl/chat`. Core itself still ships no HTTP/WS server — see section f. |

The integration is viable on the public package **today**, and is now a thin one:
the original constraint (dynamic agents via yaml+reload rather than a programmatic
registry) has been lifted, along with the other three gaps this page opened.

---

## Package shape

`@herdctl/core` ships as ESM (`"type": "module"`), `main: ./dist/index.js`,
`types: ./dist/index.d.ts`. **There is no `exports` map** — just `main` + `types`.
Everything is re-exported flat from the root, so a single import works (the
internal `dist/` layout has been reorganized since 5.10.1, but the flat root
export is unchanged):

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

Two more options exist and paddock passes both. They were added after this page
was written, so they fall outside its "verified against 5.10.1" claim:
`allowScheduleMutation`, and — since **5.29.0** — **`claudeHomePath`**, the
Claude home the engine's session discovery, its adoption primitives, and Claude
Code itself resolve transcripts under. Paddock passes its one resolved
`claudeHome` so the two sides cannot disagree about which home is real; see
`HerdctlService` in `herdctl.ts` and the `CLAUDE_HOME` row in
[Environment variables](/configuration/environment/).

5.29.0 is also where the session-adoption primitives behind
[importing your terminal `claude`
history](/using/working-in-chats/#import-your-terminal-claude-history) arrived —
`listAdoptableSessions`, `adoptSessionsFrom` and `unadoptSession` on the
FleetManager (used by `AdoptableIndex` in `adoptable.ts` and
`HerdctlService.adoptChats` in `herdctl.ts`) — along with the `CLAUDE_CONFIG_DIR`
fix without which **resuming** an adopted session fails.

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
- `defaults` (deep-merged into every agent) accepts `model`, `max_turns`,
  `permission_mode`, `allowed_tools`, `denied_tools`, `docker`, etc. **`runtime`
  is NOT among them** — `DefaultsSchema` (`config/schema.js:338`) has no such
  field, so a fleet-level `defaults.runtime` is silently dropped and every agent
  falls back to the SDK runtime. This is why paddock repeats `runtime: "cli"` on
  each agent explicitly (`herdctl-agent-config.ts`); it bit us once already
  (see [testing](/contributing/testing)).
- An agent yaml requires only `name`; everything else is optional and merged
  with `defaults`.

Minimal working pair:

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

## b. Adding agents at runtime

**`fleet.addAgent()` / `fleet.removeAgent()` are the supported API** and are what
paddock uses (`fleet-manager.d.ts:175,188`):

```ts
addAgent(
  agent: AgentConfig | (Record<string, unknown> & { name: string }),
  options?: AddAgentOptions,          // { baseDir?, mergeDefaults?, replace? }
): Promise<AgentInfo>;

removeAgent(name: string): Promise<boolean>;   // qualified OR local name
```

`addAgent` validates the config, deep-merges fleet `defaults`, resolves
`working_directory` to an absolute path, and wires the agent into the running
scheduler so it is immediately triggerable and shows up in `getFleetStatus()` /
`getAgentInfo()`. It emits a `config:reloaded` event describing the change.
Throws `InvalidStateError` if the fleet isn't initialized, `ConfigurationError`
on validation failure or a name collision — hence paddock's `{ replace: true }`
on every call, which makes re-registration idempotent.

Paddock's actual usage (`herdctl.ts:337,412,443,486` / `:469,514`): the
FleetManager boots from a **minimal zero-agent config** (fleet + defaults only)
and every agent — scratch, `keeper-<slug>`, `sweeper-<slug>`,
`trigger-<slug>-<name>` — is registered programmatically at init and on project
create/update. Nothing writes per-agent yaml, and `reload()` is never called.

:::note[Superseded — the 5.10.1 answer]
There was NO programmatic registration API then: no `addAgent` / `registerAgent` /
`removeAgent`. Agents came only from config files on disk, so the supported way to
add one at runtime was (1) write a per-agent yaml file (`working_directory` = the
project dir), (2) regenerate `herdctl.yaml` to reference it, (3) call
`await fleet.reload()`. Paddock did exactly that until 5.11.0.

The `reload()` contract below still holds and still matters — Paddock owns the
on-disk `herdctl.yaml` (fleet block + `defaults`) even though it no longer lists
agents there.
:::

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

Config-dir layout paddock owns (generated, never hand-edited):
```
<PADDOCK_DATA_DIR>/
  herdctl.yaml                 # fleet block + defaults ONLY — zero agent refs
  .herdctl/                    # state dir (state.yaml, jobs/, sessions/, …)
  scratch/                     # scratch agent working dir
  projects/<slug>/             # project dirs (project.yaml, CHANGELOG.md, …)
```

Note there is **no `agents/` dir** — it was removed when paddock moved to
`addAgent`. `ensureConfigFile()` (`herdctl-agent-config.ts`) writes only the
`fleet` block plus fleet-wide `defaults`; the `agents:` array stays empty.

---

## c. Running a turn — two paths

Core offers two ways to run an agent turn, and **which one you use decides the
runtime**. This is the single most important thing on this page, and the thing it
got wrong for longest (paddock#585):

| | `trigger()` | `openChatSession()` |
|---|---|---|
| Shape | one-shot; resolves when the turn ends | long-lived handle driven across turns |
| Runtime | `RuntimeFactory.create` → honors the agent's `runtime` field (`sdk` \| `cli`) | **always `SDKRuntime`** — `agent.runtime` is never consulted |
| Job record | writes a `job-*.yaml` | writes none |
| Paddock uses it for | the sweeper, triggers/schedules, and `driveMode: batch` chats | **every chat by default** (`driveMode: session`) |

The `RuntimeSession` docstring states the asymmetry outright: *"Always runs on the
SDK runtime (works for `cli`-configured agents too; Docker-wrapped agents are
unsupported)"* (`fleet-manager.d.ts:325`). So paddock setting `runtime: "cli"` on
its agents does **not** make a chat a `claude -p` subprocess — it only bites on the
`trigger()` path. A Docker-enabled agent cannot use `openChatSession` at all and
throws `StreamingSessionUnsupportedError`.

### c.1 `openChatSession` — the persistent session (paddock's default)

```ts
const session: RuntimeSession = await fleet.openChatSession("keeper-foo", {
  prompt: "…",              // optional opening turn; omit to open idle
  resume: "<sessionId>",    // string = resume | null = fresh | undefined = agent fallback
  injectedMcpServers,       // in-process SDK MCP servers (architecture overview §5)
  systemPromptAppend,
  includePartialMessages: true,  // emit stream_event / text_delta for token-by-token UI
  manageLifecycle: true,         // herdctl reaps on idle + re-fires timer wakeups (#307)
  workingDirectory,              // per-session cwd override
  resumeDeferTimeoutMs,          // bound the wait for a still-live session to be reaped (#403)
});

session.messages;            // AsyncIterable<SDKMessage> — consume to drive the turn
await session.send(text);    // next user turn (a slash command is just a user message)
await session.interrupt();   // stop the current turn; further send() calls stay valid
await session.listCommands();// SlashCommand[] — { name, description, argumentHint }
await session.setModel(m);   // change model for subsequent turns
await session.close();
```

`manageLifecycle: true` is what makes background tasks and scheduled wake-ups
survive a turn boundary: herdctl's reaper keeps the session alive while it holds
live background work. The caller must treat **the message stream ending as a reap**
and re-open (resume) later to keep driving the conversation.

`listAgentCommands(agentName, options)` is the one-shot convenience wrapper —
opens a session, reads the command list, always closes.

### c.2 `trigger()` — the one-shot job

```ts
const result: TriggerResult = await fleet.trigger("keeper-foo", undefined, {
  prompt: "Summarize the current state of this project.",
  resume: null,            // null = NEW session; <id> = resume; undefined = agent fallback
  triggerType: "web",      // loosely typed `string` here; see the enum below
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

`TriggerResult` also carries `agentName`, `scheduleName: string | null`,
`startedAt`, `prompt?` and `errorDetails?: RunnerErrorDetails`.

`TriggerOptions` also has: `workItems`, `bypassConcurrencyLimit`,
`injectedMcpServers` (runtime MCP tool injection), `systemPromptAppend`
(per-trigger system-prompt suffix — used by chat connectors for "be concise on
Discord"-style hints), plus three added since 5.10.1:

- **`fork?: string`** (`types.d.ts:461`) — resume that session's transcript as
  context but write to a **brand-new session id** (`--fork-session`), leaving the
  source untouched. Mutually exclusive with `resume`; when both are set `fork`
  wins and the agent-level fallback is skipped.
- **`forkedFrom?: string`** (`:468`) — informational `forked_from` lineage on the
  new job record; only meaningful alongside `fork`.
- **`workingDirectory?: string`** (`:555`) — per-trigger cwd override. **Caveat:**
  session/transcript resolution uses the *effective* (overridden) directory, so
  sessions created this way will NOT show up in `getAgentSessions` (§d).

**`triggerType`** is declared `string`, not a union — the JSDoc still names only
`discord|slack|web|manual`, but the value persisted onto the job record is
validated against `TriggerTypeSchema`
(`state/schemas/job-metadata.d.ts:21`): `webhook | chat | discord | slack | web |
schedule | manual | fork | spawned`. Paddock passes `"web"` for chat turns and
`"manual"` for the sweeper.

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

Claude Code stores transcripts under
`~/.claude/projects/<cwd-with-slashes-as-dashes>/`, so **an agent's
`working_directory` IS the session key** — no manual tagging. There are two
layers over that.

### `FleetManager` methods (the ones paddock uses)

Sessions ARE first-class on the FleetManager now — each method derives the
agent's working directory and Docker mode from the loaded config, so callers
never map agent → dir by hand (`fleet-manager.d.ts:210-313`):

```ts
await fleet.getAgentSessions(name, { limit });         // DiscoveredSession[]
await fleet.getAgentSessionMessages(name, sessionId);  // ChatMessage[]
await fleet.getAgentSessionUsage(name, sessionId);     // SessionUsage
fleet.getAgentWorkingDirectory(name);                  // string | undefined
await fleet.deleteSession(name, sessionId);            // removes the transcript
await fleet.setSessionName(name, sessionId, custom);   // custom display name
fleet.invalidateSessions(name);                        // force a fresh listing
```

Paddock uses this layer exclusively — there is no `new SessionDiscoveryService(…)`
anywhere in `packages/server/src`. Chat rename is
`PATCH /api/projects/:slug/chats/:sessionId` → `fleet.setSessionName`
(`routes/chats.ts:617`, closing issue #10). Naming a chat *before* its session id
exists is still a TODO (`routes/chats.ts:380`) — a new chat is created lazily by
the first WS `chat:send`.

> **Caveat.** `getAgentSessions` uses the agent's **configured**
> `working_directory`. Sessions created under a per-trigger/per-session
> `workingDirectory` override live elsewhere and will not appear — scan that
> directory instead.

### `SessionDiscoveryService` (the layer beneath)

Still exported, and still what you want for directory-keyed access
(`getAllSessions` across many agents, or an override directory):
```ts
import { SessionDiscoveryService } from "@herdctl/core";

const discovery = new SessionDiscoveryService({
  stateDir: "/abs/.herdctl",
  claudeHomePath: "/home/ed/.claude", // default: ~/.claude
  // cacheTtlMs?: number               // default 30s
  // sessionMetadataStore?: SessionMetadataStore  // share one so custom-name
  //   writes (fleet.setSessionName) are immediately visible to discovery
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
// ChatMessage: { role: "user"|"assistant"|"tool", content, timestamp, toolCall?,
//                uuid?, origin? }

await discovery.getSessionMetadata(dir, id);  // SessionMetadata (counts, previews, branch…)
await discovery.getSessionUsage(dir, id);     // { inputTokens, turnCount, hasData }
discovery.invalidateAttributionCache(dir);    // call after a new chat creates a session
discovery.invalidateWorkingDirectory(dir);    // targeted; fleet.invalidateSessions wraps it
```

Two `ChatMessage` fields postdate 5.10.1 (`state/jsonl-parser.d.ts:11-39`):
**`uuid?`** — the transcript JSONL's own id, stable across reloads and forks (for
a paired tool message it is the originating `tool_use` entry's uuid), so it is a
safe key for per-message UI state; and **`origin?: { kind: string }`** — the
harness's provenance stamp on injected entries (the one seen in practice is
`"task-notification"`). Unlike `isMeta: true` lines, these are **not** dropped
from parsed history.

`getAgentSessions` is also worktree-aware now: it unions in every
`~/.claude/projects/*` bucket whose decoded path is a strict descendant of
`workingDirectory`, so native git-worktree sessions aren't silently dropped.

### Lower-level `state/*` helpers (also exported)
- `listSessions(sessionsDir, opts)` / `getSessionInfo` / `updateSessionInfo` /
  `clearSession` — these operate on `.herdctl/sessions/<qualified-name>.json`
  (the agent's *current* session pointer, not the full transcript list).
- `parseSessionMessages(file)`, `extractSessionMetadata(file)`,
  `extractSessionUsage(file)` — raw JSONL parsers.
- `SessionMetadataStore` — custom session names. Paddock does NOT use it
  directly (it renames through `fleet.setSessionName`), but its own archive
  sidecar arguably belongs here — see `archive.ts:8`.

Careful: `HerdctlService.listSessions(project)` is a **paddock** method, not
core's `listSessions` above.

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
| `schedule:triggered` | schedule payload |
| `job:created` | `{ job, agentName, scheduleName?, timestamp }` |
| `job:output` | `{ jobId, agentName, output, outputType, timestamp }` |
| `job:completed` | `{ job, agentName, exitReason, durationSeconds, timestamp }` |
| `job:failed` | `{ job, agentName, error, exitReason, durationSeconds?, timestamp }` |
| `job:cancelled` / `job:forked` | job payloads |
| `slack:*` | slack connector events |
| `error` | `Error` |

`job:output.outputType ∈ stdout|stderr|assistant|tool|system`.

:::caution[`schedule:skipped` is NOT a FleetManager event]
It lives on `JobQueueEventMap` (`fleet-manager/job-queue.d.ts:242`). An earlier
revision of this page listed it here; subscribing on the FleetManager gets you
nothing.
:::

Paddock reserves events for fleet-wide UI (status, reloads) and streams turns off
the per-call channel instead: `onMessage` on the `trigger()` path, and the
`RuntimeSession.messages` async-iterable on the default `openChatSession` path
(§c).

---

## f. Reusing web/chat transport

**The transport: still no. The message translation: yes, and paddock uses it.**

Core ships no chat HTTP/WS server. It exposes the `IChatManager` interface plus
`fleet.getChatManager(platform)` / `fleet.getChatManagers()` — i.e. core can
*host* a chat manager you provide, but ships none for HTTP. (The one `node:http`
server in core is `runner/runtime/mcp-http-bridge`, the CLI-runtime MCP bridge
from [architecture overview §5](/architecture/overview#5-mcp-injection). It
isn't re-exported, and isn't a chat transport.)

**Paddock builds its own transport** (`packages/server/src/ws.ts`) — the
`chat:send` / `chat:response` / `chat:tool_call` / `chat:message_boundary` /
`chat:complete` / `chat:injected` / `chat:error` protocol is paddock's own. It
does **not** depend on `@herdctl/web` (React/Fastify dashboard weight paddock
doesn't need; paddock's UI is its own SPA), and `@herdctl/web` is not installed.

**But paddock no longer hand-rolls the SDKMessage→chat-event translation.**
`@herdctl/chat@^0.8.0` is a real runtime dependency now, and its
`createSDKMessageHandler(handlers, options)`
(`sdk-message-translator.d.ts:227`) — the shared, transport-agnostic translator
every herdctl chat surface uses — does assistant text deltas, message boundaries,
and paired `tool_use`→`tool_result` calls enriched with input summaries and
wall-clock durations. Paddock composes it with a thin wrapper that also captures
the session id and per-turn usage/model, in `ws.ts`, `ws-turn.ts` and
`herdctl.ts`.

> Core's lower-level building blocks (`extractToolUseBlocks`,
> `extractToolResults`, `getToolInputSummary` in `state/tool-parsing`) remain
> exported but paddock does not use any of them — the `@herdctl/chat` translator
> covers that ground. The old "TODO: wire these for inline tool rendering parity"
> in `ws.ts` is gone, along with the gap.

---

## g. Lifecycle hooks paddock registers

Three `FleetManager` setters let an app intercept herdctl's own machinery. All
three postdate 5.10.1 and all three are load-bearing for paddock:

| Setter | What it intercepts |
|---|---|
| `setSessionWakeHandler(fn)` (`:361`) | a reaped session's captured timer wakeup coming back through the scheduler |
| `setResolveInjectedMcpServers(fn)` (`:377`) | re-supplies in-process MCP servers when a reaped-then-woken session re-spawns (herdctl#390) — **synchronous**, and must not throw |
| `setScheduleTriggerHandler(fn)` (`:389`) | execution of a scheduled turn, so paddock can route it through its own dispatch (herdctl#375) |

Without the second, a woken session re-spawns with `mcp__paddock*__*` on the
allow-list but **unbacked** — the tools appear and fail. See
`wake-injection.ts`.

---

## Gaps — all four have since been closed upstream

These were the points where the **5.10.1** public API couldn't do what paddock's
project model wanted cleanly. Every one has since shipped in core, and paddock
uses the first-class API in each case. Kept here for the rationale, and because
the "workaround in use" lines explain shapes still visible in the codebase.

1. ~~**Programmatic dynamic agents (primary).**~~ **CLOSED** (5.11.0) —
   `fleet.addAgent(config, {replace})` / `removeAgent(name)`
   (`fleet-manager.d.ts:175,188`). Paddock calls them directly; see section b.
   *Original ask:* register a project's agent in-memory instead of writing yaml +
   `reload()`, which coupled paddock to herdctl's on-disk config format and
   forced a full re-read on every project create.

2. ~~**First-class session list on FleetManager.**~~ **CLOSED** —
   `fleet.getAgentSessions(name, {limit})`, `getAgentSessionMessages(name, id)`,
   `getAgentSessionUsage`, `getAgentWorkingDirectory`, `deleteSession`,
   `setSessionName` and `invalidateSessions` all derive the working directory and
   Docker mode from the loaded config (`fleet-manager.d.ts:210-313`). Paddock no
   longer constructs its own `SessionDiscoveryService`. *Original ask:* avoid
   passing each agent's `{name, workingDirectory, dockerEnabled}` by hand and the
   cwd/agent mismatch it invited.

   > One caveat this API documents: `getAgentSessions` uses the agent's
   > **configured** `working_directory`. Sessions created under a per-trigger
   > `workingDirectory` override do not appear.

3. ~~**Reusable chat-message translation.**~~ **CLOSED** —
   `createSDKMessageHandler(handlers, options)` in `@herdctl/chat`
   (`sdk-message-translator.d.ts:227`) returns an
   `(message: SDKMessage) => Promise<void>` suitable for passing straight to
   `onMessage`. Paddock imports it in `herdctl.ts:69` and `ws-turn.ts:19`, and
   `@herdctl/chat@^0.8.0` is now a direct dependency rather than a package read
   for reference. *Original ask:* a transport-agnostic
   `streamTriggerToHandlers(trigger, handlers)` so paddock could drop its
   hand-rolled translation. (Core itself still ships no HTTP/WS server — that part
   of section f stands.)

4. ~~**Trigger that returns before completion (streaming handle).**~~ **CLOSED** —
   `openChatSession(agentName, options)` returns a live `RuntimeSession` the
   caller drives across turns, with `interrupt()` for cancellation
   (`fleet-manager.d.ts:325`). This is now paddock's DEFAULT path; see section c.
   *Original ask:* `trigger()` resolves only when the job finishes, so a returned
   handle would make cancellation and backpressure cleaner for the WS layer.

---

## Files

- Real wrapper: `packages/server/src/herdctl.ts` (`HerdctlService`) — **the
  authoritative description of what paddock actually calls.**
- Agent configs handed to `addAgent`: `packages/server/src/herdctl-agent-config.ts`.
- WS protocol + streaming: `packages/server/src/ws.ts`, `ws-turn.ts`,
  `ws-protocol.ts`.
- Project layer: `packages/server/src/projects.ts` (`ProjectStore`).
- Runtime/drive-mode split: [architecture overview §9](/architecture/overview#9-drive-mode--session-vs-batch).

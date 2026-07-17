# Paddock CONTRACT v3 — model selection, context meter, tool-less sweeper, release adoption

Authoritative spec for the v3 feature pass. Both the server and web changes MUST
match the shapes below exactly (they are the wire contract between packages).

Model IDs used throughout:
- Opus (keeper default): `claude-opus-4-8`
- Fable: `claude-fable-5`
- Sonnet: `claude-sonnet-5`
- Haiku (sweeper default): `claude-haiku-4-5-20251001`

(The picker list is maintained in `packages/server/src/models.ts`; see there for the
current entries and context limits, which supersede the illustrative block below.)

Context limit: 200000 tokens for all three (Opus 4.8 has a 1M-context beta variant,
but the keeper runs the standard 200k context via Max/CLI — keep 200000 unless told
otherwise).

---

## 1. Release adoption (drop shim + invalidateSessions)

- `packages/server/package.json`: bump `@herdctl/chat` → `^0.4.1`, `@herdctl/core` → `^5.12.0`. Run `npm install` at the repo root.
- `packages/server/src/ws.ts`: **delete** `normalizeForTranslator()` and its use. `@herdctl/chat@0.4.1` now pairs CLI tool results correctly, so pass each SDK message straight to `translate(m as unknown as ChatSDKMessage)`.
- After every successful turn, force a session-list refresh so a brand-new chat appears immediately: call `await deps.herdctl.invalidateSessions(agentName)` (try/catch, non-fatal) right after the trigger result, before sending `chat:complete`.
- `HerdctlService.invalidateSessions(agentName: string)` → wraps `this.manager.invalidateSessions(agentName)` (new public API in core 5.12.0). No-op-safe if the fleet isn't ready.

## 2. Models module (`packages/server/src/models.ts`, NEW)

```ts
export interface ModelInfo { id: string; label: string; contextLimit: number; }
export const MODELS: ModelInfo[] = [
  { id: "claude-opus-4-8", label: "Opus 4.8", contextLimit: 1_000_000 },
  { id: "claude-fable-5", label: "Fable 5", contextLimit: 1_000_000 },
  { id: "claude-sonnet-5", label: "Sonnet 5", contextLimit: 1_000_000 },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", contextLimit: 200000 },
];
export const KEEPER_DEFAULT_MODEL = "claude-opus-4-8";
export const SWEEPER_DEFAULT_MODEL = "claude-haiku-4-5-20251001";
export function isKnownModel(id: string): boolean;       // id is in MODELS
export function getContextLimit(id: string): number;     // matching contextLimit, else 200000
export function getModelInfo(id: string): ModelInfo | undefined;
```

`herdctl.ts`'s existing `SWEEPER_MODEL` should be replaced by / aliased to `SWEEPER_DEFAULT_MODEL`.

## 3. `GET /api/models`

```json
{
  "models": [ { "id": "claude-opus-4-8", "label": "Opus 4.8", "contextLimit": 200000 }, ... ],
  "keeperDefault": "claude-opus-4-8",
  "sweeperDefault": "claude-haiku-4-5-20251001"
}
```

## 4. Project model field

- `ProjectYaml` gains `model?: string` (optional on disk).
- `Project` DTO gains `model: string` — ALWAYS concrete: `yaml.model ?? KEEPER_DEFAULT_MODEL`.
- `UpdateProjectInput` gains `model`. `PATCH /api/projects/:slug` accepts `{ model }`; if present and not `isKnownModel`, respond 400. After a successful update, **re-register the keeper** so the new model takes effect: `await herdctl.ensureProjectAgent(project)`.
- `normalize()` carries `model` through; `toDto()` resolves the default; `stripDto()` keeps it in yaml.
- `create()` does NOT set model (new projects resolve to the keeper default in the DTO).

## 5. Keeper / sweeper model wiring (`herdctl.ts`)

- `defaults.model` in the generated herdctl.yaml → `KEEPER_DEFAULT_MODEL` (so scratch + any default-inheriting agent is Opus).
- `keeperAgentConfig(project, modelOverride?)`: `model: modelOverride ?? project.model ?? KEEPER_DEFAULT_MODEL`.
- Track the currently-registered model per agent: `private agentModels = new Map<string, string>()`.
  - `ensureProjectAgent(project)` registers the keeper with `project.model ?? KEEPER_DEFAULT_MODEL` and records it in the map (also registers the sweeper as today).
  - `init()` likewise records each keeper's model.
- **Per-chat model override** (no herdctl per-trigger model API exists yet, so we re-register):
  - `async ensureKeeperModel(project, model: string): Promise<void>` — if `agentModels.get(keeperName) === model` return; else `addAgent(keeperAgentConfig(project, model), { replace: true })` and update the map.
  - `async ensureScratchModel(model: string): Promise<void>` — same idea for the scratch agent (`scratchAgentConfig(model?)` takes an optional model override; default = `KEEPER_DEFAULT_MODEL`).
  - Document the single-user caveat in a comment: the keeper is one shared agent per project, so the model is last-write-wins across concurrent chats of the same project. Acceptable for single-user; a clean per-trigger override is a herdctl follow-up.

## 6. Tool-less sweeper (`herdctl.ts` + `sweep.ts`)

- `sweeperAgentConfig(project)`: `allowed_tools: []` (NO tools), `model: SWEEPER_DEFAULT_MODEL`, `max_turns: 4`, drop `denied_tools`/`permission_mode` (irrelevant with no tools). New `system_prompt`: it is a curator that **returns text only** — it never uses tools — emitting exactly the two marked sections below.
- `HerdctlService.runSweeper(slug, prompt)` returns `{ result: TriggerResult; text: string }`. Accumulate assistant text via `createSDKMessageHandler({ onText })` passed through the trigger's `onMessage` (same pattern as ws.ts). `text` is the full assistant output.
- `sweep.ts` `runSweep()`: call `runSweeper`, then **parse** the returned `text` and write the files itself:
  - Markers (exact):
    ```
    <<<OVERVIEW>>>
    ...full markdown overview (replaces OVERVIEW.md wholesale)...
    <<<CHANGELOG>>>
    ...exactly one bullet line (no leading "- ")...
    <<<END>>>
    ```
  - Overview = text between `<<<OVERVIEW>>>` and `<<<CHANGELOG>>>`, trimmed.
  - Changelog line = text between `<<<CHANGELOG>>>` and `<<<END>>>` (or EOF), trimmed to a single line.
  - If both markers are present and overview is non-empty: `projects.writeOverview(slug, overview)`; if the changelog line is non-empty: `projects.appendChangelog(slug, line)`.
  - If the markers are missing/unparseable: log a warn and **throw** (so the mtime watermark does not advance and the next sweep retries). Do NOT write partial/garbage content.
- `curationPrompt()`: keep providing the digest + current OVERVIEW + changelog tail, but change the TASKS section to instruct the tool-less return format above, and add "Do NOT use any tools. Output ONLY the two sections, nothing else." Keep `appendChangelog` adding the `- ` and date heading (so the sweeper returns the bare line).

## 7. WebSocket chat (`ws.ts`)

`chat:send` payload — add optional `model`:
```ts
{ projectSlug?, target?, sessionId?, message, preloadContext?, model? }  // model: a model id
```
- `isClientMessage`: accept `model` when it's a string (or absent).
- In `onChatSend`: capture the project object from `deps.projects.get(slug)` (currently discarded). Resolve `effectiveModel`:
  - project chat: `const requested = msg.payload.model; const effectiveModel = requested && isKnownModel(requested) ? requested : project.model;` then `await deps.herdctl.ensureKeeperModel(project, effectiveModel)` before `chat()`.
  - scratch: if `requested && isKnownModel(requested)` → `await deps.herdctl.ensureScratchModel(requested)`; effectiveModel = requested ?? KEEPER_DEFAULT_MODEL.
- Capture per-turn usage + model from the SDK stream in `onMessage` (in addition to session id). Helper `extractUsage(m)` reads, defensively:
  - assistant: `m.message?.usage` `{ input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }`, and `m.message?.model`.
  - result: `m.usage` (same fields).
  - Keep the LAST non-null usage seen (`lastUsage`) and last model (`lastModel`).

`chat:complete` payload — add `model` + `usage`:
```ts
payload: Routing & {
  success: boolean; error?: string;
  model?: string;                 // lastModel ?? effectiveModel
  usage?: {
    inputTokens: number; outputTokens: number;
    cacheReadTokens: number; cacheCreationTokens: number;
    contextTokens: number;        // inputTokens + cacheReadTokens + cacheCreationTokens
    contextLimit: number;         // getContextLimit(model)
  };
}
```
Omit `usage`/`model` if no usage was observed. Update the protocol doc-comment at the top of ws.ts.

## 8. Web UI — context meter + model picker (`packages/web`)

In the chat view (`components/ChatPane.tsx`), add a compact status row (e.g. just above
or below the message input) showing, for the CURRENTLY OPEN chat:

- **Model**: a `<select>` populated from `GET /api/models` (label text). Its value is the
  model for this chat. Default = the project's `model` (for scratch, `keeperDefault`).
  Changing it:
  - persists per chat in `localStorage` under `paddock:chatModel:<sessionId ?? "new:" + slug>`,
  - is sent as `model` in every subsequent `chat:send` for this chat.
  On opening an existing chat, restore the saved selection if present, else the project default.
- **Context meter**: `"{contextTokens/1000|0}k / {contextLimit/1000|0}k ({pct}%)"` with a thin
  progress bar. Source = the `usage` on the most recent `chat:complete` for this chat. It is
  intentionally stale-by-one-turn (last completed turn's input size). Before any turn completes,
  show the model with a muted "context: —" placeholder. Color the bar normally; if pct ≥ 80,
  use a warning color.

Wire-up:
- `lib/api.ts`: add `getModels()`; include `model` in the project update payload type.
- `lib/types.ts`: add `model: string` to the Project type; add `ModelInfo`; extend the
  `chat:complete` payload type with `model?` + `usage?` (shape in §7).
- `lib/ws.ts`: send `model` on `chat:send`; surface `model` + `usage` from `chat:complete`.
- Match existing Tailwind/dark-mode styling and the existing component conventions. Keep it
  unobtrusive — this is a status row, not a settings panel. The full per-project settings UI
  (issue #12) is out of scope here.

## Out of scope for v3
- Docker isolation (separate herdctl work — gaps identified).
- A dedicated per-project settings screen (#12).
- Server-side persistence of the per-chat model override (client localStorage is fine for now).

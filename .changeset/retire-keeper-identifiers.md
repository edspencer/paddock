---
"@paddock/server": minor
"@paddock/web": minor
---

Rename the "keeper" config, env, and API surface (#585). **Breaking** — the old
names are gone, with no aliases: pre-1.0, a minor may break the one before it.

Env vars:

| before | after |
|---|---|
| `PADDOCK_KEEPER_DRIVE_MODE` | `PADDOCK_DRIVE_MODE` |
| `PADDOCK_KEEPER_NATIVE_PROMPT` | `PADDOCK_NATIVE_PROMPT` |

Config file (`paddock.yaml`) and the instance-settings key: `keeperDriveMode` →
`driveMode`. An instance that still sets the old key falls back to the built-in
default (`session`) rather than erroring.

`GET /api/models` response fields: `keeperDefault` → `defaultModel`,
`keeperDriveModeDefault` → `driveModeDefault`. The self-MCP `create_project`
result field `keeperRegistered` → `agentRegistered`. Server and web change
together, so no client sees a mixed contract.

Internal constants and functions follow the same rule: `KEEPER_DEFAULT_MODEL` →
`DEFAULT_MODEL`, `KEEPER_DEFAULT_DRIVE_MODE` → `DEFAULT_DRIVE_MODE`,
`KEEPER_DEFAULT_MAX_TURNS` → `DEFAULT_MAX_TURNS`, `KEEPER_DEFAULT_PERMISSION_MODE`
→ `DEFAULT_PERMISSION_MODE`, `KEEPER_DEFAULT_DOCKER` → `DEFAULT_DOCKER`,
`KEEPER_DENIED_TOOLS` → `DENIED_TOOLS`, `resolveKeeperDefault` →
`resolveDefaultModel`, `buildKeeperConfig` → `buildAgentConfig`,
`ensureKeeperModel` → `ensureAgentModel`.

The `keeper-` agent-name prefix is deliberately untouched: it is persisted in
herdctl job records, `state.yaml`, session directories, and six sidecar stores
keyed `keeper-<slug>\0<sessionId>`. Renaming it would orphan all of that.

Also: three source files embedded a **raw NUL byte** in a string literal, which
made ripgrep classify them as binary and skip them silently — `ws.ts` was missed
by every `keeper` audit for that reason alone. They now spell it `\u0000`, the
convention the other sidecar stores already used. Same runtime value; the files
are greppable again.

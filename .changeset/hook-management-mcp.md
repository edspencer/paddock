---
"@paddock/server": minor
---

Hook-management MCP: `list_hooks` / `set_hook` / `remove_hook` self-MCP tools (Epic G / G5).

A project agent can now declare, edit, and delete its own event hooks through the
`mcp__paddock_manage__*` self-management server — the MCP twin of the (future) Hooks
tab. The three tools consume the G1 `HookService` (persist to `project.yaml`, then
register the `hook-<slug>-<name>` agent), mirroring the shipped schedule-management
tools. `set_hook` is create-or-update — `enabled` is just a field on the record (there
are no separate enable/disable verbs), and a brand-new hook defaults to `enabled: false`
(GG-3) so nothing fires the instant it is written; editing an existing hook without
`enabled` leaves its armed state unchanged. Capabilities (`allowed_tools`,
`denied_tools`, `permission_mode`, `model`, `max_turns`) are passed as flat args and
tolerate the CLI-runtime MCP transport dropping array types (accepted as a JSON array
or a comma/newline-separated string).

The tools are gated by a **per-project `hooksMcpEnabled` opt-in** (a sibling of
`selfMcpWriteEnabled`), **off by default**: an instance default (`PADDOCK_HOOKS_MCP`,
also settable via the YAML instance config) with a per-project `project.yaml` override,
resolved the same way as `maxSpawnDepth`. The gate is **binary access to the MCP** — an
agent that has the tools can create hooks at any capability (GG-4: no per-capability
gating, no curator/kind split). When the gate is off the tools are **absent** from the
injected server, not present-but-refusing.

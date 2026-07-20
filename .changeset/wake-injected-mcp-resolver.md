---
"@paddock/server": patch
---

Fix the injected-MCP "flap": re-establish self-management / send_file tools on session wakes (herdctl#390)

In session drive-mode, Paddock injects its in-process MCP servers
(`mcp__paddock_manage__*` self-management, `mcp__paddock__*` send_file) into keeper
turns via `injectedMcpServers`. herdctl's session **wake** path — a
`ScheduleWakeup` / `/loop` / `CronCreate` re-fire of an idle, reaped session — drove
the turn inside herdctl and re-spawned the agent subprocess with those tools still
"allowed" but with no in-process server behind them, so they vanished from the tool
catalog for the whole autonomous stretch (observed multi-hour episodes; permanent
after a server restart, since the durable wake set re-fired without injection).

`@herdctl/core` 5.22.1 added `FleetManager.setResolveInjectedMcpServers(resolve)` — a
synchronous resolver herdctl calls on each wake fire and threads into
`openChatSession` before the subprocess spawns. This change registers Paddock's
policy for it:

- Bump `@herdctl/core` to `^5.22.1`.
- Extract the per-turn injection construction into a shared `buildInjectedMcpServers`
  builder (`wake-injection.ts`), used by both the live `startAgentTurn` path (no
  behaviour change) and the wake rebuild, so the two can never drift.
- Cache the exact server set built for each live turn (human socket path and
  `startAgentTurn`); the sync resolver replays it on a wake. This closes the flap for
  the common case — a chat that self-schedules a wake is warm when it fires. On a cold
  miss (a durable wake re-firing after a **server restart**, before any live turn
  re-populates the cache) the resolver kicks a background rebuild so the **next** wake
  is covered; the first post-restart wake still degrades to no-injection until the next
  human/Trigger turn — the single documented residual.

Depth/scratch/self-MCP gating semantics are unchanged. No `@herdctl/chat` bump needed
(it accepts core `^5.22.0`).

---
"@paddock/server": patch
---

Config: fold scattered env reads into `PaddockConfig` (#269).

Ticket F1 of the Events / Schedules / Config initiative — a pure refactor with no
behaviour change, and the prerequisite for the YAML instance-config loader (F2).

Previously ~7 environment knobs were read ad-hoc, scattered across modules, so no
single object represented the whole instance. They are now resolved once (via the
existing `envOr`/`envOpt` helpers) into `PaddockConfig` and threaded through where
they're used:

- `LOG_LEVEL` → `cfg.logLevel` (Fastify logger).
- `PADDOCK_BROWSER_MCP` → `cfg.browserMcp` (`browserMcpServers(enabled)` in herdctl.ts).
- `PADDOCK_SWEEP_MIN_INTERVAL_MS` → `cfg.sweepMinIntervalMs` (passed to `SweepService`).
- `PADDOCK_GIT_AUTHOR_NAME` / `PADDOCK_GIT_AUTHOR_EMAIL` → `cfg.gitAuthor` (`GitService`).
- `PADDOCK_GITHUB_CLIENT_ID` → `cfg.githubClientId` (`GithubAuth`).

Defaults and parsing semantics are preserved exactly (e.g. an invalid sweep interval
still falls back to the 5-minute default; a blank GitHub client id is still treated as
"not configured"). `PaddockConfig` stays a plain, fully serializable object, which F2
depends on.

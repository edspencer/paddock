---
"@paddock/server": minor
"@paddock/web": patch
---

Remove the `recovery.limboTimeoutMs` lever, which never did anything

`limboTimeoutMs` / `PADDOCK_RECOVERY_LIMBO_MS` was parsed (`config.ts`),
defaulted (`recovery-config.ts`), sanitised, resolved per-project, carried into
the web types — and **read by nothing**. There were zero consumers in
`packages/server/src`. It has been inert since it was introduced with #301.

The docs were honest about it (*"Backstop timer ships in a follow-up"*), but the
Settings UI was not: `instance-config.ts` listed it as an `editable: true` field
alongside levers that work, with no indication it was a no-op. Anyone who set it
— including this project's own dev box, which exports
`PADDOCK_RECOVERY_LIMBO_MS=60000` — got silence and no way to tell.

Its original purpose was a backstop for a chat wedged "running" with no way out.
**#528 removed that need**: Stop now works during a chat's background phase, so a
wedged session is escapable from the UI rather than needing a timer to notice it.
Rather than implement a timer nothing is waiting for, the lever goes.

Removed end to end: the config key and env var, the Settings field, the
`RecoveryConfig` / `RecoveryOverride` member, and the docs rows describing it.

**Nothing breaks for existing installs.** `sanitizeRecoveryOverride` is an
allowlist, so a `limboTimeoutMs:` left in a `project.yaml` or
`paddock.config.yaml` is silently ignored — exactly the effect it has today. The
env var simply stops being read. No `schemaVersion` bump: the bump rule is
"remove a *load-bearing* key", and this one carried no load, which is the point.

Worth knowing if you provision Paddock with config management: any
`PADDOCK_RECOVERY_LIMBO_MS` in your environment is now dead weight and can be
dropped.

The remaining recovery levers — `surfaceKilledTask`, `autoReDrive`,
`debounceMs`, `maxRetries` — are unaffected and still work.

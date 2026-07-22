---
"@paddock/server": minor
"@paddock/web": minor
---

Add an instance-wide Settings screen that edits `paddock.config.yaml` (#385)

A new top-level admin Settings screen (`/settings`, reachable from a gear in the
sidebar) reads the instance configuration and writes the editable subset back to
`paddock.config.yaml` — no more hand-editing the file + restarting for the ~25
instance knobs (curation budgets, capabilities, recovery, attachments, branding,
transcription, git identity, log level, …).

- `GET /api/instance-config` reports every surfaced field with its
  `value`/`default`/`editable`/`sensitive`/`envOverridden` flags; no secret
  values are ever included.
- `PUT /api/instance-config` validates a patch against an editable allowlist and
  writes the file **comment-preservingly** (the `yaml` `Document` API) and
  **atomically** (temp + rename), creating it on first write.
- Instance config is read once at boot and frozen, so writes are
  **restart-required** — the screen shows a persistent banner saying so.
- Fields shadowed by a `PADDOCK_*` env var (env > file > default) render
  read-only with an "overridden by environment variable" note; process/filesystem
  bindings (ports, paths) and auth are read-only display in v1.

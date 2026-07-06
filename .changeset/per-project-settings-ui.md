---
"@paddock/server": minor
"@paddock/web": minor
---

feat: per-project keeper-agent settings UI (#12)

The Edit Project modal now surfaces a project's keeper-agent config, editable in
the UI: **model**, **permission mode**, **max turns**, and **Docker sandbox**
on/off. Previously only `model` was persisted per project (and not exposed in
the UI); `permission_mode`, `max_turns`, and `docker` existed only as fleet-wide
defaults.

Each setting is optional on disk and inherits the fleet default when unset (the
DTO resolves the concrete value). Saving validates the values server-side (400
on a bad model / permission mode / out-of-range max_turns / non-boolean docker)
and re-registers the project's keeper agent so the change takes effect. The
default values are now shared constants, so the fleet `defaults` block and the
per-project resolution stay in sync.

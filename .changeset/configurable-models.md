---
"@paddock/server": minor
"@paddock/web": minor
---

feat(models): make the offered model list configurable per instance + per project

The built-in `MODELS` catalog stays the authoritative source of model metadata
(label / context limit / pricing) and the `isKnownModel` validation set. What
becomes configurable is the ALLOW-LIST of which catalog models are offered —
operators pick from the catalog by id, so they can't misconfigure a context
limit.

- **Instance allow-list.** New `models` config knob — env `PADDOCK_MODELS`
  (comma-separated ids) over YAML `models:` (a string array) over the default
  (unset ⇒ every catalog model, unchanged behaviour). Unknown ids are dropped;
  an empty result collapses back to the full catalog, so an instance never
  offers zero models. Editable from the Instance Settings screen.
- **`GET /api/models`** now returns the resolved instance allow-list and the
  EFFECTIVE keeper default (the keeper default if still offered, else the first
  offered model).
- **Per-project override.** New per-project `models` allow-list (`project.yaml`
  + DTO + PATCH). It may only SUBSET the instance list — each id must be a known
  catalog model AND currently offered by the instance (a 400 otherwise). The
  Settings tab exposes a checkbox list; the per-project default and the per-chat
  picker are constrained to the project's subset when it sets one.
- Backward-compatible: with nothing configured, every catalog model is offered
  exactly as before.

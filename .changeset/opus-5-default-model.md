---
"@paddock/server": minor
"@paddock/web": minor
---

feat(models): add Claude Opus 5 and make it the default keeper model

Opus 5 (`claude-opus-5`) shipped 2026-07-24 — same $5/$25 per-MTok pricing as
Opus 4.8 but greatly improved performance for the same cost (stronger
verification/iteration, fewer reasoning tokens), and Anthropic's new default on
Claude Max, which is the tier Paddock's keeper agents run on.

- Add `claude-opus-5` as the first entry in the model picker (1M context
  window, $5/$25 pricing) and set `KEEPER_DEFAULT_MODEL` to it, so new
  projects and un-overridden keepers use Opus 5.
- Keep `claude-opus-4-8` selectable (non-default) for regression comparison and
  prompts tuned to 4.8's behaviour.
- Sweeper/curator default is unchanged (`claude-haiku-4-5-20251001`).

No config-schema change: the picker list, `/api/models`, `isKnownModel`
validation, context meter, and cost math all read the one-file `models.ts`
catalog, so this is a catalog + default bump only. Making the available-model
list itself instance/project-configurable is scoped as a follow-up.

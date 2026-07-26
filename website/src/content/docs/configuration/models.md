---
title: "Model allow-lists"
description: "Narrow which Claude models an instance offers, and let a project narrow it further — without ever ending up with none."
---

Paddock ships a built-in **catalog** of selectable Claude models. The catalog owns each
model's id, label, context limit and pricing, and it is the only place those live — you
pick models *by id*, you never describe one.

By default every catalog model is offered. Since v0.45 you can narrow that: an instance
can offer a subset, and a project can narrow the instance's subset further.

## Why narrow it

- **Cost.** Keep an instance on the cheaper models, or keep one experimental project on
  the expensive one without opening it to everything else.
- **Consistency.** Stop a long-running project from silently drifting between models
  turn to turn.
- **Noise.** A five-item picker for an instance that only ever uses two.

## The instance list

Three ways to set it — same setting, three surfaces:

```bash
PADDOCK_MODELS=claude-opus-5,claude-sonnet-5
```

```yaml
# paddock.config.yaml
models:
  - claude-opus-5
  - claude-sonnet-5
```

…or the **Offered models** field in the [Settings screen](/configuration/instance-settings/)
(under Capabilities), which writes that same YAML key.

Precedence is the usual `PADDOCK_MODELS` → `models:` → default. Leave all of them unset
and every catalog model is offered — that's the default and it stays fully
backward-compatible.

For the ids available on the release you're running, look at the model picker in the
composer, or `GET /api/models` — they come from one catalog constant in the server, so
the picker and the API can't disagree.

:::caution[The default model can move]
The keeper default (Opus) is used whenever a project doesn't pick one. If your
allow-list doesn't *include* the default, projects fall back to the **first offered
model in catalog order** instead. Narrowing the list can therefore change which model
your existing projects run on. Check the picker after a restart.
:::

## The per-project list

A project's **Settings** tab has its own offered-model list. The rule that matters:

> A project's list may only ever be a **subset** of the instance's list. It can narrow;
> it can never widen.

So an operator can't hand one project a model the instance itself hides. Concretely,
`PATCH`ing a project's `models`:

| You send | What happens |
|---|---|
| An id that isn't in the catalog at all | `400` — `Unknown model: <id>` |
| A catalog id the **instance** isn't offering | `400` — `Model not offered by this instance: <id>` |
| `null`, or an empty list | The override is **cleared** — the project inherits the instance list |
| A valid subset | Stored; the picker for that project shows only those |

Ticking every model in the project UI is the same as inheriting: the project offers the
instance list either way.

## Never zero models

The one invariant worth stating on its own: **an instance can't end up offering nothing.**

If the instance list resolves to empty — every id in it was blank, duplicated, or not a
catalog model — Paddock discards the list and offers the **full catalog** instead. A
typo in `PADDOCK_MODELS` gives you too many models, never none, and never a picker that
can't start a chat.

## Typos behave differently depending on where you make them

This is worth knowing, because the two paths are deliberately not the same:

- **In `PADDOCK_MODELS` or `models:`** — unknown, blank and duplicate ids are **dropped
  silently**, and if nothing survives you get the whole catalog (above). Config loading
  never fails startup over a model list.
- **In the Settings screen, or a project `PATCH`** — an unknown id is **rejected** with
  a `400` naming it, and so is an empty list. You're picking from a known catalog
  through a UI, so a typo should surface rather than quietly do nothing.

If you set a list in the environment and the picker doesn't change, suspect a typo
first: check the ids against `GET /api/models`.

## See also

- [Environment variables](/configuration/environment/#keeper--agents) — the `PADDOCK_MODELS` row.
- [The Settings screen](/configuration/instance-settings/) — the instance-level UI.
- [Creating & organizing projects](/using/creating-and-organizing-projects/) — the per-project Settings tab.

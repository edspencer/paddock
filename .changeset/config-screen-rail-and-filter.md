---
"@paddock/web": minor
---

The instance **Config** screen is navigable instead of one long slab. It rendered
~47 fields in 10 groups as a single narrow column of label-then-field rows —
5,508px, seven screenfuls — with no way to reach a known setting except scrolling
past everything else.

It now follows VS Code's settings screen rather than tabs, and the distinction
matters: tabs partition, which is exactly what defeats a search. A rail of
section links scroll-spies over ONE document, so "jump to Branding" and "find
every field mentioning `token`" are both available and neither disables the
other.

- A **section rail** with per-group counts, scroll-spy, and a dot marking groups
  that hold unsaved edits.
- A **live filter** matching label, dotted key, help text, env var and enum
  values, so an operator who thinks in `PADDOCK_*` names finds a field by typing
  one. It takes focus on load (pointer devices only — a phone would get the
  on-screen keyboard thrown over the page), and Escape empties it.
- A **"Modified only"** lens showing just what differs from the built-in default.
- **Env overrides** are a chip plus the variable name, with the explanation
  stated once in a legend. Repeating the same two-line notice beside twenty
  fields was the largest single source of the length on a containerized instance.
- Read-only bindings are no longer input-shaped, booleans are a switch on the
  label line, and short fields pair into two columns.

Behaviour is unchanged: same dirty-tracking, same patch payload, same
restart-required semantics.

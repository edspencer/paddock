---
"@paddock/server": patch
"@paddock/web": patch
---

Two small fixes to what the UI shows you (#546, #775)

- **The root workspace's Settings tab no longer shows a blank SLUG (#546).** The
  root workspace's key *is* the empty string — a real, routable key, not an
  absent one — so the read-only Slug row rendered a label with nothing under it,
  beside a populated "Started". It now reads a muted `(root)`, deliberately not
  in the mono face a real slug uses, so nobody copies it as one. A project's slug
  is unchanged. Gated on `isRootKey`, not on truthiness: `""` is exactly the
  falsy-key hazard this codebase has been bitten by before, and it only looks
  safe here because "empty key" and "no key" happen to want the same pixels.
- **`PADDOCK_SELF_MCP_PROJECTS` now describes what it actually grants (#775).**
  The Config screen said the lever lets keepers create new projects. It also
  gates `promote_project`, which `git clone`s a URL **the agent supplies** — the
  code-execution-class part of the grant, and the part an operator most needs to
  see before flipping it. The lever's own source comment already argued it
  deserved a separate flag *because* of that clone; the help text was the one
  place a human read about it and the one place it was missing.

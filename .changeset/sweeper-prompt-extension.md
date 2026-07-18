---
"@paddock/server": minor
---

Sweeper-prompt extension: optional per-project `.paddock/hooks/sweep.md` (G2).

A project can now commit extra curator instructions that are appended to the
sweeper's prompt at sweep time, letting each project steer how its `OVERVIEW.md`
/ `CHANGELOG.md` are curated (e.g. "always keep a Glossary section", "note API
changes prominently"). The file is git-tracked and keeper-editable, and lives
alongside `project.yaml`/`OVERVIEW.md`/`CHANGELOG.md` in the project directory —
the same directory the sweeper runs in.

When the file is present and non-blank, its content is appended verbatim under an
`=== EXTRA PROJECT-SPECIFIC CURATOR INSTRUCTIONS ===` heading (which refines *how*
to curate but never overrides the output-marker format or the box-conventions
rule); when it is absent or whitespace-only, sweep behaviour is exactly unchanged.
Reads are non-fatal — a missing or unreadable file simply yields no extra
instructions, so curation is never broken by a bad file.

This is a sweeper-local convenience: it only shapes the tool-less curator's prompt
and grants no new capability. It is deliberately not routed through the generic
hook framework (there is no hook "kind" or "curator" concept).

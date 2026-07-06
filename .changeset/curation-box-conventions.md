---
"@paddock/server": patch
---

fix(sweep): keep box/environment dev conventions out of curated OVERVIEW.md (#42)

The post-turn curation sweep could bake box-level operational conventions (how
to run/expose a dev server, ports, localhost-vs-dev-hostname, where to clone)
into a project's `OVERVIEW.md`. Because `OVERVIEW.md` is prepended to every new
chat, a stray "run on localhost:4100" line there silently overrode the box
`CLAUDE.md` — a self-reinforcing wrong-setup loop. Both curation prompts now
tell the curator that `OVERVIEW.md` describes the project (not the box) and must
not record those conventions, and a deterministic `stripBoxConventions`
normalizer drops any dev-server/how-to-run sections that slip through before the
file is written.

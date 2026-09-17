---
"@paddock/server": patch
---

The root workspace's title bar now reads **Home** instead of the projects
directory's name (#921).

With no name set, the root fell back to `basename(projectsRoot)` — so a fresh
instance titled itself lowercase `projects`, and one with a custom
`PADDOCK_PROJECTS_DIR` titled itself whatever that directory happened to be
called. It now falls back to "Home", the word the side nav and the workspace's
own tab already use. A name you set yourself is untouched.

That default is also no longer *persisted*: because `normalize()` runs on every
read and the mutators write the normalized record back, a single unrelated
settings save used to bake `name: projects` into `project.yaml` permanently.
Only a name you actually set is written now.

**Existing instances:** if your root's `project.yaml` already has a derived
`name:` line (i.e. you saved root settings on an older build), delete that one
line by hand — there is no automatic fixup.

---
"@paddock/server": patch
---

fix(scratch): run root (one-off) chats in the backing repo so the instance `CLAUDE.md` is actually loaded (#512).

`nativeSystemPrompt` defaults on, so Paddock sets **no** `system_prompt` for the
scratch agent — 100% of a root chat's standing instructions come from Claude
Code's `CLAUDE.md` walk-up from the cwd. That cwd was `PADDOCK_SCRATCH_DIR`, a
*sibling* of the backing repo with nothing above it, so on a real deployment every
root chat started with **zero instance context, silently**: project chats picked
up `<projectsRoot>/CLAUDE.md`, root chats picked up nothing.

The scratch agent's working directory is now `projectsRoot` — which *is* the
instance's backing repo checkout — so the repo's own top-level `CLAUDE.md`
resolves by the ordinary walk-up, exactly as it does for every keeper. No
special-casing, no new lookup path, and the root becomes git-backed for free
because its cwd is the repo.

Transcripts deliberately **do not** follow the cwd: the store stays at
`<scratchDir>/.chats/`, so root transcripts never enter the backing repo's
working tree — the same `chatsHostDir` split a repo-backed project uses (#187).
On upgrade **no chat file moves**; `ensureScratchChats` only points the new cwd's
encoded transcript bucket at the unmoved store and retires the pre-#512 pointer
(folding in, without clobbering, any real transcript dir an older instance left
there). Existing root chats keep listing, hydrating and resuming. `promoteScratchSession`
rewrites both the current and the legacy scratch cwd, so a chat that predates the
move promotes just as cleanly.

`PADDOCK_SCRATCH_DIR` is unchanged and still honoured — as the transcript /
scratch-file store, which is what it now exclusively means. Paddock also appends
`/.chats/` and `/.playwright-mcp/` to `<projectsRoot>/.gitignore` when that
directory is a git repo, so a root chat's tooling can't leave untracked droppings
at the repo root.

Also reconciles the three code comments that described two different files as
"the instance-wide CLAUDE.md": it is `<projectsRoot>/CLAUDE.md`, canonically —
inside the backing repo, therefore version-controlled and pushed with everything
else — never `<dataDir>/CLAUDE.md`.

This is a cwd change only. Scratch is still not a project: no self-management
MCP, no sweeper, no per-project config (#513).

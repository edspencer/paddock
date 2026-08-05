---
"@paddock/server": minor
---

A `claude:` block in `paddock.config.yaml`, and Paddock always owns its Claude
home (#691, closes #690).

Paddock had one lever — which Claude home it pointed at — and every distinct
concern was welded to it: whose transcripts a delete removed, which login was
visible, where agent memory was written. Three incidents in a week (#682, #683,
#689) all came out of moving it for one reason and getting the other four for
free. This splits the first concern out.

```yaml
claude:
  transcripts: own    # own | host — default own
```

`own` (the default) is today's behaviour: transcripts live in each project's
`.chats/`, inside the data dir, and nothing outside it is written. `host` shares
your real `~/.claude/projects/<encoded-cwd>/` folder live in both directions — a
chat continued in a terminal with `claude --resume` shows up in Paddock with no
restart and no re-import. Deleting a chat under `host` **releases** it rather
than removing it (#689): the transcript is your history, not Paddock's copy.
`PADDOCK_CLAUDE_TRANSCRIPTS` overrides the file, as usual.

`host` is one symlink per project pointing *out* of Paddock's own Claude home,
not a repointed `CLAUDE_CONFIG_DIR`. That is what fixes **#690**: agent memory
lives at `<claudeHome>/projects/<enc>/memory`, and an agent cannot write to any
path containing a `.claude` component — so 0.61.1's "share by pointing the home
at `~/.claude`" silently took agent memory away. Here the literal path stays
inside Paddock's own home in both modes; only what it resolves to changes.

**Breaking, deliberately and without a compatibility shim:**

- **`CLAUDE_HOME` is deleted.** It is ignored, not an error (retired settings are
  never fatal), so a stale export cannot move the home back on top of yours.
- **`--isolated-claude-home` is deleted.** It opted out of something Paddock no
  longer does.
- **`CLAUDE_CONFIG_DIR` is still honoured** as "put Paddock's own home here" —
  it is Claude Code's own variable and herdctl declines to clobber an
  operator-set value — but Paddock now **refuses to start** if it (or a
  `claudeHome:` key) resolves to your own `~/.claude`. That is the single value
  that re-welds every concern together and re-breaks agent memory; the refusal
  names `transcripts: host` as what you probably wanted.

Existing instances need no migration: transcripts already live in each project's
`.chats/`, so moving the home moves no data — the first boot replants each
project's symlink in the new home aimed at the same directory. Verified by
running an instance of each version against copies of one real fixture: chat
lists, adoptable counts, message bodies and `.chats/` content hashes were
identical, and the only difference on disk was the replanted links.

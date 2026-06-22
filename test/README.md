# paddock test harness

Repo-level test assets shared across layers. Full guide: **`docs/TESTING.md`**.

```
test/
├── bin/claude          # the fake `claude` CLI (stand-in for the real binary)
└── e2e/                # Playwright E2E (config, server launcher, specs)
```

Server unit + integration tests live under `packages/server/test/`; web unit +
component tests live under `packages/web/src/**/*.test.{ts,tsx}`.

## `test/bin/claude` — the fake LLM

A deterministic, executable Node script placed first on `PATH` for the server
under test. herdctl's CLI runtime spawns `claude` from PATH and watches the
session `.jsonl` it writes, so the fake writes a real transcript instead of
calling Anthropic. It:

- parses herdctl's flags (`-p`, `--model`, `--system-prompt`, `--resume`, …) and
  reads the prompt from stdin,
- writes `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` (the encoded path
  is paddock's symlink into `<project>/.chats`) with the exact `user` /
  `assistant` / `result` line shapes herdctl's parser + the `@herdctl/chat`
  translator consume,
- mints a UUID for a new session, or appends to `<id>.jsonl` on `--resume`
  (reading the prior transcript so continuity — "what was the codeword?" — works),
- replies deterministically: `PADDOCK_FAKE_SCRIPT` (a JSON prompt→reply map),
  built-in codeword rules, else `Acknowledged: <prompt>`.

### What works vs. what's stubbed

**Works:** WS streaming of a turn, transcript write + session discovery, history
hydration, context-usage readback, `--resume` continuity, promote mechanics
(list + hydrate + job re-attribution), git status/diff/commit, and all five E2E
flows — all with no Anthropic calls.

**Stubbed / TODO** (see `docs/TESTING.md` § Known gaps): the fake emits only
text turns (no tool_use/tool_result blocks) and no sweeper-marker output (the
post-turn sweep errors harmlessly); resume-after-promote currently forks a fresh
session (a documented herdctl/paddock gap, asserted as-is); `github-auth.ts` and
the browser git/model/pins UI are not yet covered.

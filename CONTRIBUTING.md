# Contributing to Paddock

Thanks for hacking on Paddock. This is a short operational guide — how to get the
stack running, the conventions we follow, and the environment gotchas that will
otherwise cost you an afternoon. For deeper material, follow the links rather than
re-reading it here:

- **[DEV.md](DEV.md)** — running the full stack locally (production-like and
  hot-reload modes), voice dictation setup.
- **[docs/CONFIGURATION.md](docs/CONFIGURATION.md)** — every `PADDOCK_*` env var
  with its default.
- **[docs/API.md](docs/API.md)** — the REST + WebSocket contract.
- **[docs/TESTING.md](docs/TESTING.md)** — the test strategy and layers.
- **[RELEASING.md](RELEASING.md)** — the changesets + release pipeline.
- **[AUTH.md](AUTH.md)** — authentication modes and secret handling.

## Prerequisites

- **Node 22+** and the **`claude` CLI** on your `PATH` (`claude --version`).
- A **Claude Max OAuth token** (`CLAUDE_CODE_OAUTH_TOKEN`) or an
  `ANTHROPIC_API_KEY` in your environment. Never print or commit it — load it into
  the environment, don't hardcode it (see [DEV.md](DEV.md)).

## Getting started

```bash
npm install                 # install all workspaces
npm run build               # build server (tsc) + web (vite)
npm run dev                 # server on :4000 (API + WS)      — terminal 1
npm run dev:web             # Vite dev server, proxies to :4000 — terminal 2
```

See [DEV.md](DEV.md) for the two run modes and their tradeoffs.

## Tests & checks

Run these before opening a PR — CI runs the same set:

```bash
npm run typecheck           # tsc on both packages
npm test                    # server (unit + integration) + web (component)
npm run test:e2e            # Playwright journeys against the real server + a fake `claude`
```

- `npm run test:server` / `npm run test:web` run one side only.
- `npm run test:e2e` drives the **real** server, FleetManager, and CLI runtime;
  only the LLM is swapped for a fake `claude` on PATH (zero Anthropic calls). Opt
  into a real-Claude run with `npm run test:e2e:live`.
- More on the test layers: [docs/TESTING.md](docs/TESTING.md).

## Environment gotchas

These bite everyone at least once:

- **`NODE_ENV=production` prunes dev dependencies.** If your shell exports
  `NODE_ENV=production` (some servers/CI images do), a plain `npm install` silently
  drops `tsc`, `vitest`, Playwright, etc., and you'll see "command not found" for
  the tools above. Install dev tooling explicitly:

  ```bash
  NODE_ENV=development npm install --include=dev
  ```

- **Run tests/builds with `NODE_ENV` unset.** `NODE_ENV=production` also breaks
  React `act()` in the web component tests. Unset it for the run:

  ```bash
  env -u NODE_ENV npm run typecheck
  env -u NODE_ENV npm test
  env -u NODE_ENV npm run build
  ```

- **Use a throwaway data dir** so local runs don't touch real projects:
  `export PADDOCK_DATA_DIR="$(mktemp -d /tmp/paddock-dev.XXXXXX)"`.

## Branch, commit & PR conventions

- **Branch for every non-trivial change** — never commit to `main` directly, and
  **never force-push** a shared branch.
- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/):
  `type(scope): summary`, e.g. `feat(web): fork button`, `fix(server): drain queue
  on stop`, `docs(config): env-var reference`. Common types: `feat`, `fix`,
  `docs`, `refactor`, `test`, `chore`, `ci`.
- **Open a PR against `main`.** Keep PRs small and focused; describe what changed
  and how you verified it. CI (typecheck + tests + E2E) must be green.

## Changesets (release notes)

Paddock uses [changesets](https://github.com/changesets/changesets) for versioning
and changelogs. **When your PR makes a user-facing change, add a changeset in the
same PR:**

```bash
npm run changeset           # pick patch/minor/major + write a one-line summary
git add .changeset && git commit -m "chore: add changeset"
```

No changeset is needed for pure-internal changes (tests, CI, refactors with no
observable effect, or **docs-only** changes to root/`docs/` files that don't ship
in a package). The full release flow — how the "chore: version packages" PR cuts a
Docker image + tarball — is in [RELEASING.md](RELEASING.md).
</content>
</invoke>

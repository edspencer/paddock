---
title: "Contributing"
description: "How to contribute to Paddock: workflow, conventions, and release process."
---

Thanks for hacking on Paddock. This is a short operational guide — how to get the
stack running, the conventions we follow, and the environment gotchas that will
otherwise cost you an afternoon. For deeper material, follow the links rather than
re-reading it here:

- **[DEV.md](https://github.com/edspencer/paddock/blob/main/DEV.md)** — running the full stack locally (production-like and
  hot-reload modes), voice dictation setup.
- **[docs/CONFIGURATION.md](/configuration/environment)** — every `PADDOCK_*` env var
  with its default.
- **[docs/API.md](/reference/api)** — the REST + WebSocket contract.
- **[docs/TESTING.md](/contributing/testing)** — the test strategy and layers.
- **[RELEASING.md](https://github.com/edspencer/paddock/blob/main/RELEASING.md)** — the changesets + release pipeline.
- **[AUTH.md](/configuration/authentication)** — authentication modes and secret handling.

## Prerequisites

- **Node 22+**, and the **`claude` CLI** on your `PATH` (`claude --version`) for the
  post-turn **sweeper** and for any turn resolved to **`driveMode: batch`**. Chats
  resolve the SDK's own bundled binary and never consult `PATH`, so they run without
  it — and so do **triggers**, which resolve their drive mode exactly like a chat
  (project override, else the instance default, which is `session`). Only the sweeper
  goes through the CLI unconditionally. If you are reading the source, note that
  several comments still claim *all* triggers are CLI turns — they are wrong, and
  tracked as [#771](https://github.com/edspencer/paddock/issues/771).
- A **Claude Max OAuth token** (`CLAUDE_CODE_OAUTH_TOKEN`) or an
  `ANTHROPIC_API_KEY` in your environment. Never print or commit it — load it into
  the environment, don't hardcode it (see [DEV.md](https://github.com/edspencer/paddock/blob/main/DEV.md)).

## Getting started

```bash
npm install                 # install all workspaces
npm run build               # build server (tsc) + web (vite)
npm run dev                 # server on :7233 (API + WS)      — terminal 1
npm run dev:web             # Vite dev server, proxies to :7233 — terminal 2
```

See [DEV.md](https://github.com/edspencer/paddock/blob/main/DEV.md) for the two run modes and their tradeoffs.

## Tests & checks

Run these before opening a PR — CI runs the same set:

```bash
npm run check:nul           # guard: no raw NUL bytes in JS/TS sources
npm run typecheck           # tsc on both packages
npm test                    # server (unit + integration) + web (component)
npm run test:e2e            # Playwright journeys against the real server + a fake `claude`
```

- `npm run check:nul` runs **before `npm ci`** in CI — it needs no dependencies, and a
  raw `0x00` in a source file is invisible in a diff while making `grep`/`ripgrep` skip
  the whole file as binary, so nothing later in the run would catch it.
- If you touched **`website/`** or **`openapi-site/`**, CI also builds the docs site
  (`cd website && npm install && npm run build`). That job is path-filtered, so it only
  runs when those directories change — but it is the only thing that catches an
  unresolvable sidebar `slug` or a broken relative image path.
- `npm run test:server` / `npm run test:web` run one side only.
- `npm run test:e2e` drives the **real** server, FleetManager, and CLI runtime;
  only the LLM is swapped for a fake `claude` on PATH (zero Anthropic calls). Opt
  into a real-Claude run with `npm run test:e2e:live`.
- More on the test layers: [docs/TESTING.md](/contributing/testing).

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
  and how you verified it. CI (NUL guard + typecheck + tests + E2E, plus the docs-site
  build when `website/` changes) must be green.

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
Docker image and a tarball, and **publishes `@edspencer/paddock` to npm** via OIDC
trusted publishing (with a provenance attestation the workflow then verifies) — is in
[RELEASING.md](https://github.com/edspencer/paddock/blob/main/RELEASING.md). That npm
package is what every `npx @edspencer/paddock` install path on this site resolves to.

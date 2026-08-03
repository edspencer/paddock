# Releasing Paddock

Paddock is an **application**, not a set of published libraries. We use
[changesets](https://github.com/changesets/changesets) for versioning and
changelogs (like herdctl). The workspace packages (`@paddock/server`,
`@paddock/web`) stay `private` and are never published under their own names.
Every release produces three artifacts:

- a multi-arch Docker image → `ghcr.io/edspencer/paddock:<version>` (+ `:latest`)
- a self-contained release tarball → attached to the GitHub Release `v<version>`
- an npm package → **`@edspencer/paddock`**, the `npx` entry point

### The npm package is synthesized, not a workspace package

`scripts/make-npm-package.mjs` stages a single public package from the built
output into `dist-npm/`. The workspace manifests are left alone — flipping their
`private` flag would make every future `npm publish` in the repo a loaded gun
pointed at an internal-named package.

Two deliberate divergences from the repo, both in that script:

- **Sourcemaps are stripped** (files *and* `sourceMappingURL` comments): 15 MB of
  the 19 MB web dist, for something an end user of a packaged app never opens.
  2.0 MB packed / 6.0 MB unpacked, versus ~22 MB with maps. The Docker image and
  the GitHub release tarball keep theirs.
- **Dependencies are pinned** to the exact versions in `package-lock.json`. A
  lockfile does not travel with a published package — consumers re-resolve
  against the declared ranges, so a caret would hand `npx` users a
  `@herdctl/core` minor that paddock's CI never saw.

### npm auth: OIDC trusted publishing, no token

The `publish-npm` job authenticates via **OIDC trusted publishing**. There is no
`NPM_TOKEN` secret and there should never be one. This needs `id-token: write`,
npm ≥ 11.5.1 (Node 22 ships npm 10, so the job upgrades it), `registry-url` on
`setup-node`, and a trusted publisher configured for this repo + workflow at
`npmjs.com/package/@edspencer/paddock/access`.

Provenance is attested automatically; the job verifies it landed and fails the
release if it did not.

### How this package was bootstrapped (one-time, already done)

A brand-new package **cannot** be created by OIDC: npm has no settings page for a
package that does not exist, so there is nowhere to attach a trusted publisher
([npm/cli#8544](https://github.com/npm/cli/issues/8544)). The chicken-and-egg is
broken with a **placeholder release containing no code** — enough to create the
package and unlock its settings page, and nothing more.

```sh
mkdir /tmp/paddock-bootstrap && cd /tmp/paddock-bootstrap
# package.json: name + version 0.0.1 + repository + publishConfig.access=public.
# Deliberately NO bin, NO dependencies, NO preinstall, and NO
# publishConfig.provenance — see the two traps below.
npm login                                   # 2-hour session, 2FA; nothing stored
npm publish --tag bootstrap
```

Then at `npmjs.com/package/@edspencer/paddock/access` → **Trusted Publisher**:
repository `edspencer/paddock`, workflow `release.yml`, environment blank. From
that point the `publish-npm` job publishes every release with provenance and no
credential exists anywhere.

Two traps this recipe avoids:

- **Never set `publishConfig.provenance` on a manual publish.** npm refuses it
  outside a supported CI — *"Automatic provenance generation not supported
  outside of GitHub Actions"*. The real manifest sets it, which is exactly why
  the placeholder is a separate hand-written file rather than `npm run pack:npm`
  output. (If you ever must publish the real package by hand, override with
  `--no-provenance`.)
- **`--tag bootstrap`, not `latest`.** A placeholder on `latest` means
  `npx @edspencer/paddock` resolves a package with no `bin` and fails with a
  confusing "could not determine executable to run". Keeping it off `latest`
  means npx says "no matching version" until the first CI release, which is at
  least honest. The placeholder is permanently unattested — that is unavoidable
  and is why it holds no code.

## Versioning model

- `@paddock/server` and `@paddock/web` are `private` and `fixed` together in
  `.changeset/config.json`, so they always share one number — **that number is
  "the Paddock version"**. The repo-root `paddock` version is kept in lockstep by
  `scripts/sync-root-version.mjs`.
- Bumps are driven by changesets, so the version reflects the nature of the
  changes (patch/minor/major) rather than being hand-cranked.

## Day-to-day: adding a changeset

When you make a user-facing change, add a changeset in the same PR:

```sh
npm run changeset
# pick the bump (patch/minor/major) and write a one-line summary
git add .changeset && git commit -m "add changeset"
```

No changeset is needed for pure-internal changes (tests, CI, refactors with no
observable effect).

For a user-facing change, also add a short highlight to the **What's New** docs
page (`website/src/content/docs/whats-new.md`) so the docs site stays current.

## Cutting a release (automated)

1. Merge feature PRs (each carrying its changeset) into `main`.
2. The **Release** workflow opens/updates a **"chore: version packages"** PR that
   bumps the version, updates `CHANGELOG.md`, and refreshes the lockfile.
3. **Merge that PR.** On the merge, the same workflow run first **waits for CI
   to pass on the merge commit** (the `verify-ci` job) and then:
   - builds & pushes `ghcr.io/edspencer/paddock:<version>` and `:latest`
     (linux/amd64 + linux/arm64);
   - builds `paddock-<version>.tgz` (+ `.sha256`);
   - creates GitHub Release `v<version>` with the tarball attached — both the
     pinned `paddock-<version>.tgz` and a stable-named `paddock-latest.tgz`
     (+ `.sha256`) copy, so
     `releases/latest/download/paddock-latest.tgz` always resolves to the
     newest release.

`workflow_dispatch` is available to re-run the pipeline manually.

### The version PR's own checks are not enough

The version PR is opened by `github-actions[bot]`, and GitHub parks workflow runs
from bot-authored PRs at **`action_required`** pending manual approval. Nothing
surfaces this: the PR sits there looking green because the *external* checks
(Cloudflare Pages, GitGuardian) do run, while **typecheck, unit/integration and
E2E never ran at all**.

It is not a local quirk — every run on `changeset-release/main` in this repo and
in `edspencer/herdctl` has been parked that way. **v0.54.2 shipped like this.**

Two things follow:

- **Approve the run** if you want to see real CI before merging: on the version
  PR, Actions → the pending CI run → *Approve and run*. Optional, but it is the
  only way to get a verdict pre-merge.
- **You cannot ship unverified regardless.** CI on `main` is *not* gated (a human
  pushes the merge), and the `verify-ci` job now blocks on it: no image is pushed
  to GHCR, no tarball is built, and no GitHub Release is created unless CI
  concluded `success` on that exact commit.

If CI is red for a reason you judge unrelated — a flake — fix or re-run CI until
it is green, then re-run the pipeline via **Actions → Release → Run workflow**.
Overriding is deliberately a conscious act rather than the default path.

## Running an artifact

**Docker:**

```sh
docker run -d --name paddock \
  -p 4000:4000 \
  -v /srv/paddock-data:/data \
  -e CLAUDE_CODE_OAUTH_TOKEN=... \
  -e GITHUB_TOKEN=...            # optional, for git push of the backing repo
  ghcr.io/edspencer/paddock:latest
```

**Tarball:** see `INSTALL.md` inside the tarball. In short: `npm ci --omit=dev`
then `node packages/server/dist/index.js` (needs Node >= 22 and the `claude` CLI
on PATH).

## Local dry-runs

```sh
npm run build
bash scripts/make-tarball.sh                 # produces paddock-<version>.tgz
docker build -t paddock:dev .                # builds the image locally
npx changeset status --since origin/main     # what would the next bump be
```

## Keeping the demo reel current

The README and docs homepage lead with a generated reel of the UI
(`docs/demo/paddock-demo.gif`). It is **not** part of the release pipeline — it
is regenerated on demand:

```sh
npm run demo:gif      # ~4 minutes; see scripts/demo-gif/README.md
```

Worth a thought whenever a release visibly changes the UI: a new tab, a redesigned
pane, a renamed concept. The reel went **26 minor versions stale** once, largely
because nothing pointed at it — a minute's check here is the cheap fix.

## What this pipeline does NOT do (yet)

It **publishes** artifacts; it does not **deploy** them to the running instances
(`paddock-apps` .60, `paddock-lab` .61). Continuous delivery — rolling the
newest published version out to the boxes — is tracked separately.

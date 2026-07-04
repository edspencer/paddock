# Releasing Paddock

Paddock is an **application**, not a set of published libraries. We use
[changesets](https://github.com/changesets/changesets) for versioning and
changelogs (like herdctl), but we do **not** publish the packages to npm.
Instead every release produces two artifacts:

- a multi-arch Docker image → `ghcr.io/edspencer/paddock:<version>` (+ `:latest`)
- a self-contained release tarball → attached to the GitHub Release `v<version>`

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

## Cutting a release (automated)

1. Merge feature PRs (each carrying its changeset) into `main`.
2. The **Release** workflow opens/updates a **"chore: version packages"** PR that
   bumps the version, updates `CHANGELOG.md`, and refreshes the lockfile.
3. **Merge that PR.** On the merge, the same workflow run:
   - builds & pushes `ghcr.io/edspencer/paddock:<version>` and `:latest`
     (linux/amd64 + linux/arm64);
   - builds `paddock-<version>.tgz` (+ `.sha256`);
   - creates GitHub Release `v<version>` with the tarball attached.

`workflow_dispatch` is available to re-run the pipeline manually.

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

## What this pipeline does NOT do (yet)

It **publishes** artifacts; it does not **deploy** them to the running instances
(`paddock-apps` .60, `paddock-lab` .61). Continuous delivery — rolling the
newest published version out to the boxes — is tracked separately.

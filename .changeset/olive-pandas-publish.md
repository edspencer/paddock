---
"@paddock/server": minor
---

Publish Paddock to npm as `@edspencer/paddock` — `npx @edspencer/paddock` (#637)

Paddock is now installable without Docker and without a clone:

```sh
npx @edspencer/paddock
```

The published package is **synthesized**, not a workspace package.
`scripts/make-npm-package.mjs` stages a single public package from the built
output; `@paddock/server` and `@paddock/web` stay `private` and unrenamed, so no
future `npm publish` in this repo can fire an internal-named package at the
registry by accident.

Two deliberate divergences from the repo tree: **sourcemaps are stripped** (files
and `sourceMappingURL` comments — 15 MB of the 19 MB web dist, for something an
end user of a packaged app never opens; 2.0 MB packed vs ~22 MB with maps), and
**dependencies are pinned** to the versions in `package-lock.json`, because a
lockfile does not travel with a published package and a caret would hand `npx`
users a `@herdctl/core` minor that CI never saw.

Releases publish via **OIDC trusted publishing** with provenance attestation —
no `NPM_TOKEN` secret exists, and the job fails the release if the attestation
does not appear.

Also corrects a long-standing docs claim: `CONTRIBUTING.md`, `DEV.md` and
`CLAUDE.md` all listed the `claude` CLI as a flat prerequisite. Chats do not need
it — they run herdctl's SDK runtime, which resolves the Claude Agent SDK's own
bundled binary and never consults `PATH`. Only the sweeper, triggers and
`driveMode: batch` shell out to `claude`.

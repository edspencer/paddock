#!/usr/bin/env node
// Keep the root `paddock` package version in lockstep with the app version.
//
// Paddock is an APP, not a set of published libraries. `@paddock/server` and
// `@paddock/web` are `fixed` in .changeset/config.json, so `changeset version`
// bumps them together to a single number — that number IS "the Paddock version".
// The repo-root package.json ("paddock") is the workspace root, not a workspace
// member, so changesets never touches it. This script copies the canonical app
// version (from packages/server) up to the root so `paddock`'s own version stays
// truthful — it's what the release tag, Docker image tag, and tarball name read.
//
// Run automatically by `npm run changeset:version` (see package.json).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverPkgPath = join(repoRoot, "packages", "server", "package.json");
const rootPkgPath = join(repoRoot, "package.json");

const serverPkg = JSON.parse(readFileSync(serverPkgPath, "utf8"));
const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));

if (!serverPkg.version) {
  console.error("sync-root-version: no version found in packages/server/package.json");
  process.exit(1);
}

if (rootPkg.version === serverPkg.version) {
  console.log(`sync-root-version: root already at ${rootPkg.version}, nothing to do`);
  process.exit(0);
}

const previous = rootPkg.version;
rootPkg.version = serverPkg.version;
writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + "\n");
console.log(`sync-root-version: root ${previous} -> ${serverPkg.version}`);

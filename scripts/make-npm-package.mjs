#!/usr/bin/env node
/**
 * Stage the publishable `@edspencer/paddock` npm package (#637).
 *
 * Paddock's workspace packages are `private` and internally named
 * (`@paddock/server`, `@paddock/web`). Rather than flip `private` — which makes
 * every future `npm publish` in the repo a loaded gun pointed at an
 * internal-named package — this script SYNTHESIZES a single public package from
 * the built output. The repo manifests stay private and unchanged.
 *
 * ## Layout
 *
 * The staged tree mirrors the repo's, because the server locates the SPA at
 * `../../web/dist` RELATIVE TO ITS OWN MODULE (config.ts `resolveDefaultWebDist`):
 *
 *     package.json                  <- synthesized, @edspencer/paddock
 *     README.md                     <- npm landing page
 *     packages/server/package.json  <- kept: the CLI reads its version from here
 *     packages/server/dist/**       <- compiled server + the `paddock` bin
 *     packages/web/dist/**          <- built SPA
 *
 * Dependencies are declared at the ROOT, so npm installs them to
 * `<pkg>/node_modules` and Node's upward resolution finds them from
 * `packages/server/dist/*.js`. The bin's own `findUp` handles the same hop for
 * `node_modules/.bin`.
 *
 * ## Two deliberate divergences from the repo
 *
 * 1. **Sourcemaps are excluded.** They are 15 MB of the 19 MB web dist plus 194
 *    files in the server dist — ~4x the tarball for something an end user of a
 *    packaged app never opens. They remain in the Docker image and the GitHub
 *    release tarball.
 * 2. **Dependencies are PINNED to the versions in package-lock.json.** A
 *    lockfile does not travel with a published package: consumers re-resolve
 *    against the declared ranges, so a caret would hand `npx` users a
 *    `@herdctl/core` minor that paddock's CI never saw. Docker does not have
 *    this exposure because it builds with `npm ci` against the committed lock.
 *    Pinning makes the published closure the tested closure.
 *
 * Usage:  node scripts/make-npm-package.mjs [--outdir dist-npm]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(repoRoot, argValue("--outdir") ?? "dist-npm");

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function die(msg) {
  console.error(`make-npm-package: ${msg}`);
  process.exit(1);
}

/**
 * Copy a tree, dropping sourcemaps.
 *
 * Both halves matter: omitting the `.map` FILES but leaving the
 * `//# sourceMappingURL=` comments would make every stack trace in the wild
 * emit a fetch for a file that 404s.
 */
function copyTreeWithoutMaps(from, to) {
  let files = 0;
  let mapsSkipped = 0;
  const walk = (src, dest) => {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        walk(s, d);
        continue;
      }
      if (entry.name.endsWith(".map")) {
        mapsSkipped++;
        continue;
      }
      // `.d.ts` matters as much as `.js`: tsc emits a `sourceMappingURL`
      // pointing at a `.d.ts.map` we also drop, leaving a dangling reference.
      if (/\.(js|mjs|cjs|css|d\.ts)$/.test(entry.name)) {
        const body = fs.readFileSync(s, "utf8");
        fs.writeFileSync(d, stripSourceMappingUrl(body), "utf8");
      } else {
        fs.copyFileSync(s, d);
      }
      files++;
    }
  };
  walk(from, to);
  return { files, mapsSkipped };
}

function stripSourceMappingUrl(body) {
  return body
    .replace(/^\s*\/\/# sourceMappingURL=.*$/gm, "")
    .replace(/^\s*\/\*# sourceMappingURL=.*?\*\/\s*$/gm, "");
}

/**
 * Resolve each declared dependency to the exact version the lockfile pins.
 *
 * The lock records workspace deps under `node_modules/<name>` at the root and,
 * when a version had to be nested to satisfy a conflict, under
 * `packages/server/node_modules/<name>`. The nested entry wins: that is the one
 * the server actually resolves at runtime.
 */
function pinnedVersions(lock, deps, workspaceDir) {
  const out = {};
  for (const name of Object.keys(deps).sort()) {
    const nested = lock.packages?.[`${workspaceDir}/node_modules/${name}`];
    const hoisted = lock.packages?.[`node_modules/${name}`];
    const version = nested?.version ?? hoisted?.version;
    if (!version) die(`no locked version for "${name}" — run npm install first`);
    out[name] = version;
  }
  return out;
}

// ---------------------------------------------------------------------------

const serverPkg = readJson(path.join(repoRoot, "packages/server/package.json"));
const lock = readJson(path.join(repoRoot, "package-lock.json"));
const version = serverPkg.version;

const serverDist = path.join(repoRoot, "packages/server/dist");
const webDist = path.join(repoRoot, "packages/web/dist");
for (const [label, dir] of [
  ["packages/server/dist", serverDist],
  ["packages/web/dist", webDist],
]) {
  if (!fs.existsSync(dir)) die(`${label} missing — run \`npm run build\` first`);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const server = copyTreeWithoutMaps(serverDist, path.join(outDir, "packages/server/dist"));
const web = copyTreeWithoutMaps(webDist, path.join(outDir, "packages/web/dist"));

// The CLI reads its version from the nearest package.json above it, which in
// this layout is this file. Keep it minimal — it is not a published package.
fs.mkdirSync(path.join(outDir, "packages/server"), { recursive: true });
fs.writeFileSync(
  path.join(outDir, "packages/server/package.json"),
  JSON.stringify({ name: "@paddock/server", version, private: true, type: "module" }, null, 2) + "\n",
  "utf8",
);

fs.copyFileSync(
  path.join(repoRoot, "packages/server/scripts/install-notice.mjs"),
  path.join(outDir, "install-notice.mjs"),
);

const manifest = {
  name: "@edspencer/paddock",
  version,
  description:
    "Project-first launchpad for Claude Code: server-hosted, persistent, resumable sessions organized by project.",
  keywords: ["claude", "claude-code", "anthropic", "ai", "agents", "paddock"],
  homepage: "https://github.com/edspencer/paddock#readme",
  bugs: { url: "https://github.com/edspencer/paddock/issues" },
  // Must match, case-sensitively, the repo provenance is generated from.
  repository: { type: "git", url: "git+https://github.com/edspencer/paddock.git" },
  license: serverPkg.license ?? "MIT",
  author: "Ed Spencer",
  type: "module",
  engines: { node: ">=22" },
  bin: { paddock: "packages/server/dist/cli/paddock.js" },
  scripts: { preinstall: "node install-notice.mjs" },
  dependencies: pinnedVersions(lock, serverPkg.dependencies, "packages/server"),
  optionalDependencies: pinnedVersions(lock, serverPkg.optionalDependencies ?? {}, "packages/server"),
  files: ["packages/server/dist", "packages/server/package.json", "packages/web/dist", "install-notice.mjs", "README.md"],
  publishConfig: {
    // Scoped packages default to `restricted`, which needs a paid plan — a
    // publish without this fails with 402.
    access: "public",
    // Explicit even though trusted publishing is documented to imply it:
    // multiple reports of provenance silently not appearing without it.
    provenance: true,
  },
};
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

const readme = path.join(repoRoot, "packages/server/NPM-README.md");
fs.copyFileSync(readme, path.join(outDir, "README.md"));

const size = Number(
  process.env.PADDOCK_SKIP_SIZE
    ? 0
    : execSizeOf(outDir),
);

console.log(`staged @edspencer/paddock@${version} -> ${path.relative(repoRoot, outDir)}`);
console.log(`  server dist: ${server.files} files (${server.mapsSkipped} sourcemaps dropped)`);
console.log(`  web dist:    ${web.files} files (${web.mapsSkipped} sourcemaps dropped)`);
console.log(`  deps pinned: ${Object.keys(manifest.dependencies).length} + ${Object.keys(manifest.optionalDependencies).length} optional`);
if (size) console.log(`  staged size: ${(size / 1024 / 1024).toFixed(1)} MB`);

function execSizeOf(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += fs.statSync(p).size;
    }
  };
  walk(dir);
  return total;
}

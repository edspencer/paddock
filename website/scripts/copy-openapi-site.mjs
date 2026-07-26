#!/usr/bin/env node
/**
 * Copy the standalone Swagger UI reference (`openapi-site/`) into this site's
 * `public/api/`, so the built docs serve it at `<site>/api/`.
 *
 * Astro copies `public/**` to the site root verbatim, and npm runs `prebuild`
 * before `build` — so Cloudflare Pages (root dir `website`, build command
 * `npm install && npm run build`) picks this up with no extra config. The
 * checkout contains the whole repo, so `../openapi-site` is reachable here.
 *
 * `openapi-site/` stays the single source of truth: `public/api/` is a build
 * artifact and is gitignored. Regenerate the spec itself with
 * `npm run build:server && node scripts/dump-openapi.mjs` from the repo root.
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(websiteRoot, "..", "openapi-site");
const dest = path.join(websiteRoot, "public", "api");

if (!existsSync(src)) {
  console.error(`[copy-openapi-site] ${src} not found — is this a full repo checkout?`);
  process.exit(1);
}

// The README documents the source dir for contributors; it is not part of the
// published page.
const skip = new Set(["README.md"]);

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, {
  recursive: true,
  filter: (from) => !skip.has(path.basename(from)),
});
console.error(`[copy-openapi-site] ${src} -> ${dest}`);

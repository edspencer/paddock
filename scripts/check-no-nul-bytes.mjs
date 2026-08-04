#!/usr/bin/env node
/**
 * Guard: reject raw NUL (0x00) bytes in the repo's JS/TS sources.
 *
 * Why this exists (issue #570). A NUL byte is legal inside a JS/TS string
 * literal and is byte-for-byte identical at runtime to the escape sequence for
 * U+0000 — so nothing about the program's behaviour reveals it. What it breaks
 * is tooling: ripgrep and grep classify any file containing a NUL as *binary*
 * and skip it during directory traversal, silently, with exit code 1 —
 * indistinguishable from an honest "no matches". Two such bytes hid 1,249 lines
 * of `packages/server/src` (including `ws.ts`, the busiest file in the server)
 * from every recursive search, which is how they survived a full audit.
 *
 * The byte is also invisible in a diff and in ordinary grep output — a terminal
 * renders nothing, so the line reads as though it contained a plain space.
 * Human review therefore cannot catch this, and neither typecheck nor the test
 * suite notices. Hence a dedicated CI check.
 *
 * The fix is always the same: spell the character as an escape instead of
 * pasting the raw byte. Run `npm run check:nul` locally.
 *
 * Scope (issue #642): the whole repo, not just `packages/`, and `.mjs`/`.js`
 * as well as `.ts`/`.tsx` — the second real occurrence of this bug was a raw
 * NUL in `scripts/demo-gif/seed.mjs`, which the original `packages/` + `.ts`
 * scan never looked at. Data files (`.json`, `.md`) are deliberately NOT
 * scanned: the guard is about *source* staying greppable, and a NUL in a JSON
 * fixture is more likely to be deliberate test data.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOT = ROOT;

/**
 * Directories never worth scanning: dependencies and build output. Matched by
 * name at any depth, so this already covers e.g. `website/dist` and every
 * workspace's `node_modules`.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".vite",
  ".turbo",
  ".git",
]);

const EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".js"]);

/** Recursively collect the sources to check. */
function collect(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...collect(path.join(dir, entry.name)));
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

/**
 * Locate every NUL byte in a buffer, as 1-indexed line/column pairs.
 * Works on the raw bytes: a NUL is ASCII, so byte offsets map to character
 * offsets for the purpose of counting newlines.
 */
function findNulPositions(buf) {
  const hits = [];
  let line = 1;
  let col = 1;
  for (const byte of buf) {
    if (byte === 0) hits.push({ line, col });
    if (byte === 0x0a) {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
  return hits;
}

let scanned = 0;
const offenders = [];

for (const file of collect(SCAN_ROOT).sort()) {
  scanned += 1;
  const buf = readFileSync(file);
  // Fast path: the overwhelming majority of files have no NUL at all.
  if (!buf.includes(0)) continue;
  offenders.push({ file, hits: findNulPositions(buf) });
}

if (offenders.length === 0) {
  console.log(`check:nul — OK, no NUL bytes in ${scanned} JS/TS sources.`);
  process.exit(0);
}

const total = offenders.reduce((n, o) => n + o.hits.length, 0);
console.error(
  `check:nul — FAILED: found ${total} raw NUL byte(s) in ${offenders.length} file(s).\n`,
);
for (const { file, hits } of offenders) {
  for (const { line, col } of hits) {
    console.error(`  ${path.relative(ROOT, file)}:${line}:${col}  raw 0x00 byte`);
  }
}
console.error(
  [
    "",
    "A raw NUL makes ripgrep/grep treat the whole file as binary and skip it",
    "during directory traversal — silently, exit 1, looking exactly like a",
    'truthful "no matches". It is invisible in diffs, so review cannot catch it.',
    "",
    "Fix: replace the raw byte with the six-character escape \\u0000 (backslash,",
    "u, four zeros). That is identical at runtime, greppable, and visible in",
    "review. See issue #570 and the KEY_SEP constants in packages/server/src.",
  ].join("\n"),
);
process.exit(1);

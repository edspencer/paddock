#!/usr/bin/env node
/**
 * make.mjs — the whole pipeline: seed → boot → shoot → encode → install.
 *
 *   npm run demo:gif
 *   node scripts/demo-gif/make.mjs [--out DIR] [--port N] [--skip-shoot]
 *
 * `--skip-shoot` re-encodes the stills from the previous run, which is the fast
 * loop when you are only tuning the timing or the encoder.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const OUT = path.resolve(arg("out", "/tmp/paddock-demo"));

const run = (script, extra = []) =>
  execFileSync(process.execPath, [path.join(HERE, script), "--out", OUT, ...extra], {
    stdio: "inherit",
    // The devbox exports NODE_ENV=production, which prunes the dev deps this
    // pipeline needs (Playwright above all).
    env: { ...process.env, NODE_ENV: undefined },
  });

if (!argv.includes("--skip-shoot")) {
  const port = arg("port", "7311");
  run("shoot.mjs", ["--port", port]);
}
run("build.mjs");

// ── install into the repo ───────────────────────────────────────────────────
// Two copies on purpose: the README reads the docs/ path on GitHub, and the
// Astro site serves its own public/ tree. They must stay byte-identical.
const dist = path.join(OUT, "dist");
const targets = [
  ["paddock-demo.gif", "docs/demo/paddock-demo.gif"],
  ["paddock-demo.gif", "website/public/demo/paddock-demo.gif"],
];
for (const [src, rel] of targets) {
  const from = path.join(dist, src);
  const to = path.join(REPO_ROOT, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(`[make] installed ${rel}  (${(fs.statSync(to).size / 1024 / 1024).toFixed(2)} MB)`);
}

console.log(
  [
    "",
    "Done. The MP4/WebM in " + dist + " are NOT copied into the repo —",
    "they are for the marketing site, which can use a <video> element.",
    "",
  ].join("\n"),
);

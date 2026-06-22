#!/usr/bin/env node
/**
 * E2E server launcher.
 *
 * Boots the REAL built paddock server (packages/server/dist/index.js) serving
 * the REAL built web SPA (packages/web/dist), against a throwaway temp data dir
 * + HOME, with the fake `claude` first on PATH so NO Anthropic calls happen.
 * Playwright's `webServer` runs this and waits for the port.
 *
 * Live mode: set PADDOCK_TEST_LIVE=1 to use the REAL claude + the Max OAuth
 * token (CLAUDE_CODE_OAUTH_TOKEN). Default is the fake. Do NOT run live in CI.
 *
 * The temp dir path is written to PADDOCK_E2E_TMP (passed by the config) so the
 * harness can clean it up; if absent we create one under the OS temp root.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const fakeBin = path.join(repoRoot, "test", "bin");
const serverEntry = path.join(repoRoot, "packages", "server", "dist", "index.js");
const webDist = path.join(repoRoot, "packages", "web", "dist");

const live = process.env.PADDOCK_TEST_LIVE === "1";
const port = process.env.PADDOCK_E2E_PORT || "4317";

const tmp = process.env.PADDOCK_E2E_TMP || mkdtempSync(path.join(os.tmpdir(), "paddock-e2e-"));
const home = path.join(tmp, "home");
const dataDir = path.join(tmp, "data");
mkdirSync(home, { recursive: true });
mkdirSync(path.join(dataDir, "projects"), { recursive: true });

const env = {
  ...process.env,
  HOME: home,
  PORT: port,
  HOST: "127.0.0.1",
  PADDOCK_DATA_DIR: dataDir,
  PADDOCK_PROJECTS_DIR: path.join(dataDir, "projects"),
  PADDOCK_WEB_DIST: webDist,
  LOG_LEVEL: process.env.LOG_LEVEL || "warn",
};
delete env.CLAUDE_HOME; // fall back to $HOME/.claude (matches the CLI runtime)

if (live) {
  // Live: keep the real claude on PATH, require the Max token.
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.error("PADDOCK_TEST_LIVE=1 but CLAUDE_CODE_OAUTH_TOKEN is not set");
    process.exit(1);
  }
  // In live mode we deliberately use the real ~/.claude (not the temp home) so
  // the authenticated CLI works; restore HOME.
  env.HOME = process.env.HOME;
} else {
  // Fake: prepend our stub `claude`.
  env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
}

const child = spawn("node", [serverEntry], { env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}

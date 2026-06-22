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
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
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
const projectsDir = path.join(dataDir, "projects");
mkdirSync(home, { recursive: true });
mkdirSync(projectsDir, { recursive: true });

// ── Additive harness extensions (for journey-*.spec.ts seeding) ─────────────
// Optionally make the projects root a git repo so the Changes/git UI lights up.
// Gated by PADDOCK_E2E_GIT=1 so the default server keeps its non-repo behavior
// (the comprehensive suite runs a second, git-enabled Playwright project).
if (process.env.PADDOCK_E2E_GIT === "1") {
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "E2E",
    GIT_AUTHOR_EMAIL: "e2e@example.com",
    GIT_COMMITTER_NAME: "E2E",
    GIT_COMMITTER_EMAIL: "e2e@example.com",
  };
  const g = (args) => execFileSync("git", args, { cwd: projectsDir, env: gitEnv, stdio: "ignore" });
  g(["init", "-b", "main"]);
  g(["config", "user.email", "e2e@example.com"]);
  g(["config", "user.name", "E2E"]);
  writeFileSync(path.join(projectsDir, ".gitkeep"), "");
  g(["add", "-A"]);
  g(["commit", "-m", "init"]);
}

// Expose the CANONICAL (realpath-resolved) data/projects paths so specs can seed
// state on disk (projects, files, git changes). The server canonicalizes these
// paths internally (macOS /var -> /private/var), so specs must use the resolved
// form to write where the server reads. Written once at boot to PADDOCK_E2E_TMP.
try {
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  writeFileSync(
    path.join(tmp, "paddock-e2e-paths.json"),
    JSON.stringify(
      {
        tmp: real(tmp),
        dataDir: real(dataDir),
        projectsDir: real(projectsDir),
        home: real(home),
        git: process.env.PADDOCK_E2E_GIT === "1",
        githubConfigured: !!process.env.PADDOCK_GITHUB_CLIENT_ID,
      },
      null,
      2,
    ),
  );
} catch {
  /* best-effort — specs fall back to deriving the path */
}

const env = {
  ...process.env,
  HOME: home,
  PORT: port,
  HOST: "127.0.0.1",
  PADDOCK_DATA_DIR: dataDir,
  PADDOCK_PROJECTS_DIR: projectsDir,
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

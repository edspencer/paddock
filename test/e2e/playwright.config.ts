import { defineConfig, devices } from "@playwright/test";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";

/**
 * Playwright E2E config. Drives Chromium against the REAL built server + SPA
 * with the fake `claude` (default) or the real claude (PADDOCK_TEST_LIVE=1).
 *
 * The web bundle + server must be BUILT first (`npm run build`); `npm run
 * test:e2e` is expected to be run after a build. Screenshots + traces are
 * captured on failure.
 */
// A per-suite default port (overridable). Distinct from other paddock test
// worktrees' default so concurrent E2E runs don't share a server (with
// reuseExistingServer they would otherwise connect to a FOREIGN server holding
// different data, breaking the data-seeding specs).
const PORT = process.env.PADDOCK_E2E_PORT || "4319";
// One temp dir for the whole run, shared with the launcher so state is isolated.
const TMP =
  process.env.PADDOCK_E2E_TMP || mkdtempSync(path.join(os.tmpdir(), "paddock-e2e-"));
process.env.PADDOCK_E2E_TMP = TMP;

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [["list"], ["html", { open: "never", outputFolder: path.join(TMP, "report") }]],
  outputDir: path.join(TMP, "test-results"),
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node test/e2e/server.mjs",
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), "../.."),
    url: `http://127.0.0.1:${PORT}/api/health`,
    timeout: 60_000,
    // Never reuse a server already on the port: with a shared default port a
    // stale/foreign server (e.g. another worktree's run) would be reused and
    // serve different data, breaking the data-seeding specs. Always boot a
    // fresh, isolated server for this run.
    reuseExistingServer: false,
    env: {
      PADDOCK_E2E_PORT: PORT,
      PADDOCK_E2E_TMP: TMP,
      PADDOCK_TEST_LIVE: process.env.PADDOCK_TEST_LIVE ?? "",
      // Make the projects store a real git repo so the Changes / commit / push
      // UI lights up end-to-end. Override to "0" to exercise the non-repo path.
      PADDOCK_E2E_GIT: process.env.PADDOCK_E2E_GIT ?? "1",
    },
  },
});

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
const PORT = process.env.PADDOCK_E2E_PORT || "4317";
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
    reuseExistingServer: !process.env.CI,
    env: {
      PADDOCK_E2E_PORT: PORT,
      PADDOCK_E2E_TMP: TMP,
      PADDOCK_TEST_LIVE: process.env.PADDOCK_TEST_LIVE ?? "",
    },
  },
});

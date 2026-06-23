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
 *
 * ── Two servers (additive, for the comprehensive journey-* suite) ───────────
 * The default `chromium` project runs against a NON-git server on PORT (the
 * original behavior — happy-path.spec.ts + most journey-*.spec.ts). A second
 * `chromium-git` project runs ONLY `journey-git-*.spec.ts` against a separate,
 * GIT-ENABLED server on PORT+1 with its own temp dir, so the git/Changes UI
 * lights up without changing the default server (the projects-root repo flag is
 * a process-wide cached value, so repo vs. non-repo needs separate servers).
 */
const PORT = process.env.PADDOCK_E2E_PORT || "4317";
const GIT_PORT = String(Number(PORT) + 1);
// One temp dir for the whole run, shared with the launcher so state is isolated.
const TMP =
  process.env.PADDOCK_E2E_TMP || mkdtempSync(path.join(os.tmpdir(), "paddock-e2e-"));
process.env.PADDOCK_E2E_TMP = TMP;
// A SECOND temp dir for the git-enabled server (kept distinct so its repo + data
// never collide with the default server's). Specs read paddock-e2e-paths.json
// from here (PADDOCK_E2E_GIT_TMP) to seed on-disk state.
const GIT_TMP =
  process.env.PADDOCK_E2E_GIT_TMP || mkdtempSync(path.join(os.tmpdir(), "paddock-e2e-git-"));
process.env.PADDOCK_E2E_GIT_TMP = GIT_TMP;

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  // One retry: the suite shares a single stateful server (workers:1) and some
  // flows depend on async refreshes (herdctl's session-discovery cache, the
  // projects-context re-fetch), so a rare timing blip shouldn't fail the run. A
  // genuinely-broken assertion still fails both attempts. (Additive vs. the
  // original retries:0 — see the comprehensive journey-* suite.)
  retries: 1,
  timeout: 60_000,
  reporter: [["list"], ["html", { open: "never", outputFolder: path.join(TMP, "report") }]],
  outputDir: path.join(TMP, "test-results"),
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: [
        "**/journey-git-*.spec.ts",
        "**/journey-mobile.spec.ts",
        "**/journey-mobile-git.spec.ts",
      ],
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${PORT}` },
    },
    {
      name: "chromium-git",
      testMatch: "**/journey-git-*.spec.ts",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${GIT_PORT}` },
    },
    {
      // Phone-sized run (Pixel 5 = 393×851, isMobile + hasTouch, Chromium-based,
      // so the same `chromium` browser install covers it — no extra browser in
      // CI). Exercises the responsive layout: the hamburger nav drawer + the
      // in-project / one-off session-list drawers, modals, and the file viewer.
      // Same non-git server as `chromium`.
      name: "mobile",
      testMatch: "**/journey-mobile.spec.ts",
      use: { ...devices["Pixel 5"], baseURL: `http://127.0.0.1:${PORT}` },
    },
    {
      // Phone-sized run against the GIT-enabled server, for the Changes/diff tab.
      name: "mobile-git",
      testMatch: "**/journey-mobile-git.spec.ts",
      use: { ...devices["Pixel 5"], baseURL: `http://127.0.0.1:${GIT_PORT}` },
    },
  ],
  webServer: [
    {
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
    {
      command: "node test/e2e/server.mjs",
      cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), "../.."),
      url: `http://127.0.0.1:${GIT_PORT}/api/health`,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      env: {
        PADDOCK_E2E_PORT: GIT_PORT,
        PADDOCK_E2E_TMP: GIT_TMP,
        PADDOCK_E2E_GIT: "1",
        // A dummy client id so the "Connect GitHub" device-flow affordance shows
        // (configured=true). The flow itself is never driven (it'd hit real
        // GitHub); specs only assert the affordance + the seeded "connected"
        // state. See journey-git-github.spec.ts.
        PADDOCK_GITHUB_CLIENT_ID: "Iv1.e2e0000client0id",
        PADDOCK_TEST_LIVE: process.env.PADDOCK_TEST_LIVE ?? "",
      },
    },
  ],
});

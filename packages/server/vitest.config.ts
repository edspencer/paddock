import { defineConfig } from "vitest/config";

// Server tests run in a Node environment. The "unit" suite is pure-logic and
// fast; the "integration" suite boots the real Fastify app + real
// @herdctl/core FleetManager against a temp data dir with the fake `claude`
// first on PATH (see test/bin/claude + test/helpers/app.ts).
export default defineConfig({
  test: {
    name: "server",
    environment: "node",
    globals: true,
    include: ["test/**/*.test.ts"],
    // Integration tests boot a real fleet + spawn a (fake) claude subprocess and
    // wait on a chokidar file watcher, so they need generous timeouts.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Each integration test boots its own server on a temp dir; run files
    // serially to keep PATH / cwd / port assumptions simple and deterministic.
    fileParallelism: false,
    pool: "forks",
  },
});

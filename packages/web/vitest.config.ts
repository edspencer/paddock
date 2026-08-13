import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Mirror vite.config.ts's __APP_VERSION__ define so components that render the
// version don't hit an undefined global under test.
const pkgVersion = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
).version as string;

// Web tests run under jsdom with @testing-library/react. Component tests render
// real components; lib tests are pure logic. No network — fetch is stubbed per
// test (the api client uses global fetch).
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
  },
  test: {
    name: "web",
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./test/setup.ts"],
    css: false,
    // Bound the fork pool to a CONSTANT rather than the machine (#788 class B).
    // With no pool options at all vitest sizes the pool from the CPU count, and
    // each fork carries its own esbuild service child — so the number of
    // processes a run leaves behind grew with whatever box happened to run it,
    // which is how a 96-core CI box and a laptop produce very different
    // residue from the same command. A fixed 4 keeps these tests parallel
    // (unlike the server suite, they are independent and jsdom-isolated) while
    // capping the esbuild population at a small, predictable number.
    // `minForks` must be pinned too. Vitest derives its default from the CPU
    // count, so on any machine with more than 4 cores the default minimum
    // exceeds this maximum and tinypool throws `options.minThreads and
    // options.maxThreads must not conflict` before a single test runs. CI
    // runners are small enough to hide it; a 6-core dev box is not.
    poolOptions: { forks: { minForks: 1, maxForks: 4 } },
  },
});

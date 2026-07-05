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
  },
});

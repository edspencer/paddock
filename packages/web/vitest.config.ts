import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Web tests run under jsdom with @testing-library/react. Component tests render
// real components; lib tests are pure logic. No network — fetch is stubbed per
// test (the api client uses global fetch).
export default defineConfig({
  plugins: [react()],
  test: {
    name: "web",
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./test/setup.ts"],
    css: false,
  },
});

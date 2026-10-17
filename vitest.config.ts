import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": resolve("src/shared"),
      "@renderer": resolve("src/renderer/src"),
    },
  },
  test: {
    environment: "node",
    include: [
      "tests/unit/**/*.test.ts",
      "tests/integration/**/*.test.ts",
      "tests/contract/**/*.test.ts",
    ],
    // Windows git/worktree integration cases can exceed Vitest's 5s default
    // when the full 60+ file suite runs in parallel. Fifteen seconds matches
    // the existing explicit limits without weakening assertions.
    testTimeout: 15_000,
    // Native SQLite and git/worktree setup can exceed Vitest's 10s hook
    // default on a loaded Windows runner even when the test itself is healthy.
    hookTimeout: 30_000,
    // Coverage workers compete with native git/SQLite on the shared Windows
    // host. Bound concurrency instead of weakening timeouts or assertions.
    maxWorkers: 4,
    coverage: {
      reporter: ["text", "html", "json-summary"],
      thresholds: {
        lines: 70,
        functions: 55,
        statements: 64,
        branches: 56,
      },
    },
  },
});

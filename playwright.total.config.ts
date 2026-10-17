import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  // ui-action-*.spec.ts drive the action-coverage matrix. responsive-geometry
  // is an explicitly included regression scenario with a real terminal fixture
  // (dispatch 2026-07-20 §6): it does NOT map to a data-action-id, so it must
  // not be counted as action coverage — it runs alongside the total suite so
  // orientation/scrollLeft regressions surface in the same report.
  testMatch: /ui-action-.*\.spec\.ts|responsive-geometry\.spec\.ts/,
  timeout: 60_000,
  workers: 2, // 4 在本機會讓 Electron 啟動互搶而隨機逾時（每次掛不同的測試）
  expect: {
    timeout: 10_000,
  },
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  reporter: [
    ["list"],
    ["json", { outputFile: ".review/audits/ui-total-playwright.json" }],
  ],
});

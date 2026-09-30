import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "probe.spec.mjs",
  workers: 1,
  retries: 0,
  timeout: 5_000,
  expect: { timeout: 1_000 },
  reporter: "list",
  outputDir: `${process.cwd()}/test-results`,
  snapshotPathTemplate: `${process.cwd()}/.visual/snapshots/desktop/{arg}{ext}`,
  use: { viewport: { width: 80, height: 80 } },
});

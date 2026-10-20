import { resolve } from "node:path";

import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: ".vite",
  test: {
    include: ["probe.test.mjs"],
    retry: 0,
    // Browser code cannot read the environment, so the probes reach it through Vitest's provide.
    provide: { probes: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("PROBE_"))) },
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      viewport: { width: 80, height: 80 },
      expect: {
        toMatchScreenshot: {
          timeout: 1_000,
          resolveScreenshotPath: ({ arg, ext }) =>
            resolve(process.env.PLAYWRIGHT_SNAPSHOT_DIR, "desktop", `${arg}${ext}`),
        },
      },
    },
  },
});

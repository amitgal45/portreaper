import { defineConfig } from "@playwright/test";

/**
 * Browser tests of the UI against the Vite dev server and the mock core (`src/api/mock.ts`):
 * the same path a developer sees with `pnpm dev`. WebKit is the primary project because the
 * Tauri window on macOS is a WKWebView; Chromium is the second opinion.
 *
 * Port 1420 belongs to the app's own dev server (`pnpm tauri dev`). Playwright uses 1430.
 */
const PORT = 1430;
const baseURL = `http://localhost:${PORT}`;

/** The window's default size (tauri.conf.json). */
const viewport = { width: 760, height: 540 };

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    viewport,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "webkit",
      use: { browserName: "webkit" },
      testIgnore: "**/screenshot.spec.ts",
    },
    {
      name: "chromium",
      use: { browserName: "chromium" },
      testIgnore: "**/screenshot.spec.ts",
    },
    // `pnpm screenshot` only: writes docs/screenshot*.png for the README. WebKit at 2×, which is
    // what the app window is on a retina Mac.
    {
      name: "screenshot",
      use: { browserName: "webkit", deviceScaleFactor: 2 },
      testMatch: "**/screenshot.spec.ts",
    },
  ],
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});

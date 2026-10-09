import { expect, test } from "@playwright/test";
import { open, row, toasts } from "./helpers";

/**
 * The seam these tests do not reach: `invoke`, the tray, the shortcut, close-to-hide. There is no
 * Tauri in a browser tab, so the UI must notice and stay quiet. This test documents that; the real
 * window is checked by a human at WP-6.
 */
test("without Tauri the tray listener is a no-op and the page does not throw", async ({ page }) => {
  const thrown: string[] = [];
  const logged: string[] = [];
  page.on("pageerror", (err) => thrown.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") logged.push(msg.text());
  });

  await open(page);

  // `isTauri()` in src/api/index.ts looks for this; the mock core is in use when it is missing.
  await expect.poll(() => page.evaluate(() => "__TAURI_INTERNALS__" in window)).toBe(false);
  expect(thrown).toEqual([]);
  expect(logged.filter((m) => m.includes("tray:select-port"))).toEqual([]);

  // A row action that needs the core says so instead of failing silently.
  await row(page, 3000).getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Open localhost:3000" }).click();
  await expect(toasts(page)).toContainText("Not available in the browser");
  expect(thrown).toEqual([]);
});

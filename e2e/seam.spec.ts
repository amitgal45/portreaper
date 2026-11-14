import { expect, test } from "@playwright/test";
import {
  confirmDialog,
  eventOfKind,
  inspector,
  MOCK_PORT_COUNT,
  navItem,
  open,
  reapButton,
  row,
  rows,
  toasts,
  updateBanner,
} from "./helpers";

/**
 * The seam these tests do not reach: `invoke`, the tray, the shortcut, the Taskline event,
 * close-to-hide. There is no Tauri in a browser tab, so the UI must notice and stay quiet. This
 * test documents that; the real window is checked by a human at WP-14.
 */
test("without Tauri the listeners are no-ops and the page does not throw", async ({ page }) => {
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
  expect(logged.filter((m) => m.includes("tray:select-port") || m.includes("taskline:event"))).toEqual([]);

  // An inspector action that needs the core says so instead of failing silently.
  await row(page, 3000).click();
  await inspector(page).getByRole("button", { name: "Open localhost:3000" }).click();
  await expect(toasts(page)).toContainText("Not available in the browser");
  expect(thrown).toEqual([]);

  // No release is known without the core (or the seam below), so there is no update banner.
  await expect(updateBanner(page)).toHaveCount(0);
  expect(logged.filter((m) => m.includes("update:"))).toEqual([]);
});

/**
 * The browser-only seam of WP-16: `?update=1` starts the sidebar banner from the mock update, so
 * the banner can be seen without a release. The mock's install resolves after a moment and the
 * banner reads "Restarting…", which is what the real core shows between install and relaunch.
 */
test("`?update=1` shows the update banner; Update walks it through to Restarting…", async ({ page }) => {
  await page.goto("/?update=1");
  await expect(rows(page)).toHaveCount(MOCK_PORT_COUNT);
  const banner = updateBanner(page);
  await expect(banner).toContainText("PortReaper 0.3.0 is ready");
  await expect(banner).toHaveAttribute("data-phase", "available");
  await banner.getByRole("button", { name: "Update" }).click();
  await expect(banner).toHaveAttribute("data-phase", "downloading");
  await expect(banner).toContainText("Restarting…");
  await expect(banner.getByRole("button")).toHaveCount(0);
});

/**
 * The browser-only seam of WP-23: `?stdio=1` adds two portless (`port: 0`, `stdio`) agent/browser
 * zombies (`MCP` + `Playwright`) so `stdio` inspection and bulk reaping are covered end to end.
 */
test("`?stdio=1` shows stdio MCP and Playwright zombies in the board, inspector, and Reap flow", async ({
  page,
}) => {
  await page.goto("/?stdio=1");
  await expect(rows(page)).toHaveCount(MOCK_PORT_COUNT + 2);

  await navItem(page, "zombie").click();
  await expect(rows(page)).toHaveCount(4);

  const stdioRows = row(page, 0);
  await expect(stdioRows).toHaveCount(2);
  await expect(stdioRows.first()).toContainText("stdio");

  await stdioRows.first().click();
  const panel = inspector(page);
  await expect(panel).toContainText("no listening socket (stdio or background worker)");
  await expect(panel).toContainText("[STDIO / NO PORT]");
  await expect(panel.getByRole("button", { name: "Watch" })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Open in browser" })).toBeDisabled();

  await reapButton(page).click();
  await expect(confirmDialog(page)).toContainText("Reap 4 zombies?");
  await confirmDialog(page).getByRole("button", { name: "Reap them" }).click();
  await expect(rows(page)).toHaveCount(0);

  await navItem(page, "taskline").click();
  await expect(eventOfKind(page, "zombieReaped")).toHaveCount(4);
  await expect(eventOfKind(page, "zombieReaped").first()).toContainText("an orphaned background process");
});

import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * The Quick strip (`quick.html`, WP-8b) in a browser against the mock core. The window that
 * hosts it (480×320, always on top, hidden on blur) is WP-8a's and is not here: in a browser
 * `hideCurrentWindow()` is a no-op, so after a kill or Esc the strip simply stays on screen.
 */
test.use({ viewport: { width: 480, height: 320 } });
test.describe.configure({ mode: "parallel" });

/** What an empty query shows: the mock's unprotected entries, newest first (`recents()` in src/quick/match.ts). */
const RECENT_PORTS = [5173, 3000, 8080, 5174, 9335];

const input = (page: Page): Locator => page.getByRole("combobox", { name: "Free a port" });
const options = (page: Page): Locator => page.getByRole("option");
const option = (page: Page, port: number): Locator => page.locator(`[role="option"][data-port="${port}"]`);
const footer = (page: Page): Locator => page.locator("footer");
const shownPorts = (page: Page) =>
  options(page).evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-port"))));

/** Opens the strip and waits for the first poll: the recents, with the caret in the input. */
async function openQuick(page: Page): Promise<void> {
  await page.goto("/quick.html");
  await expect(options(page)).toHaveCount(RECENT_PORTS.length);
  await expect(input(page)).toBeFocused();
}

test("typing 30 selects :3000; Enter frees it, says so, then the strip clears without it", async ({
  page,
}) => {
  await openQuick(page);
  await expect.poll(() => shownPorts(page)).toEqual(RECENT_PORTS);
  await expect(option(page, 5173)).toHaveAttribute("aria-selected", "true");
  await expect(footer(page)).toHaveText("↑↓ choose · ↩ free · ⌥↩ force · esc close");

  await page.keyboard.type("30");
  await expect(input(page)).toHaveValue("30");
  await expect(options(page)).toHaveCount(1);
  const target = option(page, 3000);
  await expect(target).toHaveAttribute("aria-selected", "true");
  await expect(target).toContainText("node");
  await expect(target).toContainText("48213");
  await expect(target).toContainText("shop-api");
  await expect(target).toContainText("feature/cart");
  await expect(target).toContainText("↩ free");

  await page.keyboard.press("Enter");
  await expect(target).toContainText("Freed :3000 · node (48213)");

  // 1.2 s later the strip is done: the query clears and the recents come back without :3000.
  // `hideCurrentWindow()` is a no-op here, so the strip stays and still has the caret.
  await expect(input(page)).toHaveValue("");
  await expect(option(page, 3000)).toHaveCount(0);
  await expect.poll(() => shownPorts(page)).toEqual(RECENT_PORTS.filter((p) => p !== 3000));
  await expect(input(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
});

test("a protected port asks once more; the second Enter frees every port of that pid", async ({ page }) => {
  await openQuick(page);

  await page.keyboard.type("5432");
  const docker = option(page, 5432);
  await expect(options(page)).toHaveCount(1);
  await expect(docker).toHaveAttribute("aria-selected", "true");
  await expect(docker.getByLabel("protected")).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(docker).toContainText("This is Docker (com.docker.backend). Press Enter again to kill it.");
  await expect(docker).toContainText("↩ kill");
  await expect(options(page)).toHaveCount(1);

  await page.keyboard.press("Enter");
  await expect(docker).toContainText("Freed :5432 · com.docker.backend (11710)");
  await expect(input(page)).toHaveValue("");

  // The same pid held :6379 in the mock; the core took both.
  await page.keyboard.type("6379");
  await expect(page.getByText("Nothing on :6379", { exact: true })).toBeVisible();
  await expect(options(page)).toHaveCount(0);
});

test("Esc clears a query; on an empty query it is a no-op in the browser and the strip stays", async ({
  page,
}) => {
  const thrown: string[] = [];
  page.on("pageerror", (err) => thrown.push(err.message));
  await openQuick(page);

  // `vite` is in two command lines (portreaper and tinyrecipe-lp).
  await page.keyboard.type("vite");
  await expect.poll(() => shownPorts(page)).toEqual([5173, 5174]);
  await page.keyboard.press("Escape");
  await expect(input(page)).toHaveValue("");
  await expect(options(page)).toHaveCount(RECENT_PORTS.length);

  // Nothing to hide without Tauri: the strip is still there and still takes keys.
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => "__TAURI_INTERNALS__" in window)).toBe(false);
  await expect(input(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
  await expect(options(page)).toHaveCount(RECENT_PORTS.length);
  await page.keyboard.press("ArrowDown");
  await expect(option(page, 3000)).toHaveAttribute("aria-selected", "true");
  expect(thrown).toEqual([]);
});

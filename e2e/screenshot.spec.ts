import { expect, test } from "@playwright/test";
import { drawer, open, row, rows } from "./helpers";

/**
 * Not part of `pnpm e2e`: only the `screenshot` project runs this file (`pnpm screenshot`), on
 * WebKit at 2×, which is what the Tauri window is on a retina Mac. Mock data, 760×540. The app
 * is dark only since v0.2: `screenshot.png` is the Studio with a row selected,
 * `screenshot-dark.png` the same window with the drawer open.
 */
test("the Studio → docs/screenshot.png", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page);
  // One row selected, so the selection ring and the kill affordance are in the picture.
  await page.keyboard.press("ArrowDown");
  await expect(rows(page).first()).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: "docs/screenshot.png" });
});

test("the drawer → docs/screenshot-dark.png", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page);
  await row(page, 3000).click();
  await expect(drawer(page)).toContainText("[LISTENING ON :3000]");
  await page.screenshot({ path: "docs/screenshot-dark.png" });
});

// The Quick strip (WP-8b) at its window size, 480×320: the recents on an empty query, the first
// row selected so the "↩ free" hint is in the picture. WP-12 restyles it; the files are theirs.
test.describe("quick", () => {
  test.use({ viewport: { width: 480, height: 320 } });

  const quickShots = [
    { scheme: "light", path: "docs/screenshot-quick.png" },
    { scheme: "dark", path: "docs/screenshot-quick-dark.png" },
  ] as const;

  for (const { scheme, path } of quickShots) {
    test(`${scheme} → ${path}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/quick.html");
      const options = page.getByRole("option");
      await expect(options).toHaveCount(5);
      await expect(options.first()).toHaveAttribute("aria-selected", "true");
      await page.screenshot({ path });
    });
  }
});

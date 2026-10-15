import { expect, test } from "@playwright/test";
import { inspector, open, row } from "./helpers";

/**
 * Not part of `pnpm e2e`: only the `screenshot` project runs this file (`pnpm screenshot`), on
 * WebKit at 2×, which is what the Tauri window is on a retina Mac. Mock data, 900×600. The Board
 * follows the system scheme: `screenshot.png` is the Studio in light with the inspector open on
 * :3000, `screenshot-dark.png` the same window in dark.
 */
const boardShots = [
  { scheme: "light", path: "docs/screenshot.png" },
  { scheme: "dark", path: "docs/screenshot-dark.png" },
] as const;

for (const { scheme, path } of boardShots) {
  test(`the Board, ${scheme} → ${path}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await open(page);
    // The first dev server selected and inspected: the selection bar, the filled Kill and the
    // inspector column are in the picture.
    await row(page, 3000).click();
    await expect(inspector(page)).toContainText("[LISTENING ON :3000]");
    await page.screenshot({ path });
  });
}

// The Quick strip (WP-8b, WP-12, on the Board tokens since WP-15b) at its window size, 480×320:
// the pre-selection on an empty query with the two lost-terminal zombies first, the newer
// selected, so the ⚡, the Zombie pill, the brand marks and the "↩ free" hint are in the picture,
// then the dev servers newest first. The tokens follow the system scheme, so one file per scheme.
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
      await expect(options.first()).toHaveAttribute("data-port", "5174");
      await expect(options.first()).toHaveAttribute("aria-selected", "true");
      await expect(options.nth(1)).toHaveAttribute("data-port", "4000");
      await expect(options).toHaveCount(6);
      await page.screenshot({ path });
    });
  }
});

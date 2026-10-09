import { expect, test } from "@playwright/test";
import { open, rows } from "./helpers";

/**
 * Not part of `pnpm e2e`: only the `screenshot` project runs this file (`pnpm screenshot`), on
 * WebKit at 2×, which is what the Tauri window is on a retina Mac. Mock data, 760×540.
 */
const shots = [
  { scheme: "light", path: "docs/screenshot.png" },
  { scheme: "dark", path: "docs/screenshot-dark.png" },
] as const;

for (const { scheme, path } of shots) {
  test(`${scheme} → ${path}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await open(page);
    // One row selected, so the kill affordance is in the picture.
    await page.keyboard.press("ArrowDown");
    await expect(rows(page).first()).toHaveAttribute("aria-selected", "true");
    await page.screenshot({ path });
  });
}

// The Quick strip (WP-8b) at its window size, 480×320: the recents on an empty query, the first
// row selected so the "↩ free" hint is in the picture.
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

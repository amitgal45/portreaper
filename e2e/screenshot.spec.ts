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

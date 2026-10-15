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

// The Quick strip (WP-8b, WP-12) at its window size, 480×320: the pre-selection on an empty
// query with the lost-terminal zombie first and selected, so the ⚡ and the "↩ free" hint are
// in the picture, and `?fixture=ai` for an Ollama row with its memory chip. v0.2 is dark only:
// both schemes render the same; both files stay so links to either keep working.
test.describe("quick", () => {
  test.use({ viewport: { width: 480, height: 320 } });

  const quickShots = [
    { scheme: "light", path: "docs/screenshot-quick.png" },
    { scheme: "dark", path: "docs/screenshot-quick-dark.png" },
  ] as const;

  for (const { scheme, path } of quickShots) {
    test(`${scheme} → ${path}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/quick.html?fixture=ai");
      const options = page.getByRole("option");
      await expect(options.first()).toHaveAttribute("data-port", "5174");
      await expect(options.first()).toHaveAttribute("aria-selected", "true");
      await expect(page.locator('[role="option"][data-port="11434"]')).toBeVisible();
      await page.screenshot({ path });
    });
  }
});

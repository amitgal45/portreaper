import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  inspector,
  killButton,
  MOCK_PORT_COUNT,
  moreButton,
  navItem,
  open,
  row,
  rows,
  shownPorts,
} from "./helpers";

/**
 * Watch a port (WP-18) over the mock core. The mock emits no `watch:changed`, so the state the
 * UI shows comes from the live list: a killed pid frees its port, which is what the sidebar's
 * Watching count and the free rows react to. The notification itself is the real app's to prove.
 */
test.describe.configure({ mode: "parallel" });

/** The count on the sidebar's Watching row: watched ports that are free. */
const watchingBadge = (page: Page): Locator => navItem(page, "watching").locator("span").last();
/** A watched port nothing holds, under the `watching` filter. */
const freeRow = (page: Page, port: number): Locator =>
  page.locator(`[role="row"][data-watch="free"][data-port="${port}"]`);
const eyeMark = (r: Locator): Locator => r.locator("[data-badge='watched']");

test("Watch from the row menu marks the row; a kill makes it something to act on; Stop watching clears it", async ({
  page,
}) => {
  await open(page);
  await expect(watchingBadge(page)).toHaveText("0");
  await expect(eyeMark(row(page, 3000))).toHaveCount(0);

  await moreButton(row(page, 3000)).click();
  const menu = page.getByRole("menu");
  await menu.getByRole("menuitem", { name: "Watch :3000" }).click();
  await expect(menu).toHaveCount(0);
  await expect(eyeMark(row(page, 3000))).toBeVisible();
  // Still listening: nothing to act on yet, and the row keeps its pill.
  await expect(watchingBadge(page)).toHaveText("0");
  await expect(row(page, 3000).locator("[data-badge='running']")).toHaveText("Running");
  await moreButton(row(page, 3000)).click();
  await expect(menu.getByRole("menuitem", { name: "Stop watching :3000" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // The filter shows the watched port as its row while it listens.
  await navItem(page, "watching").click();
  await expect.poll(() => shownPorts(page)).toEqual([3000]);
  await expect(freeRow(page, 3000)).toHaveCount(0);
  await navItem(page, "all").click();
  await expect(rows(page)).toHaveCount(MOCK_PORT_COUNT);

  await killButton(row(page, 3000)).click();
  await expect(row(page, 3000)).toHaveCount(0);
  await expect(watchingBadge(page)).toHaveText("1");

  await navItem(page, "watching").click();
  const free = freeRow(page, 3000);
  await expect(free).toBeVisible();
  await expect(free).toContainText("3000");
  await expect(free).toContainText("— free —");
  await expect(free).toContainText("was node");
  await expect(eyeMark(free)).toBeVisible();
  await expect(free.getByRole("button", { name: "Kill" })).toHaveCount(0);
  await expect(rows(page)).toHaveCount(1);

  await free.getByRole("button", { name: "Stop watching" }).click();
  await expect(free).toHaveCount(0);
  await expect(watchingBadge(page)).toHaveText("0");
  await expect(page.getByText("No watched ports.")).toBeVisible();
});

test("the inspector's eye toggles the same watch", async ({ page }) => {
  await open(page);
  await row(page, 5173).click();
  const panel = inspector(page);
  const eye = panel.getByRole("button", { name: "Watch" });
  await expect(eye).toHaveAttribute("aria-pressed", "false");
  await expect(panel.locator("[data-watching]")).toHaveCount(0);

  await eye.click();
  await expect(eye).toHaveAttribute("aria-pressed", "true");
  await expect(panel.locator("[data-watching]")).toHaveText("Watching · will notify when free");
  await expect(eyeMark(row(page, 5173))).toBeVisible();
  await expect(watchingBadge(page)).toHaveText("0");
  await moreButton(row(page, 5173)).click();
  await expect(page.getByRole("menu").getByRole("menuitem", { name: "Stop watching :5173" })).toBeVisible();
  await page.keyboard.press("Escape");

  await eye.click();
  await expect(eye).toHaveAttribute("aria-pressed", "false");
  await expect(panel.locator("[data-watching]")).toHaveCount(0);
  await expect(eyeMark(row(page, 5173))).toHaveCount(0);
});

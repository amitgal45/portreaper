import { expect, test } from "@playwright/test";
import { group, MOCK_PORT_COUNT, open, row, rows, search, statusLine } from "./helpers";

test.describe.configure({ mode: "parallel" });

test("loads the mock and groups it by project, dev servers first", async ({ page }) => {
  await open(page);

  // shop-api: one port, on feature/cart, run by next. The header carries branch and tool.
  const shopApi = group(page, "p:shop-api");
  const header = shopApi.getByRole("button", { name: /shop-api/ });
  await expect(header).toContainText("feature/cart");
  await expect(header).toContainText("next");
  await expect(shopApi.getByRole("row")).toHaveCount(1);
  await expect(row(page, 3000)).toContainText("48213");

  // The count lives in the status line only; the title strip carries the search box and nothing else.
  await expect(statusLine(page)).toContainText(`${MOCK_PORT_COUNT} ports · 6 projects`);
  await expect(page.locator("header")).not.toContainText("port");
  // No scaffold leftovers: the page is titled like the app (only a browser tab shows it).
  await expect(page).toHaveTitle("PortReaper");

  // Projects with dev servers first (by port), then processes without a project, then the
  // protected groups: see `groupEntries()` in src/composables/usePorts.ts.
  await expect
    .poll(() =>
      page
        .locator("section[data-group]")
        .evaluateAll((els) => els.map((el) => el.getAttribute("data-group"))),
    )
    .toEqual([
      "p:shop-api",
      "p:portreaper",
      "p:tinyrecipe-lp",
      "p:@specmate/api",
      "n:chrome-helper",
      "n:mDNSResponder",
      "p:postgres:16",
      "p:redis:7",
      "n:ControlCenter",
    ]);
});

test("a digit typed on the page starts a search; Esc clears it; a name finds the orphan", async ({
  page,
}) => {
  await open(page);
  const input = search(page);

  // The search box takes focus on load; the shortcut is for when it does not have it.
  await input.blur();
  await expect(input).not.toBeFocused();

  await page.keyboard.press("3");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("3");
  await page.keyboard.press("0");
  await expect(input).toHaveValue("30");
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, 3000)).toBeVisible();
  await expect(statusLine(page)).toContainText(`1 of ${MOCK_PORT_COUNT} ports`);

  await page.keyboard.press("Escape");
  await expect(input).toHaveValue("");
  await expect(rows(page)).toHaveCount(MOCK_PORT_COUNT);

  await input.fill("tinyrecipe");
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, 5174)).toBeVisible();
  await expect(group(page, "p:tinyrecipe-lp")).toBeVisible();
});

test("badges: an exposed port and a dev server that lost its terminal", async ({ page }) => {
  await open(page);

  await expect(row(page, 8080).getByText("exposed", { exact: true })).toBeVisible();
  await expect(row(page, 5174).getByText("lost its terminal", { exact: true })).toBeVisible();

  // The loopback dev server has neither.
  const local = row(page, 3000);
  await expect(local.getByText("local", { exact: true })).toBeVisible();
  await expect(local.getByText("exposed", { exact: true })).toHaveCount(0);
  await expect(local.getByText("lost its terminal", { exact: true })).toHaveCount(0);
});

import { expect, test } from "@playwright/test";
import {
  frameworkIcon,
  group,
  MOCK_PORT_COUNT,
  MOCK_PROJECT_COUNT,
  navItem,
  open,
  row,
  rows,
  search,
  statusLine,
  tile,
} from "./helpers";

test.describe.configure({ mode: "parallel" });

test("loads the mock and groups it by project, dev servers first", async ({ page }) => {
  await open(page);

  // shop-api: one port, on feature/cart. The group row carries the branch; the row the brand mark.
  const shopApi = group(page, "p:shop-api");
  const header = shopApi.getByRole("button", { name: /shop-api/ });
  await expect(header).toContainText("feature/cart");
  await expect(shopApi.getByRole("row")).toHaveCount(1);
  await expect(row(page, 3000)).toContainText("48213");
  await expect(frameworkIcon(row(page, 3000))).toHaveAttribute("data-brand", "Next.js");

  // The counts in the sidebar, the full line in the status line, the cards under the toolbar.
  await expect(navItem(page, "all")).toContainText(`${MOCK_PORT_COUNT}`);
  await expect(navItem(page, "all")).toHaveAttribute("aria-current", "true");
  await expect(navItem(page, "dev")).toContainText("5");
  await expect(navItem(page, "zombie")).toContainText("2");
  await expect(navItem(page, "public")).toContainText("3");
  await expect(statusLine(page)).toContainText(`${MOCK_PORT_COUNT} ports · ${MOCK_PROJECT_COUNT} projects`);
  await expect(statusLine(page)).toContainText(/scan \d+ ms/);
  await expect(tile(page, "ports")).toContainText(`${MOCK_PROJECT_COUNT} projects`);
  await expect(tile(page, "memory")).toContainText("6.6 GB");
  await expect(tile(page, "zombies")).toContainText("zombies · 640 MB");
  await expect(tile(page, "public")).toContainText("public on your Wi-Fi");
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
      "p:legacy-docs",
      "p:portreaper",
      "p:tinyrecipe-lp",
      "p:@specmate/api",
      "n:chrome-helper",
      "n:ollama",
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

test("status pills: Running, Zombie, Public, Protected, AI with its memory; brand marks for known stacks", async ({
  page,
}) => {
  await open(page);

  await expect(row(page, 3000).locator("[data-badge='running']")).toHaveText("Running");
  await expect(row(page, 5174).locator("[data-badge='zombie']")).toHaveText("Zombie");
  await expect(row(page, 8080).locator("[data-badge='public']")).toHaveText("Public");
  await expect(row(page, 5432).locator("[data-badge='public']")).toHaveText("Public");
  await expect(row(page, 5432).locator("[data-badge='protected']")).toHaveText("Protected");
  await expect(row(page, 11434).locator("[data-badge='ai']")).toHaveText("AI · 4.9 GB");
  // A system daemon on every interface is protected, not "public" (the filter agrees).
  await expect(row(page, 53).locator("[data-badge='protected']")).toHaveText("Protected");
  await expect(row(page, 53).locator("[data-badge='public']")).toHaveCount(0);

  // The loopback dev server has none of the alarms.
  const local = row(page, 3000);
  await expect(local.locator("[data-badge='public']")).toHaveCount(0);
  await expect(local.locator("[data-badge='zombie']")).toHaveCount(0);
  await expect(local.locator("[data-badge='protected']")).toHaveCount(0);

  // The brand marks, by framework first, then by process; none for an unknown stack.
  await expect(frameworkIcon(row(page, 5173))).toHaveAttribute("data-brand", "Vite");
  await expect(frameworkIcon(row(page, 8080))).toHaveAttribute("data-brand", "NestJS");
  await expect(frameworkIcon(row(page, 5432))).toHaveAttribute("data-brand", "PostgreSQL");
  await expect(frameworkIcon(row(page, 4000))).toHaveAttribute("data-brand", "Jekyll");
  await expect(frameworkIcon(row(page, 11434))).toHaveAttribute("data-brand", "Ollama");
  await expect(frameworkIcon(row(page, 9335))).toHaveCount(0);
  await expect(row(page, 9335).locator("[data-badge='framework']")).toHaveCount(0);
});

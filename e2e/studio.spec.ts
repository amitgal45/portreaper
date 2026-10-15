import { expect, test } from "@playwright/test";
import {
  confirmDialog,
  eventOfKind,
  events,
  feed,
  inspector,
  killButton,
  MOCK_PORT_COUNT,
  moreButton,
  navItem,
  open,
  reapButton,
  row,
  rows,
  shownPorts,
  statusLine,
  tasklineBadge,
  tile,
  toasts,
} from "./helpers";

/** The Board's surfaces: the sidebar and the cards, Reap, the inspector, Restart, the Taskline. */
test.describe.configure({ mode: "parallel" });

test("the sidebar filters the list; the cards do too; Esc goes back to All ports", async ({ page }) => {
  await open(page);

  await navItem(page, "db").click();
  await expect.poll(() => shownPorts(page)).toEqual([5432, 6379]);
  await expect(navItem(page, "db")).toHaveAttribute("aria-current", "true");
  await expect(navItem(page, "all")).not.toHaveAttribute("aria-current", "true");
  await expect(statusLine(page)).toContainText(`2 of ${MOCK_PORT_COUNT} ports`);

  await navItem(page, "ai").click();
  await expect.poll(() => shownPorts(page)).toEqual([11434]);

  await navItem(page, "public").click();
  await expect.poll(() => shownPorts(page)).toEqual([8080, 5432, 6379]);
  await expect(tile(page, "public")).toHaveAttribute("aria-pressed", "true");

  await tile(page, "zombies").click();
  await expect.poll(() => shownPorts(page)).toEqual([4000, 5174]);
  await expect(tile(page, "zombies")).toHaveAttribute("aria-pressed", "true");
  await expect(navItem(page, "zombie")).toHaveAttribute("aria-current", "true");

  // The same card again shows everything; so does Esc from a sidebar filter.
  await tile(page, "zombies").click();
  await expect(rows(page)).toHaveCount(MOCK_PORT_COUNT);
  await navItem(page, "dev").click();
  await expect(rows(page)).toHaveCount(5);
  await page.keyboard.press("Escape");
  await expect(rows(page)).toHaveCount(MOCK_PORT_COUNT);
  await expect(navItem(page, "all")).toHaveAttribute("aria-current", "true");
});

test("Reap takes the zombies; the Taskline shows ZOMBIE REAPED; Relaunch brings the row back", async ({
  page,
}) => {
  await open(page);
  await expect(reapButton(page)).toContainText("Reap 2 zombies");
  await expect(reapButton(page)).toHaveAttribute("title", /640 MB/);

  await reapButton(page).click();
  await expect(row(page, 5174)).toHaveCount(0);
  await expect(row(page, 4000)).toHaveCount(0);
  await expect(rows(page)).toHaveCount(MOCK_PORT_COUNT - 2);
  await expect(toasts(page)).toContainText("Reaped 2 zombies, 640 MB back.");
  await expect(reapButton(page)).toBeDisabled();
  await expect(tile(page, "zombies")).toHaveText(/^0\s*zombies$/);

  await expect(tasklineBadge(page)).toHaveText("2");
  await navItem(page, "taskline").click();
  await expect(navItem(page, "taskline")).toHaveAttribute("aria-current", "true");
  await expect(page.getByText("2 events this session")).toBeVisible();
  await expect(events(page)).toHaveCount(2);
  await expect(eventOfKind(page, "zombieReaped")).toHaveCount(2);
  const reaped = eventOfKind(page, "zombieReaped").filter({ hasText: "port 5174" });
  await expect(reaped).toContainText("ZOMBIE REAPED");
  await expect(reaped).toContainText("Reaped node (39871), a lost-terminal server on port 5174.");
  await expect(reaped).toContainText("RAM: 220 MB · 180 ms · tinyrecipe-lp");
  await expect(reaped.locator("time")).toHaveText(/^\d\d:\d\d:\d\d$/);

  await reaped.getByRole("button", { name: "Relaunch" }).click();
  await expect(eventOfKind(page, "relaunched")).toContainText("RELAUNCHED");
  await expect(reaped.getByRole("button", { name: "Relaunch" })).toHaveCount(0);
  await expect(tasklineBadge(page)).toHaveText("3");
  await expect(toasts(page)).toContainText(/Relaunched node on port 5174 \(new pid \d+\)\./);

  // A category from the Taskline goes back to the Studio.
  await navItem(page, "all").click();
  const back = row(page, 5174);
  await expect(back).toBeVisible();
  await expect(back).not.toHaveAttribute("data-pid", "39871");
  // Relaunched under a living shell: no longer a zombie.
  await expect(back.locator("[data-badge='zombie']")).toHaveCount(0);
  await expect(back.locator("[data-badge='running']")).toHaveText("Running");

  // Clear, in the toolbar, empties the feed and drops the badge.
  await navItem(page, "taskline").click();
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(feed(page)).toContainText("Nothing yet.");
  await expect(tasklineBadge(page)).toHaveCount(0);
});

test("a row click fills the inspector column; ↓ moves it; Esc and ✕ clear it", async ({ page }) => {
  await open(page);
  await expect(inspector(page)).toHaveCount(0);

  await row(page, 3000).click();
  const panel = inspector(page);
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("node");
  await expect(panel).toContainText("Next.js");
  await expect(panel).toContainText("PID 48213 · up 2 h");
  await expect(panel).toContainText("127.0.0.1");
  await expect(panel).toContainText("isolated to this machine");
  await expect(panel).toContainText("shop-api");
  await expect(panel).toContainText("cwd /Users/amit/work/shop-api");
  await expect(panel).toContainText("PID 1 (launchd)");
  await expect(panel).toContainText("└─ PID 948 (iTerm2)");
  await expect(panel).toContainText("└─ PID 48213 (node) [LISTENING ON :3000]");
  await expect(panel).toContainText("node /Users/amit/work/shop-api/node_modules/.bin/next dev");
  await expect(row(page, 3000)).toHaveAttribute("aria-selected", "true");
  // A column, not a dialog: the list stays reachable and the keys stay on.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("ArrowDown");
  await expect(row(page, 4000)).toHaveAttribute("aria-selected", "true");
  await expect(panel).toContainText("[LISTENING ON :4000]");

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page.locator("[role='row'][aria-selected='true']")).toHaveCount(0);

  // A public, protected row says so and blocks Restart; ✕ clears the selection with the panel.
  await row(page, 5432).click();
  await expect(panel).toContainText("com.docker.backend");
  await expect(panel).toContainText("PostgreSQL 16");
  await expect(panel).toContainText("reachable from your network");
  await expect(panel.getByRole("button", { name: "Restart" })).toBeDisabled();
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toHaveCount(0);
  await expect(row(page, 5432)).toHaveAttribute("aria-selected", "false");
});

test.describe("in a narrow window", () => {
  test.use({ viewport: { width: 760, height: 520 } });

  test("the inspector is a slide-over: a click opens it, ↓ does not, Esc closes it", async ({ page }) => {
    await open(page);
    await page.keyboard.press("ArrowDown");
    await expect(row(page, 3000)).toHaveAttribute("aria-selected", "true");
    await expect(inspector(page)).toHaveCount(0);

    await row(page, 3000).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("[data-inspector]")).toContainText("[LISTENING ON :3000]");

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(inspector(page)).toHaveCount(0);
    // Closing the slide-over leaves the selection alone.
    await expect(row(page, 3000)).toHaveAttribute("aria-selected", "true");
  });
});

test("Restart from the inspector produces RELAUNCHED and the row comes back with a new pid", async ({
  page,
}) => {
  await open(page);
  await row(page, 5173).click();
  const panel = inspector(page);
  await panel.getByRole("button", { name: "Restart" }).click();

  await expect(panel.locator("[data-restart-status]")).toHaveText(/^Back on :5173 as pid \d+\.$/);
  const status = await panel.locator("[data-restart-status]").textContent();
  const newPid = (status ?? "").match(/pid (\d+)/)?.[1];
  expect(newPid).toBeDefined();
  expect(newPid).not.toBe("51022");
  await expect(panel).toContainText(`PID ${newPid}`);
  await expect(toasts(page)).toContainText("Killed node (51022). Port 5173 is free.");
  await expect(toasts(page)).toContainText(`Relaunched node on port 5173 (new pid ${newPid}).`);

  const back = row(page, 5173);
  await expect(back).toHaveAttribute("data-pid", newPid as string);
  await expect(back).toHaveAttribute("aria-selected", "true");
  await expect(rows(page)).toHaveCount(MOCK_PORT_COUNT);

  await navItem(page, "taskline").click();
  await expect(events(page)).toHaveCount(2);
  await expect(events(page).nth(0)).toContainText("RELAUNCHED");
  await expect(events(page).nth(1)).toContainText("PORT FREED");
  await expect(tasklineBadge(page)).toHaveText("2");
});

test("Kill from the inspector goes through the gate; the column moves on once the row is gone", async ({
  page,
}) => {
  await open(page);
  await row(page, 5432).click();
  const panel = inspector(page);
  await killButton(panel).click();
  const dialog = confirmDialog(page);
  await expect(dialog).toContainText("Kill com.docker.backend (11710)?");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel).toContainText("com.docker.backend");

  await killButton(panel).click();
  await dialog.getByRole("button", { name: "Kill anyway" }).click();
  await expect(rows(page)).toHaveCount(MOCK_PORT_COUNT - 2);
  await expect(toasts(page)).toContainText("Ports 5432 and 6379 are free.");
  // The selection slid to the neighbour, and the column with it.
  await expect(panel).not.toContainText("com.docker.backend");
  await expect(panel).toContainText("ControlCenter");
  await expect(row(page, 7000)).toHaveAttribute("aria-selected", "true");
});

test("the row menu: Inspect, Open localhost, the copies, Reveal folder, Force kill", async ({ page }) => {
  await open(page);
  await moreButton(row(page, 3000)).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Inspect",
    "Open localhost:3000",
    "Copy kill -9 48213",
    "Copy command",
    "Reveal folder",
    /Force kill/,
  ]);
  // Opening the menu did not select the row.
  await expect(inspector(page)).toHaveCount(0);

  await menu.getByRole("menuitem", { name: "Open localhost:3000" }).click();
  await expect(menu).toHaveCount(0);
  await expect(toasts(page)).toContainText("Not available in the browser");

  await moreButton(row(page, 3000)).click();
  await menu.getByRole("menuitem", { name: "Inspect" }).click();
  await expect(inspector(page)).toContainText("[LISTENING ON :3000]");

  // A udp port has nothing to open in a browser.
  await moreButton(row(page, 53)).click();
  await expect(menu.getByRole("menuitem", { name: "Open localhost:53" })).toHaveAttribute(
    "data-disabled",
    "",
  );
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

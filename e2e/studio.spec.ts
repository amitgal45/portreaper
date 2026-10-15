import { expect, test } from "@playwright/test";
import {
  confirmDialog,
  drawer,
  eventOfKind,
  events,
  feed,
  killButton,
  MOCK_PORT_COUNT,
  open,
  pill,
  reapButton,
  row,
  rows,
  shownPorts,
  statusLine,
  tab,
  tasklineBadge,
  tile,
  toasts,
} from "./helpers";

/** The v0.2 surfaces: pills and tiles, Reap, the drawer, Restart, the Taskline. */
test.describe.configure({ mode: "parallel" });

test("the pills filter the list; the Zombies tile does too; Esc goes back to All", async ({ page }) => {
  await open(page);

  await pill(page, "db").click();
  await expect.poll(() => shownPorts(page)).toEqual([5432, 6379]);
  await expect(pill(page, "db")).toHaveAttribute("aria-pressed", "true");
  await expect(statusLine(page)).toContainText(`2 of ${MOCK_PORT_COUNT} ports`);

  await pill(page, "ai").click();
  await expect.poll(() => shownPorts(page)).toEqual([11434]);

  await pill(page, "public").click();
  await expect.poll(() => shownPorts(page)).toEqual([8080, 5432, 6379]);
  await expect(tile(page, "public")).toHaveAttribute("aria-pressed", "true");

  await tile(page, "zombies").click();
  await expect.poll(() => shownPorts(page)).toEqual([5174]);
  await expect(tile(page, "zombies")).toHaveAttribute("aria-pressed", "true");
  await expect(pill(page, "zombie")).toHaveAttribute("aria-pressed", "true");

  // The same tile again shows everything; so does Esc from a pill.
  await tile(page, "zombies").click();
  await expect(rows(page)).toHaveCount(MOCK_PORT_COUNT);
  await pill(page, "dev").click();
  await expect(rows(page)).toHaveCount(5);
  await page.keyboard.press("Escape");
  await expect(rows(page)).toHaveCount(MOCK_PORT_COUNT);
  await expect(pill(page, "all")).toHaveAttribute("aria-pressed", "true");
});

test("Reap takes the zombies; the Taskline shows ZOMBIE REAPED; Relaunch brings the row back", async ({
  page,
}) => {
  await open(page);
  await expect(reapButton(page)).toContainText("Reap 1 zombie");
  await expect(reapButton(page)).toContainText("220 MB");

  await reapButton(page).click();
  await expect(row(page, 5174)).toHaveCount(0);
  await expect(rows(page)).toHaveCount(MOCK_PORT_COUNT - 1);
  await expect(toasts(page)).toContainText("Reaped 1 zombie, 220 MB back.");
  await expect(reapButton(page)).toBeDisabled();
  await expect(tile(page, "zombies")).toContainText("lost terminals");

  await expect(tasklineBadge(page)).toHaveText("1");
  await tab(page, "Taskline").click();
  await expect(events(page)).toHaveCount(1);
  const reaped = eventOfKind(page, "zombieReaped");
  await expect(reaped).toContainText("ZOMBIE REAPED");
  await expect(reaped).toContainText("Reaped node (39871), a lost-terminal server on port 5174.");
  await expect(reaped).toContainText("RAM: 220 MB · 180 ms · tinyrecipe-lp");
  await expect(reaped.locator("time")).toHaveText(/^\d\d:\d\d:\d\d$/);

  await reaped.getByRole("button", { name: "Relaunch" }).click();
  await expect(eventOfKind(page, "relaunched")).toContainText("RELAUNCHED");
  await expect(reaped.getByRole("button", { name: "Relaunch" })).toHaveCount(0);
  await expect(tasklineBadge(page)).toHaveText("2");
  await expect(toasts(page)).toContainText(/Relaunched node on port 5174 \(new pid \d+\)\./);

  await tab(page, "Studio").click();
  const back = row(page, 5174);
  await expect(back).toBeVisible();
  await expect(back).not.toHaveAttribute("data-pid", "39871");
  // Relaunched under a living shell: no longer a zombie.
  await expect(back.locator("[data-badge='zombie']")).toHaveCount(0);

  // Clear empties the feed and drops the badge.
  await tab(page, "Taskline").click();
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(feed(page)).toContainText("Nothing yet.");
  await expect(tasklineBadge(page)).toHaveCount(0);
});

test("a row click opens the drawer with the tree; Esc and ✕ close it", async ({ page }) => {
  await open(page);
  await row(page, 3000).click();
  const d = drawer(page);
  await expect(d).toBeVisible();
  await expect(d).toContainText("node (Next.js)");
  await expect(d).toContainText("PID 48213 · up 2 h");
  await expect(d).toContainText("127.0.0.1");
  await expect(d).toContainText("isolated to this machine");
  await expect(d).toContainText("shop-api");
  await expect(d).toContainText("cwd /Users/amit/work/shop-api");
  await expect(d).toContainText("PID 1 (launchd)");
  await expect(d).toContainText("└─ PID 948 (iTerm2)");
  await expect(d).toContainText("└─ PID 48213 (node) [LISTENING ON :3000]");
  await expect(d).toContainText("node /Users/amit/work/shop-api/node_modules/.bin/next dev");
  await expect(row(page, 3000)).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Escape");
  await expect(d).toHaveCount(0);

  // The eye opens it too; ✕ closes it. A public, protected row says so.
  await row(page, 5432).getByRole("button", { name: "Inspect" }).click();
  await expect(d).toContainText("com.docker.backend (PostgreSQL 16)");
  await expect(d).toContainText("reachable from your network");
  await expect(d.getByRole("button", { name: "Restart" })).toBeDisabled();
  await d.getByRole("button", { name: "Close" }).click();
  await expect(d).toHaveCount(0);
});

test("Restart from the drawer produces RELAUNCHED and the row comes back with a new pid", async ({
  page,
}) => {
  await open(page);
  await row(page, 5173).click();
  const d = drawer(page);
  await d.getByRole("button", { name: "Restart" }).click();

  await expect(d.locator("[data-restart-status]")).toHaveText(/^Back on :5173 as pid \d+\.$/);
  const status = await d.locator("[data-restart-status]").textContent();
  const newPid = (status ?? "").match(/pid (\d+)/)?.[1];
  expect(newPid).toBeDefined();
  expect(newPid).not.toBe("51022");
  await expect(d).toContainText(`PID ${newPid}`);
  await expect(toasts(page)).toContainText("Killed node (51022). Port 5173 is free.");
  await expect(toasts(page)).toContainText(`Relaunched node on port 5173 (new pid ${newPid}).`);

  const back = row(page, 5173);
  await expect(back).toHaveAttribute("data-pid", newPid as string);

  // The modal drawer hides the list from the accessibility tree: close it before counting rows.
  await page.keyboard.press("Escape");
  await expect(d).toHaveCount(0);
  await expect(rows(page)).toHaveCount(MOCK_PORT_COUNT);
  await tab(page, "Taskline").click();
  await expect(events(page)).toHaveCount(2);
  await expect(events(page).nth(0)).toContainText("RELAUNCHED");
  await expect(events(page).nth(1)).toContainText("PORT FREED");
  await expect(tasklineBadge(page)).toHaveText("2");
});

test("Kill from the drawer goes through the gate; the drawer closes once the row is gone", async ({
  page,
}) => {
  await open(page);
  await row(page, 5432).click();
  const d = drawer(page);
  await killButton(d).click();
  const dialog = confirmDialog(page);
  await expect(dialog).toContainText("Kill com.docker.backend (11710)?");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(d).toBeVisible();

  await killButton(d).click();
  await dialog.getByRole("button", { name: "Kill anyway" }).click();
  await expect(d).toHaveCount(0);
  await expect(rows(page)).toHaveCount(MOCK_PORT_COUNT - 2);
  await expect(toasts(page)).toContainText("Ports 5432 and 6379 are free.");
});

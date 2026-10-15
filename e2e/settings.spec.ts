import { expect, type Locator, type Page, test } from "@playwright/test";
import { killButton, MOCK_PORT_COUNT, navItem, open, row, rows, search, tile, toasts } from "./helpers";

/**
 * The Preferences view and the first-run card (WP-17b), against the mock core, which keeps the
 * preferences in memory for the page. The view re-reads them every time it opens, so Studio and
 * back is a second read: it proves `setSettings` stored what the control showed.
 */
test.describe.configure({ mode: "parallel" });

const view = (page: Page): Locator => page.locator("[data-view='settings']");
/** A control by its field: a switch, the refresh radiogroup, or a shortcut recorder's box. */
const pref = (page: Page, field: string): Locator => page.locator(`[data-pref='${field}']`);
const prefRow = (page: Page, field: string): Locator => page.locator(`[data-row='${field}']`);
const card = (page: Page): Locator => page.locator("[data-onboarding]");

test("the sidebar's Settings item opens Preferences in the main column and shows as on", async ({ page }) => {
  await open(page);
  await navItem(page, "settings").click();
  await expect(view(page)).toBeVisible();
  await expect(navItem(page, "settings")).toHaveAttribute("aria-current", "true");
  await expect(navItem(page, "all")).not.toHaveAttribute("aria-current", "true");
  // A view, not a dialog or a second window: the list is gone, the toolbar with it.
  await expect(rows(page)).toHaveCount(0);
  await expect(search(page)).toBeHidden();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(view(page).getByRole("heading", { level: 2 })).toHaveText([
    "General",
    "Shortcuts",
    "Killing",
    "About",
  ]);
  await expect(view(page).locator("[data-version]")).toHaveText("PortReaper 0.2.0-mock");

  // A category goes back to the Studio.
  await navItem(page, "all").click();
  await expect(view(page)).toHaveCount(0);
  await expect(rows(page)).toHaveCount(MOCK_PORT_COUNT);
  await expect(navItem(page, "all")).toHaveAttribute("aria-current", "true");
});

test("a toggle saves at once: the switch flips, the row says Saved, a second read agrees", async ({
  page,
}) => {
  await open(page);
  await navItem(page, "settings").click();
  const dock = pref(page, "dockIcon");
  await expect(dock).toHaveRole("switch");
  await expect(dock).toHaveAttribute("aria-checked", "true");
  await dock.click();
  await expect(dock).toHaveAttribute("aria-checked", "false");
  await expect(prefRow(page, "dockIcon").getByText("Saved")).toHaveClass(/opacity-100/);
  await expect(prefRow(page, "startAtLogin").getByText("Saved")).toHaveClass(/opacity-0/);

  const refresh = pref(page, "refreshMs");
  await expect(refresh.getByRole("radio", { checked: true })).toHaveText("2 s");
  await refresh.getByRole("radio", { name: "5 s" }).click();
  await expect(refresh.getByRole("radio", { checked: true })).toHaveText("5 s");

  // Studio and back: the view re-reads the mock, which has what setSettings stored.
  await navItem(page, "all").click();
  await expect(rows(page)).toHaveCount(MOCK_PORT_COUNT);
  await navItem(page, "settings").click();
  await expect(pref(page, "dockIcon")).toHaveAttribute("aria-checked", "false");
  await expect(pref(page, "refreshMs").getByRole("radio", { checked: true })).toHaveText("5 s");
  await expect(pref(page, "startAtLogin")).toHaveAttribute("aria-checked", "true");
});

test("the recorder records ⌃⌥K and shows ⌃⌥K; it refuses a bare key inline; Reset goes back", async ({
  page,
}) => {
  await open(page);
  await navItem(page, "settings").click();
  const quick = pref(page, "quickShortcut");
  const recorder = quick.locator("[data-recorder]");
  await expect(recorder).toHaveText("⌘⇧K");
  await expect(quick.locator("[data-action='reset']")).toHaveCount(0);

  await recorder.click();
  await expect(recorder).toHaveText("Press keys…");
  // A digit while recording is the recorder's, not a search: the view stays.
  await page.keyboard.press("3");
  await expect(quick.locator("[data-refused]")).toHaveText("Add ⌘, ⌃ or ⌥.");
  await expect(view(page)).toBeVisible();
  await page.keyboard.press("Control+Alt+k");
  await expect(recorder).toHaveText("⌃⌥K");
  await expect(quick.locator("[data-refused]")).toHaveCount(0);
  await expect(quick.locator("[data-action='reset']")).toBeVisible();
  // The Dock row's help names the chord in use.
  await expect(prefRow(page, "dockIcon")).toContainText("on ⌃⌥K.");

  // Esc while recording keeps the old chord and stays in Preferences.
  await recorder.click();
  await expect(recorder).toHaveText("Press keys…");
  await page.keyboard.press("Escape");
  await expect(recorder).toHaveText("⌃⌥K");
  await expect(view(page)).toBeVisible();

  await quick.locator("[data-action='reset']").click();
  await expect(recorder).toHaveText("⌘⇧K");
  await expect(quick.locator("[data-action='reset']")).toHaveCount(0);
  await expect(pref(page, "windowShortcut").locator("[data-recorder]")).toHaveText("⌘⇧P");
});

test("⌘, opens Preferences from the search too; Esc goes back to the ports and leaves the search alone", async ({
  page,
}) => {
  await open(page);
  await search(page).fill("30");
  await expect(rows(page)).toHaveCount(1);
  await page.keyboard.press("Meta+,");
  await expect(view(page)).toBeVisible();
  await expect(navItem(page, "settings")).toHaveAttribute("aria-current", "true");

  await page.keyboard.press("Escape");
  await expect(view(page)).toHaveCount(0);
  await expect(navItem(page, "all")).toHaveAttribute("aria-current", "true");
  await expect(search(page)).toHaveValue("30");
  await expect(rows(page)).toHaveCount(1);

  // From the Taskline as well.
  await navItem(page, "taskline").click();
  await page.keyboard.press("Meta+,");
  await expect(view(page)).toBeVisible();
  await expect(navItem(page, "taskline")).not.toHaveAttribute("aria-current", "true");
});

test("Kill sends SIGKILL at once: Kill force-kills, ⌥ makes it graceful again", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Meta+,");
  await pref(page, "defaultForce").click();
  await expect(pref(page, "defaultForce")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(rows(page)).toHaveCount(MOCK_PORT_COUNT);

  await killButton(row(page, 5173)).click();
  await expect(row(page, 5173)).toHaveCount(0);
  await expect(toasts(page).getByRole("button")).toHaveText("Force-killed node (51022). Port 5173 is free.");

  await killButton(row(page, 8080)).click({ modifiers: ["Alt"] });
  await expect(row(page, 8080)).toHaveCount(0);
  await expect(toasts(page).getByRole("button").last()).toHaveText("Killed node (22104). Port 8080 is free.");
});

test("without the seam there is no first-run card", async ({ page }) => {
  await open(page);
  await expect(card(page)).toHaveCount(0);
});

test("`?onboarding=1` shows the first-run card above the cards bar; Got it removes it for good", async ({
  page,
}) => {
  await page.goto("/?onboarding=1");
  await expect(rows(page)).toHaveCount(MOCK_PORT_COUNT);
  const welcome = card(page);
  await expect(welcome).toBeVisible();
  await expect(welcome).toContainText("PortReaper is in your menu bar");
  await expect(welcome).toContainText("⌘⇧K");
  await expect(welcome).toContainText("frees a port from anywhere");
  await expect(welcome).toContainText("Quit lives there");
  await expect(welcome).toContainText("Start at login is on");

  const [cardBox, tileBox] = await Promise.all([welcome.boundingBox(), tile(page, "ports").boundingBox()]);
  expect(cardBox, "card has a box").not.toBeNull();
  expect(tileBox, "tile has a box").not.toBeNull();
  expect(
    (cardBox as { y: number; height: number }).y + (cardBox as { y: number; height: number }).height,
  ).toBeLessThanOrEqual((tileBox as { y: number }).y + 1);

  // The inline toggle is the real preference.
  await welcome.locator("[data-pref='startAtLogin']").click();
  await expect(welcome).toContainText("Start at login is off");

  await welcome.getByRole("button", { name: "Got it" }).click();
  await expect(welcome).toHaveCount(0);
  await expect(rows(page)).toHaveCount(MOCK_PORT_COUNT);

  // Preferences carries the choice; coming back to the Studio brings no card.
  await navItem(page, "settings").click();
  await expect(pref(page, "startAtLogin")).toHaveAttribute("aria-checked", "false");
  await navItem(page, "all").click();
  await expect(card(page)).toHaveCount(0);
});

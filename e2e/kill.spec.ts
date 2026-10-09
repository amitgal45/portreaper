import { expect, test } from "@playwright/test";
import {
  confirmDialog,
  group,
  killButton,
  MOCK_PORT_COUNT,
  open,
  row,
  rows,
  toasts,
  waitForNextPoll,
} from "./helpers";

test.describe.configure({ mode: "parallel" });

test("↓ then Enter kills the first row, and the next poll does not bring it back", async ({ page }) => {
  await open(page);

  await page.keyboard.press("ArrowDown");
  const first = row(page, 3000);
  await expect(first).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Enter");
  await expect(first).toHaveCount(0);
  await expect(rows(page)).toHaveCount(MOCK_PORT_COUNT - 1);
  await expect(toasts(page)).toContainText("Killed node (48213). Port 3000 is free.");

  await waitForNextPoll(page);
  await expect(first).toHaveCount(0);
  await expect(rows(page)).toHaveCount(MOCK_PORT_COUNT - 1);
});

test("a protected port asks first; Cancel keeps it; Kill anyway takes every port of that pid", async ({
  page,
}) => {
  await open(page);
  const postgres = row(page, 5432);
  const redis = row(page, 6379);

  await killButton(postgres).click();
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Kill com.docker.backend (11710)?");
  await expect(dialog).toContainText("com.docker.backend is Docker.");
  await expect(dialog).toContainText("It holds ports 5432 and 6379.");
  await expect(dialog).toContainText("This sends SIGTERM and waits up to 3 s before SIGKILL.");

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(postgres).toBeVisible();
  await expect(rows(page)).toHaveCount(MOCK_PORT_COUNT);

  await killButton(postgres).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Kill anyway" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(postgres).toHaveCount(0);
  await expect(redis).toHaveCount(0);
  await expect(rows(page)).toHaveCount(MOCK_PORT_COUNT - 2);
  await expect(toasts(page)).toContainText(
    "Killed com.docker.backend (11710). Ports 5432 and 6379 are free.",
  );
});

test("⌥-click forces the kill", async ({ page }) => {
  await open(page);

  // An unprotected row dies at once, and the toast says the kill was forced
  // (`killMessage` in src/composables/useKillFlow.ts).
  await killButton(row(page, 5173)).click({ modifiers: ["Alt"] });
  await expect(row(page, 5173)).toHaveCount(0);
  const toast = toasts(page).getByRole("button");
  await expect(toast).toHaveText("Force-killed node (51022). Port 5173 is free.");

  // With the toast still up, the ✕ of the last row stays clickable: toasts are a band under the
  // list, not an overlay. The confirm for a protected row names the signal: ⌥-click on
  // ControlCenter must say SIGKILL, not SIGTERM.
  await expect(toast).toBeVisible();
  await killButton(row(page, 7000)).click({ modifiers: ["Alt"] });
  const dialog = confirmDialog(page);
  await expect(dialog).toContainText("Kill ControlCenter (635)?");
  await expect(dialog).toContainText("This sends SIGKILL at once.");
  await expect(dialog).not.toContainText("SIGTERM");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, 7000)).toBeVisible();
});

test("Kill all on a group removes every row of the group", async ({ page }) => {
  await open(page);
  const shopApi = group(page, "p:shop-api");
  await expect(shopApi.getByRole("row")).toHaveCount(1);

  await shopApi.getByRole("button", { name: "Kill all" }).click();
  await expect(shopApi).toHaveCount(0);
  await expect(row(page, 3000)).toHaveCount(0);
  await expect(rows(page)).toHaveCount(MOCK_PORT_COUNT - 1);
  await expect(toasts(page)).toContainText("Killed node (48213). Port 3000 is free.");
});

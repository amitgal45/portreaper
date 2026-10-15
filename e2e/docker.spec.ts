import { expect, test } from "@playwright/test";
import {
  confirmDialog,
  eventOfKind,
  frameworkIcon,
  inspector,
  killButton,
  MOCK_PORT_COUNT,
  navItem,
  open,
  row,
  rows,
  toasts,
} from "./helpers";

/**
 * Docker-aware (WP-20): the mock's `shop-db` container on :5433. Its row names the container,
 * the inspector has a Container card, and Kill stops the container through the gate.
 */
test.describe.configure({ mode: "parallel" });

test("a container's row names the container; the inspector shows the Container card", async ({ page }) => {
  await open(page);
  const shopDb = row(page, 5433);
  const cell = shopDb.locator("[data-cell='container']");
  await expect(cell).toContainText("shop-db");
  await expect(cell).toContainText("container");
  await expect(shopDb).not.toContainText("11712");
  await expect(shopDb).not.toContainText("com.docker.backend");
  await expect(shopDb.locator("[data-badge='protected']")).toHaveText("Protected");
  // A known image's mark wins over Docker's; the Docker mark goes to the inspector.
  await expect(frameworkIcon(shopDb)).toHaveAttribute("data-brand", "PostgreSQL");
  // Docker's other rows read as before.
  await expect(row(page, 5432).locator("[data-cell='container']")).toHaveCount(0);
  await expect(row(page, 5432)).toContainText("11710");

  await shopDb.click();
  const panel = inspector(page);
  const card = panel.locator("[data-section='container']");
  await expect(card).toContainText("Container");
  await expect(card).toContainText("shop-db");
  await expect(card).toContainText("image postgres:16");
  await expect(card).toContainText("Kill stops the container; Docker stays up.");
  await expect(card.locator("[data-testid='framework-icon']")).toHaveAttribute("data-brand", "Docker");
  await expect(panel.getByRole("button", { name: "Restart" })).toBeDisabled();

  await row(page, 5432).click();
  await expect(panel).toContainText("PID 11710");
  await expect(panel.locator("[data-section='container']")).toHaveCount(0);
});

test("Kill on a container asks to stop it; Cancel keeps it; Stop container takes only that port", async ({
  page,
}) => {
  await open(page);
  const shopDb = row(page, 5433);

  await killButton(shopDb).click();
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Stop container shop-db?");
  await expect(dialog).toContainText(
    "shop-db is a Docker container publishing port 5433; stopping it leaves Docker running.",
  );
  await expect(dialog).toContainText("This runs docker stop and waits up to 3 s before docker kill.");
  await expect(dialog).not.toContainText("SIGTERM");
  await expect(dialog).not.toContainText("Kill anyway");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(shopDb).toBeVisible();
  await expect(rows(page)).toHaveCount(MOCK_PORT_COUNT);

  // ⌥ makes it `docker kill`, and the dialog says so.
  await killButton(shopDb).click({ modifiers: ["Alt"] });
  await expect(dialog).toContainText("This runs docker kill at once.");
  await expect(dialog).not.toContainText("docker stop");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  await killButton(shopDb).click();
  await dialog.getByRole("button", { name: "Stop container" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(shopDb).toHaveCount(0);
  await expect(rows(page)).toHaveCount(MOCK_PORT_COUNT - 1);
  // Docker's other ports are untouched: the backend was not killed.
  await expect(row(page, 5432)).toBeVisible();
  await expect(row(page, 6379)).toBeVisible();
  await expect(toasts(page)).toContainText("Port 5433 is free.");

  await navItem(page, "taskline").click();
  const freed = eventOfKind(page, "portFreed");
  await expect(freed).toHaveCount(1);
  await expect(freed).toContainText("PORT FREED");
  await expect(freed).toContainText("Stopped container shop-db. Port 5433 is free.");
  await expect(freed).toContainText("postgres:16");
  await expect(freed.getByRole("button", { name: "Relaunch" })).toHaveCount(0);
});

import { expect, test } from "@playwright/test";
import {
  confirmDialog,
  contrast,
  group,
  killButton,
  luminance,
  open,
  over,
  paintedColor,
  row,
  rows,
  statusLine,
  tile,
  toasts,
} from "./helpers";

test.describe.configure({ mode: "parallel" });

test.describe("at the minimum window size", () => {
  test.use({ viewport: { width: 560, height: 380 } });

  test("nothing scrolls sideways and nothing interactive sits under the traffic lights", async ({ page }) => {
    await open(page);

    await expect
      .poll(() =>
        page.evaluate(() => {
          const html = document.documentElement;
          const list = document.querySelector('[role="grid"]');
          return {
            page: html.scrollWidth <= html.clientWidth,
            list: list !== null && list.scrollWidth <= list.clientWidth,
          };
        }),
      )
      .toEqual({ page: true, list: true });

    // The native title bar is hidden; macOS draws the traffic lights over the top-left 78×44 px.
    const intruders = await page.evaluate(() => {
      const strip = { right: 78, bottom: 44 };
      const candidates = document.querySelectorAll<HTMLElement>(
        "a, button, input, select, textarea, [role='button'], [tabindex]:not([tabindex='-1'])",
      );
      return [...candidates]
        .map((el) => ({ el, box: el.getBoundingClientRect() }))
        .filter(
          ({ box }) =>
            box.width > 0 &&
            box.height > 0 &&
            box.left < strip.right &&
            box.top < strip.bottom &&
            box.right > 0 &&
            box.bottom > 0,
        )
        .map(({ el, box }) => {
          const name = el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "";
          return `${el.tagName.toLowerCase()} "${name}" at ${Math.round(box.left)},${Math.round(box.top)}`;
        });
    });
    expect(intruders).toEqual([]);
  });
});

test("three toasts stacked leave the last row's ✕ clickable", async ({ page }) => {
  await open(page);

  // Three quick kills of unprotected rows: three toasts, four seconds each.
  for (const port of [5173, 5174, 8080]) {
    await killButton(row(page, port)).click();
    await expect(row(page, port)).toHaveCount(0);
  }
  const stack = toasts(page);
  await expect(stack.getByRole("button")).toHaveCount(3);

  // The last row and the toasts never share a pixel: the toasts are a band below the list.
  const last = row(page, 7000);
  await last.scrollIntoViewIfNeeded();
  const [rowBox, stackBox] = await Promise.all([last.boundingBox(), stack.boundingBox()]);
  expect(rowBox, "last row has a box").not.toBeNull();
  expect(stackBox, "toast stack has a box").not.toBeNull();
  expect(
    (rowBox as { y: number; height: number }).y + (rowBox as { y: number; height: number }).height,
  ).toBeLessThanOrEqual((stackBox as { y: number }).y + 1);

  // And its ✕ takes the click while all three are still up.
  await expect(stack.getByRole("button")).toHaveCount(3);
  await killButton(last).click();
  const dialog = confirmDialog(page);
  await expect(dialog).toContainText("Kill ControlCenter (635)?");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  // The status line is still pinned under the band.
  const footer = await statusLine(page).boundingBox();
  expect(footer, "status line has a box").not.toBeNull();
  expect((footer as { y: number }).y).toBeGreaterThanOrEqual(
    (stackBox as { y: number; height: number }).y + (stackBox as { y: number; height: number }).height - 1,
  );
});

test.describe("the tokens", () => {
  // The app is dark only since v0.2: the OS scheme must not matter.
  test.use({ colorScheme: "light" });

  test("are applied: the body paints Void Black and the rows Ink, whatever the OS scheme says", async ({
    page,
  }) => {
    await open(page);

    const body = await paintedColor(page.locator("body"), "backgroundColor");
    const voidToken = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--color-void").trim(),
    );
    expect(voidToken).toBe("#0a0b0e");
    expect(body.a, `body is ${body.css}`).toBe(1);
    expect([body.r, body.g, body.b], `body is ${body.css}`).toEqual([10, 11, 14]);
    expect(luminance(body)).toBeLessThan(0.1);

    const text = await paintedColor(rows(page).first(), "color");
    expect(text.a, `row text is ${text.css}`).toBe(1);
    expect(luminance(text), `row text is ${text.css}`).toBeGreaterThan(0.6);
  });

  test("the secondary text clears AA (4.5:1) on the row, on the group band and in the tiles", async ({
    page,
  }) => {
    await open(page);
    const surface = await paintedColor(page.locator("main"), "backgroundColor");
    const first = row(page, 3000);

    // The pid, memory and uptime sit on the row surface.
    for (const cell of ["48213", "412 MB", "2 h"]) {
      const colour = await paintedColor(first.getByText(cell, { exact: true }), "color");
      expect(contrast(colour, surface), `${cell} is ${colour.css} on ${surface.css}`).toBeGreaterThanOrEqual(
        4.5,
      );
    }

    // The branch chip sits on the group band (opaque Obsidian) inside its own Steel chip.
    const shopApi = group(page, "p:shop-api");
    const band = over(
      await paintedColor(shopApi.locator(":scope > div").first(), "backgroundColor"),
      surface,
    );
    const branch = shopApi.getByText("feature/cart", { exact: true });
    const chipSurface = over(await paintedColor(branch, "backgroundColor"), band);
    const branchColour = await paintedColor(branch, "color");
    expect(
      contrast(branchColour, chipSurface),
      `branch is ${branchColour.css} on ${chipSurface.css}`,
    ).toBeGreaterThanOrEqual(4.5);

    // The tiles' captions on the tile surface.
    for (const name of ["ports", "memory", "zombies", "public"] as const) {
      const t = tile(page, name);
      const tileSurface = over(await paintedColor(t, "backgroundColor"), surface);
      const caption = await paintedColor(t.locator("div > div").first(), "color");
      expect(
        contrast(caption, tileSurface),
        `${name} caption is ${caption.css} on ${tileSurface.css}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

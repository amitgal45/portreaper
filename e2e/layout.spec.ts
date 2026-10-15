import { expect, test } from "@playwright/test";
import {
  confirmDialog,
  contrast,
  group,
  inspector,
  killButton,
  luminance,
  navItem,
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
  test.use({ viewport: { width: 760, height: 520 } });

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

    // The native title bar is hidden; macOS draws the traffic lights over the top-left 72×52 px.
    const intruders = await page.evaluate(() => {
      const strip = { right: 72, bottom: 52 };
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

    // Below 900 px the inspector is a slide-over; it still fits.
    await row(page, 3000).click();
    await expect(inspector(page)).toBeVisible();
    const box = await inspector(page).boundingBox();
    expect(box, "inspector has a box").not.toBeNull();
    expect(
      (box as { x: number; width: number }).x + (box as { x: number; width: number }).width,
    ).toBeLessThanOrEqual(760);
  });
});

test("three toasts stacked leave the last row's Kill clickable", async ({ page }) => {
  await open(page);

  // Three quick kills of unprotected rows: three toasts, four seconds each.
  for (const port of [5173, 5174, 8080]) {
    await killButton(row(page, port)).click();
    await expect(row(page, port)).toHaveCount(0);
  }
  const stack = toasts(page);
  await expect(stack.getByRole("button")).toHaveCount(3);

  // The last row and the toasts never share a pixel: the toasts are a band below the table.
  const last = row(page, 7000);
  await last.scrollIntoViewIfNeeded();
  const [rowBox, stackBox] = await Promise.all([last.boundingBox(), stack.boundingBox()]);
  expect(rowBox, "last row has a box").not.toBeNull();
  expect(stackBox, "toast stack has a box").not.toBeNull();
  expect(
    (rowBox as { y: number; height: number }).y + (rowBox as { y: number; height: number }).height,
  ).toBeLessThanOrEqual((stackBox as { y: number }).y + 1);

  // And its Kill takes the click while all three are still up.
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
  // The Board follows the system: the same window, light and dark.
  for (const scheme of ["light", "dark"] as const) {
    test.describe(scheme, () => {
      test.use({ colorScheme: scheme });

      test("are applied: the body paints the canvas and the rows the ink", async ({ page }) => {
        await open(page);

        const canvas = await page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim(),
        );
        expect(canvas).toBe(scheme === "light" ? "#f5f6f8" : "#1c1c1f");
        const body = await paintedColor(page.locator("body"), "backgroundColor");
        expect(body.a, `body is ${body.css}`).toBe(1);
        expect([body.r, body.g, body.b], `body is ${body.css}`).toEqual(
          scheme === "light" ? [245, 246, 248] : [28, 28, 31],
        );

        const text = await paintedColor(rows(page).first(), "color");
        expect(text.a, `row text is ${text.css}`).toBe(1);
        if (scheme === "light") expect(luminance(text), `row text is ${text.css}`).toBeLessThan(0.05);
        else expect(luminance(text), `row text is ${text.css}`).toBeGreaterThan(0.8);
      });

      test("the secondary text clears AA (4.5:1) on the row, on the group row, in the cards and in the sidebar", async ({
        page,
      }) => {
        await open(page);
        const surface = await paintedColor(page.locator("[role='grid']"), "backgroundColor");
        const first = row(page, 3000);

        // The pid, memory and uptime sit on the row surface in ink-2.
        for (const cell of ["48213", "412 MB", "2 h"]) {
          const colour = await paintedColor(first.getByText(cell, { exact: true }), "color");
          expect(
            contrast(colour, surface),
            `${cell} is ${colour.css} on ${surface.css}`,
          ).toBeGreaterThanOrEqual(4.5);
        }

        // The branch on the group row.
        const shopApi = group(page, "p:shop-api");
        const band = over(
          await paintedColor(shopApi.locator(":scope > div").first(), "backgroundColor"),
          surface,
        );
        const branch = await paintedColor(shopApi.getByText("feature/cart", { exact: true }), "color");
        expect(contrast(branch, band), `branch is ${branch.css} on ${band.css}`).toBeGreaterThanOrEqual(4.5);

        // The cards' captions on the card surface, tinted or not.
        for (const name of ["ports", "memory", "zombies", "public"] as const) {
          const t = tile(page, name);
          const cardSurface = over(await paintedColor(t, "backgroundColor"), surface);
          const caption = await paintedColor(t.locator("span").last(), "color");
          expect(
            contrast(caption, cardSurface),
            `${name} caption is ${caption.css} on ${cardSurface.css}`,
          ).toBeGreaterThanOrEqual(4.5);
        }

        // The selected sidebar item: brand ink on the brand tint.
        const all = navItem(page, "all");
        const itemSurface = over(await paintedColor(all, "backgroundColor"), surface);
        const label = await paintedColor(all, "color");
        expect(
          contrast(label, itemSurface),
          `All ports is ${label.css} on ${itemSurface.css}`,
        ).toBeGreaterThanOrEqual(4.5);
      });
    });
  }
});

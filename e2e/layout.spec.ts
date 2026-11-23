import { expect, type Locator, type Page, test } from "@playwright/test";
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
  type Rgba,
  row,
  rows,
  statusLine,
  tile,
  toasts,
} from "./helpers";

test.describe.configure({ mode: "parallel" });

/** A grey token as the root sets it for the scheme (`--sidebar-ink-2` → [r, g, b]). */
async function rootToken(page: Page, name: string): Promise<number[]> {
  const hex = await page.evaluate(
    (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name,
  );
  expect(hex, name).toMatch(/^#[0-9a-f]{6}$/i);
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
}
const rgb = (c: Rgba) => [c.r, c.g, c.b];

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

test.describe("at the default window size", () => {
  test.use({ viewport: { width: 1040, height: 660 } });

  test("the inspector is a 340 px column, nothing scrolls sideways, and the long project names fit", async ({
    page,
  }) => {
    await open(page);
    await row(page, 3000).click();
    await expect(inspector(page)).toContainText("[LISTENING ON :3000]");
    // The column is the grid track: the panel plus its 1 px left border.
    const column = await inspector(page).locator("xpath=..").boundingBox();
    expect(column, "inspector column has a box").not.toBeNull();
    expect((column as { width: number }).width).toBe(340);
    expect((column as { x: number; width: number }).x + (column as { width: number }).width).toBe(1040);

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

    // 900×600 cut "tinyrecipe-lp" and its branch with the inspector open; 1040 shows them whole.
    const name = group(page, "p:tinyrecipe-lp").getByText("tinyrecipe-lp", { exact: true });
    expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const branch = group(page, "p:tinyrecipe-lp").getByText("amit/TR-120-hero", { exact: true });
    expect(await branch.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
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
  // The last row is Ollama's: a brew service launchd restarts, so the last protected group.
  const last = row(page, 11434);
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
  await expect(dialog).toContainText("Kill ollama (32014)?");
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

        // B v3 (#34): the mock-up's canvas in light, macOS's in dark.
        const canvas = await page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim(),
        );
        expect(canvas).toBe(scheme === "light" ? "#f5f5f7" : "#1e1e1e");
        const body = await paintedColor(page.locator("body"), "backgroundColor");
        expect(body.a, `body is ${body.css}`).toBe(1);
        expect([body.r, body.g, body.b], `body is ${body.css}`).toEqual(
          scheme === "light" ? [245, 245, 247] : [30, 30, 30],
        );

        const text = await paintedColor(rows(page).first(), "color");
        expect(text.a, `row text is ${text.css}`).toBe(1);
        if (scheme === "light") expect(luminance(text), `row text is ${text.css}`).toBeLessThan(0.05);
        else expect(luminance(text), `row text is ${text.css}`).toBeGreaterThan(0.8);
      });

      test("every lucide icon draws at stroke 1.75 over its stroke-width attribute; our own icons draw 1.75", async ({
        page,
      }) => {
        await open(page);
        // `.lucide` is what style.css targets, so the test names it too.
        const lucide = await page.locator("svg.lucide").evaluateAll((els) =>
          els.map((el) => ({
            attribute: el.getAttribute("stroke-width"),
            computed: Number.parseFloat(getComputedStyle(el).strokeWidth),
          })),
        );
        expect(lucide.length, "lucide icons on screen").toBeGreaterThan(0);
        expect(lucide.map((i) => i.computed)).toEqual(lucide.map(() => 1.75));
        // The rule beats the attribute: lucide wrote 2 (or a call site's value) on at least one.
        expect(
          lucide.some((i) => i.attribute !== "1.75"),
          JSON.stringify(lucide),
        ).toBe(true);

        const own = await navItem(page, "all")
          .locator("svg")
          .evaluate((el) => ({
            attribute: el.getAttribute("stroke-width"),
            computed: Number.parseFloat(getComputedStyle(el).strokeWidth),
          }));
        expect(own).toEqual({ attribute: "1.75", computed: 1.75 });
      });

      test("the secondary text clears AA (4.5:1) on the row, on the group row, in the cards and in the sidebar", async ({
        page,
      }) => {
        await open(page);
        const surface = await paintedColor(page.locator("[role='grid']"), "backgroundColor");
        const first = row(page, 3000);

        // The pid, memory and uptime sit on the row surface in ink-2, the window's grey.
        const ink2 = await rootToken(page, "--ink-2");
        for (const cell of ["48213", "412 MB", "2 h"]) {
          const colour = await paintedColor(first.getByText(cell, { exact: true }), "color");
          expect(rgb(colour), `${cell} paints --ink-2`).toEqual(ink2);
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

        // The selected sidebar item (B v3): ink on the neutral fill, over the translucent sidebar,
        // over the window's canvas. A label that is off: the sidebar's own ink-2 on the sidebar.
        const windowCanvas = await paintedColor(page.locator("main"), "backgroundColor");
        const sidebar = over(
          await paintedColor(page.getByRole("navigation", { name: "Views" }), "backgroundColor"),
          windowCanvas,
        );
        for (const key of ["all", "dev"] as const) {
          const item = navItem(page, key);
          const itemSurface = over(await paintedColor(item, "backgroundColor"), sidebar);
          const label = await paintedColor(item, "color");
          expect(
            contrast(label, itemSurface),
            `${key} label is ${label.css} on ${itemSurface.css}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
        expect(
          rgb(await paintedColor(navItem(page, "dev"), "color")),
          "dev label paints --sidebar-ink-2",
        ).toEqual(await rootToken(page, "--sidebar-ink-2"));
      });

      test("the pills, the filled Kill, the sidebar's badges and the tertiary labels clear AA (4.5:1)", async ({
        page,
      }) => {
        await open(page);
        /** The painted text over the painted background of one element. */
        const own = async (locator: Locator, what: string) => {
          const [text, fill] = await Promise.all([
            paintedColor(locator, "color"),
            paintedColor(locator, "backgroundColor"),
          ]);
          expect(fill.a, `${what} paints an opaque background (${fill.css})`).toBe(1);
          expect(contrast(text, fill), `${what} is ${text.css} on ${fill.css}`).toBeGreaterThanOrEqual(4.5);
        };

        // The five status pills: a tint with its ink, 12 px semibold (WP-19).
        for (const [port, badge] of [
          [3000, "running"],
          [4000, "zombie"],
          [8080, "public"],
          [5432, "protected"],
          [11434, "ai"],
        ] as const) {
          await own(row(page, port).locator(`[data-badge="${badge}"]`), `${badge} pill on :${port}`);
        }

        // The sidebar (B v3): plain grey counts and the ⌘1–⌘4 hints on the item (the selected one's
        // neutral fill, or none) over the translucent sidebar over the canvas; the section headings on it.
        const windowCanvas = await paintedColor(page.locator("main"), "backgroundColor");
        const sidebar = over(
          await paintedColor(page.getByRole("navigation", { name: "Views" }), "backgroundColor"),
          windowCanvas,
        );
        /** Text inside a sidebar item, on the item's own fill over the sidebar. */
        const inItem = async (key: Parameters<typeof navItem>[1], text: Locator, what: string) => {
          const fill = over(await paintedColor(navItem(page, key), "backgroundColor"), sidebar);
          const colour = await paintedColor(text, "color");
          expect(contrast(colour, fill), `${what} is ${colour.css} on ${fill.css}`).toBeGreaterThanOrEqual(
            4.5,
          );
        };
        for (const key of ["all", "dev", "zombie", "public", "watching"] as const) {
          await inItem(key, navItem(page, key).locator("[data-count]"), `${key} count`);
        }
        // The quiet counts, hints and headings take the sidebar's ink-3; the status line below, the window's.
        expect(
          rgb(await paintedColor(navItem(page, "dev").locator("[data-count]"), "color")),
          "dev count paints --sidebar-ink-3",
        ).toEqual(await rootToken(page, "--sidebar-ink-3"));
        for (const key of ["all", "dev", "ai", "db"] as const) {
          await inItem(key, navItem(page, key).locator("[data-shortcut]"), `${key} ⌘ hint`);
        }
        for (const text of ["Ports", "Needs attention"]) {
          const heading = await paintedColor(
            page.getByRole("navigation", { name: "Views" }).getByText(text, { exact: true }),
            "color",
          );
          expect(
            contrast(heading, sidebar),
            `heading ${text} is ${heading.css} on ${sidebar.css}`,
          ).toBeGreaterThanOrEqual(4.5);
        }

        // The status line's tertiary text on the surface.
        const footer = await paintedColor(statusLine(page), "backgroundColor");
        const status = await paintedColor(statusLine(page).locator("span").nth(1), "color");
        expect(rgb(status), "the status line paints --ink-3").toEqual(await rootToken(page, "--ink-3"));
        expect(contrast(status, footer), `status is ${status.css} on ${footer.css}`).toBeGreaterThanOrEqual(
          4.5,
        );

        // The selected row: the filled Kill and the active badge are the surface on an ink.
        await row(page, 3000).click();
        await expect(row(page, 3000)).toHaveAttribute("aria-selected", "true");
        await own(killButton(row(page, 3000)), "the selected row's Kill");
        await inItem("all", navItem(page, "all").locator("[data-count]"), "the active count");
        await own(killButton(inspector(page)), "the inspector's Kill");
      });
    });
  }
});

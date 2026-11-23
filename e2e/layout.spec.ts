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

/** The summary line's four items, in order (B v3, spec item 3). */
const TILES = ["ports", "memory", "zombies", "public"] as const;
/** The summary line under the toolbar. */
const summary = (page: Page): Locator => page.locator("[data-summary]");
/** The table's header row: the first child of the grid, aria-hidden. */
const tableHeader = (page: Page): Locator => page.locator("[role='grid'] > div").first();
/** A row's status, coloured text with its icon (spec item 8): mock row, data-badge, the ink it paints. */
const STATUSES = [
  [3000, "running", "--green-ink"],
  [4000, "zombie", "--orange-ink"],
  [8080, "public", "--red-ink"],
  [5432, "protected", "--blue-ink"],
  [11434, "ai", "--purple-ink"],
] as const;

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

  test("the summary line wraps and clips no item; a row shows only its first status below 640 px of main", async ({
    page,
  }) => {
    await open(page);
    // Main is 560 px here: the four items do not fit on one line, so it wraps (B v3, spec item 3).
    const line = await summary(page).boundingBox();
    expect(line, "summary line has a box").not.toBeNull();
    const { x, width } = line as { x: number; width: number };
    for (const name of TILES) {
      const t = tile(page, name);
      const box = await t.boundingBox();
      expect(box, `${name} has a box`).not.toBeNull();
      const b = box as { x: number; width: number };
      expect(b.x, `${name} starts inside the line`).toBeGreaterThanOrEqual(x - 0.5);
      expect(b.x + b.width, `${name} ends inside the line`).toBeLessThanOrEqual(x + width + 0.5);
      expect(await t.evaluate((el) => el.scrollWidth <= el.clientWidth), `${name} clips`).toBe(true);
      for (const part of await t.locator("span").all()) {
        expect(await part.evaluate((el) => el.scrollWidth <= el.clientWidth), `${name} part clips`).toBe(
          true,
        );
      }
    }
    // Docker on every interface: Public first, Protected only from 640 px (WIDE_ONLY).
    await expect(row(page, 5432).locator("[data-badge='public']")).toBeVisible();
    await expect(row(page, 5432).locator("[data-badge='protected']")).toBeHidden();
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

        // The summary line's labels (B v3: no cards) in ink-2, on the item (no fill of its own) over the line.
        const line = over(await paintedColor(summary(page), "backgroundColor"), surface);
        for (const name of TILES) {
          const t = tile(page, name);
          const itemSurface = over(await paintedColor(t, "backgroundColor"), line);
          const caption = await paintedColor(t.locator("span").last(), "color");
          expect(rgb(caption), `${name} label paints --ink-2`).toEqual(ink2);
          expect(
            contrast(caption, itemSurface),
            `${name} label is ${caption.css} on ${itemSurface.css}`,
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

      test("the statuses, the selected row's Kill, the sidebar's counts and the tertiary labels clear AA (4.5:1)", async ({
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

        // The five statuses (B v3): their ink as text, no fill of their own, on the row and on the
        // hovered row; the icon paints the same ink.
        const surface = await paintedColor(page.locator("[role='grid']"), "backgroundColor");
        await page.mouse.move(1, 1);
        for (const [port, badge, ink] of STATUSES) {
          const r = row(page, port);
          const text = r.locator(`[data-badge="${badge}"]`);
          const colour = await paintedColor(text, "color");
          expect(rgb(colour), `${badge} on :${port} paints ${ink}`).toEqual(await rootToken(page, ink));
          expect((await paintedColor(text, "backgroundColor")).a, `${badge} has no fill`).toBe(0);
          expect(rgb(await paintedColor(text.locator("svg"), "color")), `${badge} icon`).toEqual(rgb(colour));
          const still = over(await paintedColor(r, "backgroundColor"), surface);
          expect(contrast(colour, still), `${badge} is ${colour.css} on ${still.css}`).toBeGreaterThanOrEqual(
            4.5,
          );
          await r.hover();
          const hovered = over(await paintedColor(r, "backgroundColor"), surface);
          expect(rgb(hovered), `:${port} hovered paints --hover`).toEqual(await rootToken(page, "--hover"));
          expect(
            contrast(colour, hovered),
            `${badge} is ${colour.css} on the hovered ${hovered.css}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
        await page.mouse.move(1, 1);

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

        // The selected row (B v3): its Kill is the surface with red ink (white in light), on the coral.
        await row(page, 3000).click();
        await expect(row(page, 3000)).toHaveAttribute("aria-selected", "true");
        await own(killButton(row(page, 3000)), "the selected row's Kill");
        expect(
          rgb(await paintedColor(killButton(row(page, 3000)), "color")),
          "Kill paints --red-ink",
        ).toEqual(await rootToken(page, "--red-ink"));
        expect(
          rgb(await paintedColor(killButton(row(page, 3000)), "backgroundColor")),
          "Kill paints --surface",
        ).toEqual(await rootToken(page, "--surface"));
        await inItem("all", navItem(page, "all").locator("[data-count]"), "the active count");
        await own(killButton(inspector(page)), "the inspector's Kill");
      });

      test.describe("with main wide enough for every column", () => {
        // 1280 px: main is 740 px with the inspector open, so memory and uptime show.
        test.use({ viewport: { width: 1280, height: 720 } });

        test("the selected row is the coral fill, and every text and icon in it is white at 4.5:1 or more", async ({
          page,
        }) => {
          await open(page);
          const white = await rootToken(page, "--on-sel-fill");
          const coral = await rootToken(page, "--sel-fill");
          /** Selects a row by a click, moves the pointer away, and checks each text and icon on its fill. */
          const check = async (port: number, parts: [what: string, locator: Locator][]) => {
            const r = row(page, port);
            await r.click();
            await expect(r).toHaveAttribute("aria-selected", "true");
            await page.mouse.move(1, 1);
            const fill = await paintedColor(r, "backgroundColor");
            expect(fill.a, `:${port} fill is ${fill.css}`).toBe(1);
            expect(rgb(fill), `:${port} paints --sel-fill`).toEqual(coral);
            for (const [what, locator] of parts) {
              await expect(locator, `${what} on :${port}`).toBeVisible();
              const colour = await paintedColor(locator, "color");
              expect(colour.a, `${what} on :${port} is opaque`).toBe(1);
              expect(rgb(colour), `${what} on :${port} paints --on-sel-fill`).toEqual(white);
              expect(
                await locator.evaluate((el) => {
                  // No opacity on the way up to the row.
                  let o = 1;
                  for (let n: Element | null = el; n && n.getAttribute("role") !== "row"; n = n.parentElement)
                    o *= Number(getComputedStyle(n).opacity);
                  return o;
                }),
                `${what} on :${port} at full opacity`,
              ).toBe(1);
              // The text sits on the coral itself: nothing between paints a fill.
              const own = await paintedColor(locator, "backgroundColor");
              expect(own.a, `${what} on :${port} has no fill (${own.css})`).toBe(0);
              expect(
                contrast(colour, fill),
                `${what} is ${colour.css} on ${fill.css}`,
              ).toBeGreaterThanOrEqual(4.5);
            }
          };

          const dev = row(page, 3000);
          await check(3000, [
            ["port", dev.getByText("3000", { exact: true })],
            ["process", dev.getByText("node", { exact: true })],
            ["pid", dev.getByText("48213", { exact: true })],
            ["status", dev.locator("[data-badge='running']")],
            ["status icon", dev.locator("[data-badge='running'] svg")],
            ["memory", dev.getByText("412 MB", { exact: true })],
            ["uptime", dev.getByText("2 h", { exact: true })],
            ["menu", dev.getByRole("button", { name: "More" })],
          ]);
          const daemon = row(page, 53);
          await check(53, [
            ["udp tag", daemon.getByText("udp", { exact: true })],
            ["status", daemon.locator("[data-badge='protected']")],
          ]);
          const ollama = row(page, 11434);
          await check(11434, [
            ["status", ollama.locator("[data-badge='protected']")],
            ["second status", ollama.locator("[data-badge='ai']")],
            ["launchd chip", ollama.locator("[data-badge='launchd']")],
          ]);
          // A coloured brand mark (Vite's violet) paints white on the coral too, over its fill attribute.
          const vite = row(page, 5173);
          const mark = vite.locator("[data-testid='framework-icon'] path");
          const fillOf = () => mark.evaluate((el) => getComputedStyle(el).fill);
          const brand = await fillOf();
          await check(5173, [
            ["status", vite.locator("[data-badge='running']")],
            ["mark", vite.locator("[data-testid='framework-icon']")],
          ]);
          expect(await fillOf(), "the mark no longer paints its brand colour").not.toBe(brand);
          expect(await fillOf(), "the mark paints its text colour").toBe(
            await mark.evaluate((el) => getComputedStyle(el).color),
          );
        });

        test("the table header, the group rows and the summary line clear AA on their own backgrounds", async ({
          page,
        }) => {
          await open(page);
          const surface = await paintedColor(page.locator("[role='grid']"), "backgroundColor");
          const band = await rootToken(page, "--band");

          // The header (B v3): on the band, sentence case, ink-3.
          const header = tableHeader(page);
          const headerFill = over(await paintedColor(header, "backgroundColor"), surface);
          expect(rgb(headerFill), "the header paints --band").toEqual(band);
          for (const text of ["Port", "Process", "Status", "Memory", "Uptime"]) {
            const heading = header.getByText(text, { exact: true });
            expect(await heading.evaluate((el) => getComputedStyle(el).textTransform), text).toBe("none");
            const colour = await paintedColor(heading, "color");
            expect(rgb(colour), `${text} paints --ink-3`).toEqual(await rootToken(page, "--ink-3"));
            expect(
              contrast(colour, headerFill),
              `${text} is ${colour.css} on ${headerFill.css}`,
            ).toBeGreaterThanOrEqual(4.5);
          }

          // A group row: on the band, an 8 px dot, the name, the branch and the count.
          const shopApi = group(page, "p:shop-api");
          const bar = shopApi.locator(":scope > div").first();
          const groupFill = over(await paintedColor(bar, "backgroundColor"), surface);
          expect(rgb(groupFill), "the group row paints --band").toEqual(band);
          const dot = await bar.locator(":scope > span").first().boundingBox();
          expect(dot, "the dot has a box").not.toBeNull();
          expect([(dot as { width: number }).width, (dot as { height: number }).height]).toEqual([8, 8]);
          for (const [text, ink] of [
            ["shop-api", "--ink"],
            ["feature/cart", "--ink-2"],
            ["1 port", "--ink-3"],
          ] as const) {
            const colour = await paintedColor(shopApi.getByText(text, { exact: true }), "color");
            expect(rgb(colour), `${text} paints ${ink}`).toEqual(await rootToken(page, ink));
            expect(
              contrast(colour, groupFill),
              `${text} is ${colour.css} on ${groupFill.css}`,
            ).toBeGreaterThanOrEqual(4.5);
          }

          // The summary line: no card behind an item; numbers in ink, the alarms in theirs.
          const line = over(await paintedColor(summary(page), "backgroundColor"), surface);
          for (const [name, ink] of [
            ["ports", "--ink"],
            ["memory", "--ink"],
            ["zombies", "--orange-ink"],
            ["public", "--red-ink"],
          ] as const) {
            const t = tile(page, name);
            expect((await paintedColor(t, "backgroundColor")).a, `${name} has no card`).toBe(0);
            expect(await t.evaluate((el) => getComputedStyle(el).borderTopWidth), `${name} border`).toBe(
              "0px",
            );
            const number = await paintedColor(t.locator("span").nth(1), "color");
            expect(rgb(number), `${name} number paints ${ink}`).toEqual(await rootToken(page, ink));
            expect(
              contrast(number, line),
              `${name} number is ${number.css} on ${line.css}`,
            ).toBeGreaterThanOrEqual(4.5);
          }
          // A filter item under the pointer: its label on the hover fill.
          await tile(page, "zombies").hover();
          const hovered = over(await paintedColor(tile(page, "zombies"), "backgroundColor"), line);
          for (const part of [1, 2]) {
            const colour = await paintedColor(tile(page, "zombies").locator("span").nth(part), "color");
            expect(
              contrast(colour, hovered),
              `zombies part ${part} is ${colour.css} on ${hovered.css}`,
            ).toBeGreaterThanOrEqual(4.5);
          }
        });
      });
    });
  }
});

test.describe("Kill on a row (B v3, spec item 5)", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test("is transparent on a row neither selected nor hovered, opaque on hover and on the selected row, and reachable by Tab", async ({
    page,
  }) => {
    await open(page);
    await page.mouse.move(1, 1);
    const vite = row(page, 5173);
    const kill = killButton(vite);

    // Neither selected nor hovered: transparent, by opacity alone. It keeps its box, its name and
    // its place in the accessibility tree.
    await expect(vite).toHaveAttribute("aria-selected", "false");
    await expect(kill).toHaveCSS("opacity", "0");
    await expect(kill).toHaveCSS("visibility", "visible");
    await expect(kill).not.toHaveCSS("display", "none");
    await expect(kill).toHaveAccessibleName("Kill");
    const box = await kill.boundingBox();
    expect(box, "Kill has a box").not.toBeNull();
    expect((box as { width: number }).width).toBeGreaterThan(0);
    // No motion: it shows at once.
    expect(await kill.evaluate((el) => getComputedStyle(el).transitionDuration)).toMatch(/^0s(, 0s)*$/);

    // Under the pointer: opaque; the pointer leaves: transparent again.
    await vite.hover();
    await expect(kill).toHaveCSS("opacity", "1");
    await page.mouse.move(1, 1);
    await expect(kill).toHaveCSS("opacity", "0");

    // By Tab, with the pointer away: from the group's Kill all to the row's Kill, which shows while
    // it has the focus and while its row has it (on to the row's menu).
    await group(page, "p:portreaper").getByRole("button", { name: "Kill all" }).focus();
    await page.keyboard.press("Tab");
    await expect(kill).toBeFocused();
    await expect(kill).toBeVisible();
    await expect(kill).toHaveAccessibleName("Kill");
    await expect(kill).toHaveCSS("opacity", "1");
    await page.keyboard.press("Tab");
    await expect(vite.getByRole("button", { name: "More" })).toBeFocused();
    await expect(kill).toHaveCSS("opacity", "1");
    await page.keyboard.press("Tab");
    await expect(vite.getByRole("button", { name: "More" })).not.toBeFocused();
    await expect(kill).toHaveCSS("opacity", "0");

    // The selected row: opaque with the pointer away and the focus elsewhere; the others stay transparent.
    await row(page, 3000).click();
    await expect(row(page, 3000)).toHaveAttribute("aria-selected", "true");
    await page.mouse.move(1, 1);
    await page.locator("body").evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(killButton(row(page, 3000))).toHaveCSS("opacity", "1");
    await expect(kill).toHaveCSS("opacity", "0");
  });
});

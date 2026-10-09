import { expect, test } from "@playwright/test";
import { luminance, open, paintedColor, rows } from "./helpers";

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

test.describe("in dark mode", () => {
  test.use({ colorScheme: "dark" });

  test("the surface is dark and the text is light", async ({ page }) => {
    await open(page);

    // The body paints nothing itself: `main` is the surface the rows sit on, and it fills the
    // window. Measure the body when it has a colour, else the surface under it.
    const body = await paintedColor(page.locator("body"), "backgroundColor");
    const surface = body.a > 0 ? body : await paintedColor(page.locator("main"), "backgroundColor");
    expect(surface.a, `surface is ${surface.css}`).toBe(1);
    expect(luminance(surface), `surface is ${surface.css}`).toBeLessThan(0.1);

    const text = await paintedColor(rows(page).first(), "color");
    expect(text.a, `row text is ${text.css}`).toBe(1);
    expect(luminance(text), `row text is ${text.css}`).toBeGreaterThan(0.6);
  });
});

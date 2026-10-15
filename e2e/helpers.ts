import { expect, type Locator, type Page } from "@playwright/test";
import type { CategoryFilter } from "../src/composables/usePorts";

/**
 * Locators for the parts of the window the tests talk about, by role, label or data attribute;
 * never by class. The fixture is `MOCK_ENTRIES` in `src/api/mock.ts`: when it changes, the
 * numbers in the specs change with it, in the same commit.
 */

/** Entries in the mock core. */
export const MOCK_PORT_COUNT = 12;
/** Projects among them (the status line and the first card count these). */
export const MOCK_PROJECT_COUNT = 7;

export const rows = (page: Page): Locator => page.getByRole("row");
export const row = (page: Page, port: number): Locator => page.locator(`[role="row"][data-port="${port}"]`);
/** A project group by its key: `p:<project name>` or `n:<process name>`. */
export const group = (page: Page, key: string): Locator => page.locator(`section[data-group="${key}"]`);
export const search = (page: Page): Locator => page.getByRole("textbox", { name: "Search ports" });
export const toasts = (page: Page): Locator => page.getByRole("status");
export const confirmDialog = (page: Page): Locator => page.getByRole("alertdialog");
export const statusLine = (page: Page): Locator => page.locator("footer");
/** The Kill button on a row (the inspector has one too; scope through the row or the inspector). */
export const killButton = (scope: Locator): Locator =>
  scope.getByRole("button", { name: "Kill", exact: true });
/** The `…` of a row: opens the row menu. */
export const moreButton = (r: Locator): Locator => r.getByRole("button", { name: "More" });

// The Board (WP-15a)
/** A sidebar item: a category filter, or `taskline`. The one that is on has `aria-current`. */
export const navItem = (page: Page, key: CategoryFilter | "taskline" | "settings"): Locator =>
  page.locator(`[data-nav="${key}"]`);
export const tile = (page: Page, name: "ports" | "memory" | "zombies" | "public"): Locator =>
  page.locator(`[data-tile="${name}"]`);
export const reapButton = (page: Page): Locator => page.locator("[data-action='reap']");
export const tasklineBadge = (page: Page): Locator => page.locator("[data-badge='taskline-count']");
/** The inspector panel: the third column in a wide window, inside a dialog in a narrow one. */
export const inspector = (page: Page): Locator => page.locator("[data-inspector]");
/** The brand mark of a row's stack (`data-brand` names it), or nothing for an unknown stack. */
export const frameworkIcon = (r: Locator): Locator => r.locator("[data-testid='framework-icon']");
export const feed = (page: Page): Locator => page.getByRole("feed");
/** The sidebar's update banner (WP-16); absent until a newer release is known (`/?update=1` in a browser). */
export const updateBanner = (page: Page): Locator => page.getByRole("region", { name: "Update" });
export const events = (page: Page): Locator => feed(page).locator("article");
export const eventOfKind = (page: Page, kind: string): Locator =>
  feed(page).locator(`article[data-kind="${kind}"]`);

/** Opens the app and waits for the first poll: every mock row on screen. */
export async function open(page: Page): Promise<void> {
  await page.goto("/");
  await expect(rows(page)).toHaveCount(MOCK_PORT_COUNT);
}

/** The ports on screen, top to bottom. */
export const shownPorts = (page: Page) =>
  rows(page).evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-port"))));

/**
 * Waits for the next poll to complete. The status line counts seconds since the last refresh and
 * drops back to "0 s ago" only when a poll answered, so "N s ago" followed by "0 s ago" proves one
 * finished after this call started.
 */
export async function waitForNextPoll(page: Page): Promise<void> {
  const line = statusLine(page);
  await expect(line).toContainText(/last refresh [1-9]\d* s ago/);
  await expect(line).toContainText("last refresh 0 s ago");
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
  /** The computed value as the browser serialised it (Tailwind 4 emits oklch). */
  css: string;
}

/**
 * The colour a computed style actually paints, as sRGB bytes. Goes through a 1×1 canvas so the
 * browser does the colour-space work (oklch, rgba, named colours) instead of a parser here.
 */
export function paintedColor(locator: Locator, property: "backgroundColor" | "color"): Promise<Rgba> {
  return locator.evaluate((el, prop) => {
    const css = getComputedStyle(el)[prop];
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d canvas context");
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return { r: r ?? 0, g: g ?? 0, b: b ?? 0, a: (a ?? 0) / 255, css };
  }, property);
}

/** Relative luminance (WCAG): 0 is black, 1 is white. */
export function luminance({ r, g, b }: Rgba): number {
  const linear = (byte: number) => {
    const c = byte / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** `top` painted over an opaque `bottom`, the way a translucent band composites in sRGB. */
export function over(top: Rgba, bottom: Rgba): Rgba {
  const mix = (t: number, b: number) => Math.round(top.a * t + (1 - top.a) * b);
  return {
    r: mix(top.r, bottom.r),
    g: mix(top.g, bottom.g),
    b: mix(top.b, bottom.b),
    a: 1,
    css: `${top.css} over ${bottom.css}`,
  };
}

/** WCAG contrast ratio, 1 to 21. AA for small text is 4.5. */
export function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

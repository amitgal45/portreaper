import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * The Quick strip (`quick.html`: WP-8b, made instant by WP-12, on the Board tokens since WP-15b)
 * in a browser against the mock core. The window that hosts it (480×320, always on top, hidden on blur) is WP-8a's
 * and is not here: in a browser `hideCurrentWindow()` is a no-op, so after a kill or Esc the
 * strip simply stays on screen.
 *
 * The fixture is `MOCK_ENTRIES` in `src/api/mock.ts`: 11 entries, 7 of them unprotected; the strip
 * shows six. Relied on: :3000 (a dev server), :5432 (protected, Docker, which also holds :6379),
 * :5174 and :4000 (the lost-terminal zombies, newest first, so :5174 heads an empty query) and
 * :11434 (Ollama, the `ai` row, 12 days old so a query has to ask for it). When the mock
 * changes, the numbers here change with it, in the same commit.
 */
test.use({ viewport: { width: 480, height: 320 } });
test.describe.configure({ mode: "parallel" });

const input = (page: Page): Locator => page.getByRole("combobox", { name: "Free a port" });
const options = (page: Page): Locator => page.getByRole("option");
const option = (page: Page, port: number): Locator => page.locator(`[role="option"][data-port="${port}"]`);
/** The status pill at the right of a row (Zombie, Public, Protected, AI · memory); a plain dev server has none. */
const status = (row: Locator): Locator => row.locator("[data-status]");
/** The brand mark for a known stack (`data-brand` names it). */
const brand = (row: Locator): Locator => row.getByTestId("framework-icon");
const header = (page: Page): Locator => page.locator("header");
const footer = (page: Page): Locator => page.locator("footer");
const shownPorts = (page: Page) =>
  options(page).evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-port"))));

/** Opens the strip and waits for the first list: the zombie heads it, the caret is in the input. */
async function openQuick(page: Page): Promise<void> {
  await page.goto("/quick.html");
  await expect(options(page).first()).toHaveAttribute("data-port", "5174");
  await expect(input(page)).toBeFocused();
}

/** Marks `quick:rows` the moment the first row is in the DOM; `main.ts` marks `quick:start` when its script runs. */
function markFirstRows(page: Page): Promise<void> {
  return page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      if (document.querySelector('[role="option"]')) {
        performance.mark("quick:rows");
        observer.disconnect();
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  });
}

/** ms from `main.ts` to the first row, and from navigation start to the first row (which includes fetching the modules). */
function firstPaint(page: Page): Promise<{ sinceScript: number; sinceNavigation: number }> {
  return page.evaluate(() => {
    const rows = performance.getEntriesByName("quick:rows")[0];
    const start = performance.getEntriesByName("quick:start")[0];
    if (!rows || !start) throw new Error("the first-paint marks are missing");
    return { sinceScript: rows.startTime - start.startTime, sinceNavigation: rows.startTime };
  });
}

interface Freed {
  text: string;
  heldMs: number;
}
declare global {
  interface Window {
    __quickFreed?: Promise<Freed>;
  }
}

/**
 * Installs, and waits for the install of, a watcher for a row saying "Freed :<port>". The
 * result lasts 180 ms, which an assertion round-trip can miss, so the browser itself takes the
 * times: `freedResult()` resolves once that row has gone again, with its text and how long it
 * stayed. Call this before Enter; a watcher sent in the same breath as the key can land after it.
 */
async function watchFreed(page: Page, port: number): Promise<void> {
  await page.evaluate((needle) => {
    window.__quickFreed = new Promise<Freed>((resolve) => {
      let text: string | null = null;
      let shownAt = 0;
      const observer = new MutationObserver(() => {
        const hit = [...document.querySelectorAll('[role="option"]')].find((o) =>
          o.textContent?.includes(needle),
        );
        if (hit && text === null) {
          text = hit.textContent ?? "";
          shownAt = performance.now();
        } else if (!hit && text !== null) {
          observer.disconnect();
          resolve({ text, heldMs: performance.now() - shownAt });
        }
      });
      observer.observe(document, { childList: true, subtree: true, characterData: true });
    });
  }, `Freed :${port}`);
}

function freedResult(page: Page): Promise<Freed> {
  return page.evaluate(() => {
    if (!window.__quickFreed) throw new Error("watchFreed() was not called");
    return window.__quickFreed;
  });
}

test("lists rows within 100 ms of load: the lost-terminal zombies first, the newer selected, the header, the footer", async ({
  page,
}, testInfo) => {
  await markFirstRows(page);
  await openQuick(page);
  const cold = await firstPaint(page);
  testInfo.annotations.push({
    type: "first paint (cold)",
    description: `${cold.sinceScript.toFixed(1)} ms after main.ts, ${cold.sinceNavigation.toFixed(0)} ms after navigation`,
  });
  console.log(
    `[quick] first rows: ${cold.sinceScript.toFixed(1)} ms after main.ts, ${cold.sinceNavigation.toFixed(0)} ms after navigation (cold)`,
  );
  expect(cold.sinceScript).toBeLessThan(100);

  const zombie = option(page, 5174);
  await expect(zombie).toHaveAttribute("aria-selected", "true");
  await expect(zombie.getByLabel("lost terminal")).toHaveText("⚡");
  await expect(zombie).toContainText("tinyrecipe-lp");
  await expect(zombie).toContainText("↩ free");
  await expect(status(zombie)).toHaveText("Zombie");
  await expect(status(zombie)).toHaveAttribute("data-status", "zombie");
  await expect(brand(zombie)).toHaveAttribute("data-brand", "Vite");
  // The older zombie is second; then the dev servers newest first; nothing protected.
  expect(await shownPorts(page)).toEqual([5174, 4000, 5173, 3000, 8080, 9335]);
  await expect(option(page, 4000).getByLabel("lost terminal")).toHaveText("⚡");
  await expect(option(page, 4000)).toContainText("legacy-docs");
  await expect(status(option(page, 4000))).toHaveText("Zombie");
  await expect(brand(option(page, 4000))).toHaveAttribute("data-brand", "Jekyll");
  await expect(option(page, 3000).getByLabel("lost terminal")).toHaveCount(0);
  // A plain running dev server has no pill; the one bound to 0.0.0.0 is Public; chrome-helper has neither a mark nor a pill.
  await expect(status(option(page, 3000))).toHaveCount(0);
  await expect(status(option(page, 8080))).toHaveText("Public");
  await expect(brand(option(page, 8080))).toHaveAttribute("data-brand", "NestJS");
  await expect(status(option(page, 9335))).toHaveCount(0);
  await expect(brand(option(page, 9335))).toHaveCount(0);
  await expect(option(page, 5432)).toHaveCount(0);
  await expect(header(page)).toHaveText("PortReaper · 11 ports · ⌘⇧K");
  await expect(footer(page)).toHaveText("↑↓ choose · ↩ free · ⌥↩ force · esc close");

  // Warm: a reload paints the cached list before its first poll answers.
  await page.reload();
  await expect(options(page).first()).toHaveAttribute("data-port", "5174");
  const warm = await firstPaint(page);
  testInfo.annotations.push({
    type: "first paint (warm, from the session cache)",
    description: `${warm.sinceScript.toFixed(1)} ms after main.ts, ${warm.sinceNavigation.toFixed(0)} ms after navigation`,
  });
  console.log(
    `[quick] first rows: ${warm.sinceScript.toFixed(1)} ms after main.ts, ${warm.sinceNavigation.toFixed(0)} ms after navigation (warm)`,
  );
  expect(warm.sinceScript).toBeLessThan(100);
});

test("typing 3 lists the 3000-prefixed ports, :3000 first; Enter frees it, says so, and the query clears within 500 ms", async ({
  page,
}, testInfo) => {
  await openQuick(page);

  await page.keyboard.type("3");
  await expect(input(page)).toHaveValue("3");
  const target = option(page, 3000);
  await expect(target).toHaveAttribute("aria-selected", "true");
  const ports = await shownPorts(page);
  expect(ports[0]).toBe(3000);
  expect(ports.every((p) => String(p).startsWith("3"))).toBe(true);
  await expect(target).toContainText("node");
  await expect(target).toContainText("48213");
  await expect(target).toContainText("shop-api");
  await expect(target).toContainText("feature/cart");
  await expect(target).toContainText("↩ free");
  await expect(status(target)).toHaveCount(0);
  await expect(brand(target)).toHaveAttribute("data-brand", "Next.js");

  await watchFreed(page, 3000);
  await page.keyboard.press("Enter");
  const result = await freedResult(page);
  expect(result.text).toContain("Freed :3000 · node (48213)");
  testInfo.annotations.push({ type: "result row held", description: `${result.heldMs.toFixed(0)} ms` });
  console.log(`[quick] result row held ${result.heldMs.toFixed(0)} ms`);
  expect(result.heldMs).toBeGreaterThanOrEqual(150);
  expect(result.heldMs).toBeLessThan(500);

  // The strip is done: the query is clear and :3000 is gone. `hideCurrentWindow()` is a no-op
  // here, so the strip stays, the zombie heads it again and the caret is still in the input.
  await expect(input(page)).toHaveValue("", { timeout: 500 });
  await expect(option(page, 3000)).toHaveCount(0);
  await expect(options(page).first()).toHaveAttribute("data-port", "5174");
  await expect(input(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
});

test("a protected port asks once more; the second Enter frees every port of that pid", async ({ page }) => {
  await openQuick(page);

  await page.keyboard.type("5432");
  const docker = option(page, 5432);
  await expect(options(page)).toHaveCount(1);
  await expect(docker).toHaveAttribute("aria-selected", "true");
  await expect(status(docker)).toHaveText("Protected");
  await expect(status(docker)).toHaveAttribute("data-status", "protected");
  await expect(brand(docker)).toHaveAttribute("data-brand", "PostgreSQL");

  await page.keyboard.press("Enter");
  await expect(docker).toContainText("This is Docker (com.docker.backend). Press Enter again to kill it.");
  await expect(docker).toContainText("↩ kill");
  await expect(options(page)).toHaveCount(1);

  await watchFreed(page, 5432);
  await page.keyboard.press("Enter");
  expect((await freedResult(page)).text).toContain("Freed :5432 · com.docker.backend (11710)");
  await expect(input(page)).toHaveValue("", { timeout: 500 });

  // The same pid held :6379 in the mock; the core took both.
  await page.keyboard.type("6379");
  await expect(page.getByText("Nothing on :6379", { exact: true })).toBeVisible();
  await expect(options(page)).toHaveCount(0);
});

test("Esc clears a query; on an empty query it is a no-op in the browser and the strip stays", async ({
  page,
}) => {
  const thrown: string[] = [];
  page.on("pageerror", (err) => thrown.push(err.message));
  await openQuick(page);

  // `vite` is in two command lines (portreaper and tinyrecipe-lp); a query ranks by port, not by zombie.
  await page.keyboard.type("vite");
  await expect.poll(() => shownPorts(page)).toEqual([5173, 5174]);
  await page.keyboard.press("Escape");
  await expect(input(page)).toHaveValue("");
  await expect(options(page).first()).toHaveAttribute("data-port", "5174");

  // Nothing to hide without Tauri: the strip is still there and still takes keys.
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => "__TAURI_INTERNALS__" in window)).toBe(false);
  await expect(input(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
  await expect(options(page).first()).toHaveAttribute("data-port", "5174");
  await page.keyboard.press("ArrowDown");
  await expect(option(page, 4000)).toHaveAttribute("aria-selected", "true");
  expect(thrown).toEqual([]);
});

test("an ai row's pill carries its memory", async ({ page }) => {
  await openQuick(page);
  // Seventh of seven unprotected entries: not in the pre-selection, one word away.
  await expect(option(page, 11434)).toHaveCount(0);
  await page.keyboard.type("ollama");
  await expect.poll(() => shownPorts(page)).toEqual([11434]);

  const ollama = option(page, 11434);
  await expect(ollama).toHaveAttribute("data-category", "ai");
  await expect(ollama).toHaveAttribute("aria-selected", "true");
  await expect(ollama).toContainText("ollama");
  await expect(ollama).toContainText("32014");
  await expect(status(ollama)).toHaveText("AI · 4.9 GB");
  await expect(status(ollama)).toHaveAttribute("data-status", "ai");
  await expect(brand(ollama)).toHaveAttribute("data-brand", "Ollama");
  await expect(ollama.getByLabel("lost terminal")).toHaveCount(0);
});

test("a named stack without a brand mark gets a soft text pill", async ({ page }) => {
  await openQuick(page);
  // AirPlay (ControlCenter on :7000) is a name the icon set does not know.
  await page.keyboard.type("7000");
  const airplay = option(page, 7000);
  await expect(airplay).toHaveAttribute("aria-selected", "true");
  await expect(brand(airplay)).toHaveCount(0);
  await expect(airplay.locator("[data-framework]")).toHaveText("AirPlay");
  await expect(status(airplay)).toHaveText("Protected");
});

/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WCAG contrast of the Board's token pairs (src/style.css), in the light scheme and in the dark
 * one. AA for small text is 4.5:1. The tokens are read from the two `:root` blocks of the
 * stylesheet, so a palette change shows up here. Also: the components use the tokens' utilities
 * and nothing else (no hex, no Tailwind palette, no `dark:` twins: the scheme is the OS's), and
 * they paint text on a solid colour only in the one pairing these numbers prove.
 */

// Vitest runs from the project root; import.meta.url is rewritten under happy-dom, so anchor on cwd.
const root = process.cwd();
const stylesheet = readFileSync(resolve(root, "src/style.css"), "utf8");
const componentsDir = resolve(root, "src/components");

type Rgb = [number, number, number];
type Rgba = [number, number, number, number];
type Scheme = "light" | "dark";

/** The two `:root { … }` blocks: the first is light, the one inside the media query is dark. */
function block(scheme: Scheme): string {
  const blocks = [...stylesheet.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) => m[1] ?? "");
  const found = blocks[scheme === "light" ? 0 : 1];
  if (!found) throw new Error(`no ${scheme} :root block in src/style.css`);
  return found;
}

/** `--ink-2` in the given scheme as 8-bit sRGB. */
function token(name: string, scheme: Scheme): Rgb {
  const match = block(scheme).match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})\\b`, "i"));
  if (!match?.[1]) throw new Error(`no hex token --${name} in the ${scheme} :root`);
  const hex = match[1].slice(1);
  return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

/** A translucent token, `--sidebar: rgba(232, 232, 236, 0.92)`, as sRGB bytes and an alpha. */
function translucent(name: string, scheme: Scheme): Rgba {
  const match = block(scheme).match(
    new RegExp(`--${name}:\\s*rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([\\d.]+)\\)`, "i"),
  );
  if (!match) throw new Error(`no rgba token --${name} in the ${scheme} :root`);
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
}

/** `top` painted over an opaque `bottom`, rounded to bytes (as e2e/helpers.ts `over` does). */
function over([r, g, b, a]: Rgba, bottom: Rgb): Rgb {
  return [r, g, b].map((c, i) => Math.round(a * c + (1 - a) * (bottom[i] ?? 0))) as Rgb;
}

function parseHex(hex: string): Rgb {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (byte: number) => {
    const c = byte / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const AA = 4.5;
const WHITE: Rgb = [255, 255, 255];
const COLOURS = ["green", "orange", "red", "blue", "purple", "brand"] as const;

describe.each<Scheme>(["light", "dark"])("Board text contrast (%s)", (scheme) => {
  const t = (name: string) => token(name, scheme);

  it("reads the tokens as sRGB", () => {
    // B v3 (#34): the mock-up's canvas #f5f5f7 in light, macOS's #1e1e1e and #262628 in dark.
    expect(t("canvas")).toEqual(scheme === "light" ? [245, 245, 247] : [30, 30, 30]);
    expect(t("surface")).toEqual(scheme === "light" ? [255, 255, 255] : [38, 38, 40]);
  });

  it("ink and ink-2 clear AA on the canvas, the surface and a selected row", () => {
    for (const surface of ["canvas", "surface", "sel", "hover"]) {
      expect(contrast(t("ink"), t(surface)), `ink on ${surface}`).toBeGreaterThanOrEqual(AA);
      expect(contrast(t("ink-2"), t(surface)), `ink-2 on ${surface}`).toBeGreaterThanOrEqual(AA);
    }
  });

  it("ink-3, the tertiary, clears AA too: the section headings, the hints, the status line, the strip's chrome", () => {
    // 11–12 px labels on the canvas (sidebar), the surface (status line, inspector) and a
    // selected row (the strip's "↩ free"). Not on `line`: the quiet counts use ink-2 there.
    for (const surface of ["canvas", "surface", "sel", "hover"]) {
      expect(contrast(t("ink-3"), t(surface)), `ink-3 on ${surface}`).toBeGreaterThanOrEqual(AA);
    }
    expect(contrast(t("ink-2"), t("line")), "ink-2 on line (the quiet counts)").toBeGreaterThanOrEqual(AA);
    expect(
      contrast(t("ink-2"), t("orange-tint")),
      "ink-2 on orange-tint (the armed hint)",
    ).toBeGreaterThanOrEqual(AA);
  });

  it("every <c>-ink clears AA on its <c>-tint: the pills, the cards, the badges, the sidebar alarms, Reap", () => {
    for (const c of COLOURS) {
      expect(contrast(t(`${c}-ink`), t(`${c}-tint`)), `${c}-ink on ${c}-tint`).toBeGreaterThanOrEqual(AA);
    }
  });

  it("every <c>-ink clears AA on the surface and the canvas: Kill, the inspector's red address, the tree's leaf", () => {
    for (const c of COLOURS) {
      expect(contrast(t(`${c}-ink`), t("surface")), `${c}-ink on surface`).toBeGreaterThanOrEqual(AA);
      expect(contrast(t(`${c}-ink`), t("canvas")), `${c}-ink on canvas`).toBeGreaterThanOrEqual(AA);
    }
  });

  it("the surface on every <c>-ink clears AA: the filled Kill, Kill anyway, Update, the active badge", () => {
    // The one way to put text on a solid colour. In the light scheme the surface is white on a
    // dark ink; in the dark one it is the dark surface on a light ink. White itself is 1.4–2.3:1
    // on the dark inks, which is why the components say `text-surface`, never `text-white`.
    for (const c of COLOURS) {
      expect(contrast(t("surface"), t(`${c}-ink`)), `surface on ${c}-ink`).toBeGreaterThanOrEqual(AA);
    }
  });

  it("white on the brand clears 3:1: the switch's thumb on a checked toggle (not text) and the selection bar", () => {
    expect(contrast(WHITE, t("brand"))).toBeGreaterThanOrEqual(3);
  });
});

describe("the gaps WP-15 left, closed by WP-19", () => {
  it("light orange-ink clears AA on orange-tint and on the surface (#9A6012: 4.76:1 and 5.18:1)", () => {
    expect(contrast(token("orange-ink", "light"), token("orange-tint", "light"))).toBeGreaterThanOrEqual(AA);
    expect(contrast(token("orange-ink", "light"), token("surface", "light"))).toBeGreaterThanOrEqual(AA);
  });

  it("light ink-3 clears AA on the surface and the canvas (#626266: 6.07:1 and 5.58:1); dark too (#98989D: 5.26:1 and 5.81:1)", () => {
    for (const scheme of ["light", "dark"] as const) {
      expect(
        contrast(token("ink-3", scheme), token("surface", scheme)),
        `${scheme} surface`,
      ).toBeGreaterThanOrEqual(AA);
      expect(
        contrast(token("ink-3", scheme), token("canvas", scheme)),
        `${scheme} canvas`,
      ).toBeGreaterThanOrEqual(AA);
    }
  });

  it("white on the five solid pill colours still does not clear AA (1.9–4.1:1 light, 1.9–3.2:1 dark): the pills are tint + ink", () => {
    // The tokens did not move; the pills did. The rule below keeps white off the solids.
    for (const scheme of ["light", "dark"] as const) {
      for (const c of ["green", "orange", "red", "blue", "purple"] as const) {
        expect(contrast(WHITE, token(c, scheme)), `white on ${c} (${scheme})`).toBeLessThan(AA);
      }
    }
  });
});

describe("the B v3 tokens (#34, spec item 1)", () => {
  it("light takes the mock-up's neutrals and coral, except the greys that fail AA", () => {
    const light = (name: string) => token(name, "light");
    expect(light("canvas")).toEqual(parseHex("#f5f5f7"));
    expect(light("surface")).toEqual(parseHex("#ffffff"));
    expect(light("line")).toEqual(parseHex("#e8e8ed"));
    expect(light("line-strong")).toEqual(parseHex("#d2d2d7"));
    expect(light("ink")).toEqual(parseHex("#1d1d1f"));
    expect(light("band")).toEqual(parseHex("#fafafa"));
    expect(light("row-line")).toEqual(parseHex("#f0f0f3"));
    expect(light("sidebar-edge")).toEqual(parseHex("#dcdce0"));
    expect(light("brand")).toEqual(parseHex("#ff4528"));
    expect(translucent("sidebar", "light")).toEqual([232, 232, 236, 0.92]);
    expect(translucent("sel-neutral", "light")).toEqual([0, 0, 0, 0.07]);
    expect(translucent("sel-neutral", "dark")).toEqual([255, 255, 255, 0.08]);
  });

  it("dark takes macOS's dark neutrals and keeps today's status inks", () => {
    const dark = (name: string) => token(name, "dark");
    expect(dark("canvas")).toEqual(parseHex("#1e1e1e"));
    expect(dark("surface")).toEqual(parseHex("#262628"));
    expect(dark("line")).toEqual(parseHex("#38383a"));
    expect(dark("ink")).toEqual(parseHex("#f5f5f7"));
    expect(dark("ink-2")).toEqual(parseHex("#a1a1a6"));
    expect(dark("ink-3")).toEqual(parseHex("#98989d"));
    const inks = { green: "#7fe8b8", orange: "#ffd089", red: "#ff9aa8", blue: "#a9ccff", purple: "#d6b6ff" };
    for (const [c, value] of Object.entries(inks)) expect(dark(`${c}-ink`), c).toEqual(parseHex(value));
  });

  it("the mock-up's greys fail AA where they sit, which is why the built ones are darker in light", () => {
    // The spec's table (estimated on #e8e8ec), here on the sidebar as it paints: rgba over the canvas.
    const sidebar = over(translucent("sidebar", "light"), token("canvas", "light"));
    const surface = token("surface", "light");
    for (const [what, grey, on] of [
      ["labels (ink-2)", "#6e6e73", sidebar],
      ["counts (ink-3)", "#8e8e93", sidebar],
      ["section headings", "#9a9aa0", sidebar],
      ["shortcut hints", "#aeaeb2", sidebar],
      ["ink-3 on white", "#8e8e93", surface],
    ] as const) {
      expect(contrast(parseHex(grey), on), what).toBeLessThan(AA);
    }
    expect(contrast(WHITE, token("brand", "light")), "white on #ff4528").toBeLessThan(AA);
  });

  describe.each<Scheme>(["light", "dark"])("%s", (scheme) => {
    const t = (name: string) => token(name, scheme);
    // The sidebar is translucent over the window's canvas; an item's fill is translucent over the sidebar.
    const sidebar = () => over(translucent("sidebar", scheme), t("canvas"));
    const hovered = () => over(translucent("sidebar-hover", scheme), sidebar());
    const selected = () => over(translucent("sel-neutral", scheme), sidebar());

    it("the sidebar: labels, counts, headings and ⌘ hints clear AA on it and on a hovered item", () => {
      for (const [name, on] of [
        ["sidebar", sidebar()],
        ["a hovered item", hovered()],
      ] as const) {
        expect(contrast(t("ink"), on), `ink on ${name}`).toBeGreaterThanOrEqual(AA);
        expect(contrast(t("ink-2"), on), `ink-2 (labels) on ${name}`).toBeGreaterThanOrEqual(AA);
        expect(contrast(t("ink-3"), on), `ink-3 (counts, headings, hints) on ${name}`).toBeGreaterThanOrEqual(
          AA,
        );
      }
    });

    it("the selected item: ink text, and ink-2 on its count and hint, clear AA on the neutral fill", () => {
      expect(contrast(t("ink"), selected()), "ink on the selected item").toBeGreaterThanOrEqual(AA);
      expect(contrast(t("ink-2"), selected()), "ink-2 on the selected item").toBeGreaterThanOrEqual(AA);
    });

    it("the update banner keeps brand ink on the brand tint, and the edge sits apart from the sidebar", () => {
      expect(contrast(t("brand-ink"), t("brand-tint"))).toBeGreaterThanOrEqual(AA);
      expect(t("sidebar-edge")).not.toEqual(sidebar());
    });

    it("ink, ink-2 and ink-3 clear AA on the band (table header, group rows)", () => {
      for (const ink of ["ink", "ink-2", "ink-3"]) {
        expect(contrast(t(ink), t("band")), `${ink} on band`).toBeGreaterThanOrEqual(AA);
      }
    });

    it("the selected row's fill takes its text at 4.5:1 or more (white in both schemes)", () => {
      expect(t("on-sel-fill")).toEqual(WHITE);
      expect(contrast(t("on-sel-fill"), t("sel-fill"))).toBeGreaterThanOrEqual(AA);
      // About #d63a20 in light (4.7:1); in dark the coral nearest #ff5a3f that clears AA.
      if (scheme === "light") expect(t("sel-fill")).toEqual(parseHex("#d63a20"));
    });
  });
});

describe("the components", () => {
  const iconsDir = resolve(componentsDir, "icons");
  const files = [componentsDir, iconsDir].flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".vue"))
      .map((f) => resolve(dir, f)),
  );
  files.push(resolve(root, "src/App.vue"), resolve(root, "src/quick/QuickApp.vue"));

  it("use tokens only: no hex, no Tailwind palette, no light-mode twins", () => {
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      // The app mark (AppMark.vue) is an inline SVG with a black-and-white mask: not a colour choice.
      // Its colours come from lib/app-icon.ts, which only AppMark.vue imports (AppMark.test.ts).
      const withoutMask = source.replace(/<mask[\s\S]*?<\/mask>/g, "");
      expect(withoutMask, `${file} has a hex colour`).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(source, `${file} uses the Tailwind palette`).not.toMatch(
        /\b(?:bg|text|border|ring|from|to|shadow)-(?:neutral|gray|zinc|slate|stone|red|rose|orange|amber|yellow|green|emerald|blue|cyan|purple|violet|indigo|white|black)-\d/,
      );
      expect(source, `${file} has a dark: variant`).not.toMatch(/\bdark:/);
    }
  });

  it("paint no white text; text on a solid colour is the surface on a <c>-ink", () => {
    // The app mark draws its own colours (AppMark.vue), so no component paints `text-white`.
    // Every filled control says `text-surface`, and only on a `bg-<c>-ink` (the pairing the token
    // tests prove in both schemes); the five solid colours carry no text at all.
    const quoted = /"([^"]*)"|'([^']*)'/g;
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file} paints text-white`).not.toMatch(/\btext-white\b/);
      for (const m of source.matchAll(quoted)) {
        const classes = m[1] ?? m[2] ?? "";
        if (/(?:^|[\s:])text-surface\b/.test(classes)) {
          expect(classes, `${file}: "${classes}" has text-surface without a bg-<c>-ink`).toMatch(
            /\bbg-(?:green|orange|red|blue|purple|brand)-ink\b/,
          );
        }
        // An unprefixed fill only: `before:bg-red` is the toast's 3 px bar, `hover:bg-red-ink` a fill with its ink.
        if (/(?<![\w:-])bg-(?:green|orange|red|blue|purple)(?![-\w])/.test(classes)) {
          expect(classes, `${file}: "${classes}" puts text on a solid colour`).not.toMatch(
            /\btext-(?:white|black|surface|canvas|ink(?:-\d)?|(?:green|orange|red|blue|purple|brand)(?:-ink|-tint)?)\b/,
          );
        }
      }
    }
  });

  it("no longer use the v0.2 alias names", () => {
    const aliases =
      /\b(?:bg-void|bg-obsidian|bg-steel|border-edge|text-ink-muted|text-ink-faint|text-coral|bg-coral|amber-neon|emerald-signal|azure|violet)\b/;
    for (const file of [...files, resolve(root, "src/lib/table-columns.ts")]) {
      expect(readFileSync(file, "utf8"), `${file} uses an alias`).not.toMatch(aliases);
    }
  });
});

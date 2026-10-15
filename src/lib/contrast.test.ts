/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WCAG contrast of the Board's token pairs (src/style.css), in the light scheme and in the dark
 * one. AA for small text is 4.5:1. The tokens are read from the two `:root` blocks of the
 * stylesheet, so a palette change shows up here. Also: the components use the tokens' utilities
 * and nothing else (no hex, no Tailwind palette, no `dark:` twins: the scheme is the OS's).
 */

// Vitest runs from the project root; import.meta.url is rewritten under happy-dom, so anchor on cwd.
const root = process.cwd();
const stylesheet = readFileSync(resolve(root, "src/style.css"), "utf8");
const componentsDir = resolve(root, "src/components");

type Rgb = [number, number, number];
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
    expect(t("canvas")).toEqual(scheme === "light" ? [245, 246, 248] : [28, 28, 31]);
    expect(t("surface")).toEqual(scheme === "light" ? [255, 255, 255] : [35, 35, 39]);
  });

  it("ink and ink-2 clear AA on the canvas, the surface and a selected row", () => {
    for (const surface of ["canvas", "surface", "sel", "hover"]) {
      expect(contrast(t("ink"), t(surface)), `ink on ${surface}`).toBeGreaterThanOrEqual(AA);
      expect(contrast(t("ink-2"), t(surface)), `ink-2 on ${surface}`).toBeGreaterThanOrEqual(AA);
    }
  });

  it("ink-3 is the tertiary: labels and hints, never data", () => {
    // 11 px uppercase headings, placeholders, counts: 3:1 is what it reaches on the surface.
    expect(contrast(t("ink-3"), t("surface"))).toBeGreaterThanOrEqual(3);
  });

  it("every <c>-ink clears AA on its <c>-tint: the cards, the badges, the sidebar alarms, Reap", () => {
    for (const c of COLOURS) {
      // The foundation's light orange-ink (#B5731A on #FFF4E3) is 3.55:1; see the test below.
      if (scheme === "light" && c === "orange") continue;
      expect(contrast(t(`${c}-ink`), t(`${c}-tint`)), `${c}-ink on ${c}-tint`).toBeGreaterThanOrEqual(AA);
    }
  });

  it("every <c>-ink clears AA on the surface: Kill, the inspector's red address, the tree's leaf", () => {
    for (const c of COLOURS) {
      // Light orange-ink is 3.87:1 on white: see the known gaps below. It carries only the
      // 15 px semibold port number after a collision, nothing smaller.
      if (scheme === "light" && c === "orange") continue;
      expect(contrast(t(`${c}-ink`), t("surface")), `${c}-ink on surface`).toBeGreaterThanOrEqual(AA);
      expect(contrast(t(`${c}-ink`), t("canvas")), `${c}-ink on canvas`).toBeGreaterThanOrEqual(AA);
    }
  });

  it("white on the brand clears 3:1: the sidebar badge, 11 px bold on the selected item", () => {
    expect(contrast(WHITE, t("brand"))).toBeGreaterThanOrEqual(3);
  });
});

describe("known gaps in the foundation's tokens (WP-15), kept visible here", () => {
  // Both flip to a plain `it` the day the tokens change: an `it.fails` that passes fails the run.
  it.fails("light orange-ink clears AA on orange-tint and on the surface (3.55:1 and 3.87:1; #9A6012 would)", () => {
    expect(contrast(token("orange-ink", "light"), token("orange-tint", "light"))).toBeGreaterThanOrEqual(AA);
    expect(contrast(token("orange-ink", "light"), token("surface", "light"))).toBeGreaterThanOrEqual(AA);
  });

  it.fails("white on the five solid pill colours clears AA (1.9–4.1:1 light, 1.7–3.3:1 dark)", () => {
    for (const scheme of ["light", "dark"] as const) {
      for (const c of ["green", "orange", "red", "blue", "purple"] as const) {
        expect(contrast(WHITE, token(c, scheme)), `white on ${c} (${scheme})`).toBeGreaterThanOrEqual(AA);
      }
    }
  });
});

describe("the components", () => {
  const files = readdirSync(componentsDir)
    .filter((f) => f.endsWith(".vue"))
    .map((f) => resolve(componentsDir, f));
  files.push(resolve(root, "src/App.vue"));

  it("use tokens only: no hex, no Tailwind palette, no light-mode twins", () => {
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      // The sidebar's brand mark is an inline SVG with a black-and-white mask: not a colour choice.
      const withoutMask = source.replace(/<mask[\s\S]*?<\/mask>/g, "");
      expect(withoutMask, `${file} has a hex colour`).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(source, `${file} uses the Tailwind palette`).not.toMatch(
        /\b(?:bg|text|border|ring|from|to|shadow)-(?:neutral|gray|zinc|slate|stone|red|rose|orange|amber|yellow|green|emerald|blue|cyan|purple|violet|indigo|white|black)-\d/,
      );
      expect(source, `${file} has a dark: variant`).not.toMatch(/\bdark:/);
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

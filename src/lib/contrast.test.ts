/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WCAG contrast of the Cyber Scythe token pairs (src/style.css, dark only) that the rows, the
 * tiles, the drawer and the feed use for text. AA for small text is 4.5:1. The tokens are read
 * from the stylesheet so a palette change shows up here.
 */

// Vitest runs from the project root; import.meta.url is rewritten under happy-dom, so anchor on cwd.
const root = process.cwd();
const stylesheet = readFileSync(resolve(root, "src/style.css"), "utf8");
const componentsDir = resolve(root, "src/components");
const component = (name: string) => readFileSync(resolve(componentsDir, name), "utf8");

type Rgb = [number, number, number];

/** `--color-ink-muted` as 8-bit sRGB. */
function token(name: string): Rgb {
  const match = stylesheet.match(new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})\\b`, "i"));
  if (!match?.[1]) throw new Error(`no hex token --color-${name} in src/style.css`);
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

/** `top` at `alpha` over an opaque `bottom`: a tinted badge background. */
function over(top: Rgb, alpha: number, bottom: Rgb): Rgb {
  return top.map((t, i) => Math.round(alpha * t + (1 - alpha) * (bottom[i] as number))) as Rgb;
}

const AA = 4.5;

describe("Cyber Scythe text contrast", () => {
  const void_ = token("void");
  const obsidian = token("obsidian");
  const steel = token("steel");
  const ink = token("ink");
  const inkMuted = token("ink-muted");
  const inkFaint = token("ink-faint");
  const signals = {
    coral: token("coral"),
    "amber-neon": token("amber-neon"),
    "emerald-signal": token("emerald-signal"),
    azure: token("azure"),
    violet: token("violet"),
  };

  it("reads the tokens as sRGB", () => {
    expect(void_).toEqual([10, 11, 14]);
    expect(inkMuted).toEqual([163, 167, 176]);
  });

  it("ink and ink-muted clear AA on every surface: the rows, the tiles, the group band, the drawer", () => {
    for (const surface of [void_, obsidian, steel]) {
      expect(contrast(ink, surface)).toBeGreaterThanOrEqual(AA);
      expect(contrast(inkMuted, surface)).toBeGreaterThanOrEqual(AA);
    }
  });

  it("every signal clears AA as text on its tinted badge and on the plain surfaces", () => {
    // Where a badge sits: the window ground, a panel, and a selected row (steel at 60 % over void).
    const selectedRow = over(steel, 0.6, void_);
    for (const [name, colour] of Object.entries(signals)) {
      for (const surface of [void_, obsidian, steel]) {
        expect(contrast(colour, surface), `${name} on surface`).toBeGreaterThanOrEqual(AA);
      }
      // The badges: the signal tinted over the surface, the signal as text. Coral is the darkest
      // signal, so its badges are tinted at 10 %; the others at 15 %.
      const tint = name === "coral" ? 0.1 : 0.15;
      for (const surface of [void_, obsidian, selectedRow]) {
        expect(contrast(colour, over(colour, tint, surface)), `${name} on its badge`).toBeGreaterThanOrEqual(
          AA,
        );
      }
    }
    // Void ink on a coral fill: the Kill button when hovered, the brand mark, the confirm's action.
    expect(contrast(void_, signals.coral)).toBeGreaterThanOrEqual(AA);
  });

  it("ink-faint does not clear AA on the surfaces, so no row, tile or feed text uses it", () => {
    expect(contrast(inkFaint, void_)).toBeLessThan(AA);
    for (const file of [
      "PortRow.vue",
      "ProjectGroup.vue",
      "StatsBar.vue",
      "TasklineView.vue",
      "ProcessDrawer.vue",
    ]) {
      expect(component(file), `${file} uses text-ink-faint`).not.toMatch(/text-ink-faint/);
    }
  });

  it("the components use tokens only: no hex, no Tailwind palette, no light-mode twins", () => {
    const files = readdirSync(componentsDir).filter((f) => f.endsWith(".vue"));
    files.push("../App.vue");
    for (const file of files) {
      const source = readFileSync(resolve(componentsDir, file), "utf8");
      expect(source, `${file} has a hex colour`).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(source, `${file} uses the Tailwind palette`).not.toMatch(
        /\b(?:bg|text|border|ring|from|to|shadow)-(?:neutral|gray|zinc|slate|stone|red|rose|orange|amber|yellow|green|emerald|blue|cyan|purple|violet|indigo|white|black)-\d/,
      );
      expect(source, `${file} has a dark: variant`).not.toMatch(/\bdark:/);
    }
  });
});

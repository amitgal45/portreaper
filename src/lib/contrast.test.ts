/// <reference types="node" />
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WCAG contrast of the token pairs the rows and group headers use for secondary text (pid, memory,
 * uptime, branch, tool chip). Tailwind 4 defines its palette in oklch; the values are read from the
 * installed theme so a palette change shows up here. AA for small text is 4.5:1.
 */

// Vitest runs from the project root; import.meta.url is rewritten under happy-dom, so anchor on cwd.
const root = process.cwd();
const theme = readFileSync(
  createRequire(resolve(root, "package.json")).resolve("tailwindcss/theme.css"),
  "utf8",
);
const component = (name: string) => readFileSync(resolve(root, "src/components", name), "utf8");

type Rgb = [number, number, number];

/** `--color-neutral-400` as 8-bit sRGB. */
function token(name: string): Rgb {
  const match = theme.match(new RegExp(`--color-${name}:\\s*([^;]+);`));
  if (!match?.[1]) throw new Error(`no token --color-${name} in tailwindcss/theme.css`);
  return parse(match[1].trim());
}

function parse(value: string): Rgb {
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex?.[1]) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as Rgb;
  }
  const oklch = value.match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+|none)\s*\)$/);
  if (!oklch) throw new Error(`cannot parse colour ${value}`);
  const L = Number(oklch[1]) / (oklch[2] ? 100 : 1);
  const C = Number(oklch[3]);
  const h = oklch[4] === "none" ? 0 : (Number(oklch[4]) * Math.PI) / 180;
  return oklabToRgb(L, C * Math.cos(h), C * Math.sin(h));
}

/** Oklab → linear sRGB → 8-bit sRGB (Björn Ottosson's matrices). */
function oklabToRgb(L: number, a: number, b: number): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return linear.map((c) => {
    const clamped = Math.min(1, Math.max(0, c));
    const gamma = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(gamma * 255);
  }) as Rgb;
}

/** `top` at `alpha` painted over an opaque `bottom`, as the browser composites (in sRGB). */
function over(top: Rgb, alpha: number, bottom: Rgb): Rgb {
  return top.map((c, i) => Math.round(alpha * c + (1 - alpha) * (bottom[i] as number))) as Rgb;
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

describe("secondary text contrast", () => {
  const white = token("white");
  const n50 = token("neutral-50");
  const n400 = token("neutral-400");
  const n500 = token("neutral-500");
  const n800 = token("neutral-800");
  const n900 = token("neutral-900");

  it("reads the palette as sRGB", () => {
    expect(n400).toEqual([161, 161, 161]);
    expect(n900).toEqual([23, 23, 23]);
    expect(white).toEqual([255, 255, 255]);
  });

  it("dark: neutral-400 on the row surface (neutral-900) and on the group band (neutral-800)", () => {
    expect(contrast(n400, n900)).toBeGreaterThanOrEqual(AA);
    expect(contrast(n400, n800)).toBeGreaterThanOrEqual(AA);
    // The pair WP-3 shipped, which WP-7 measured below AA: the reason for the change.
    expect(contrast(n500, n900)).toBeLessThan(AA);
  });

  it("light: neutral-500 on white rows and on the neutral-50 group band", () => {
    expect(contrast(n500, white)).toBeGreaterThanOrEqual(AA);
    expect(contrast(n500, n50)).toBeGreaterThanOrEqual(AA);
  });

  it("every text-neutral-500 in the row and the group header has its dark twin", () => {
    for (const file of ["PortRow.vue", "ProjectGroup.vue"]) {
      const source = component(file);
      // Inside one quoted class string, text-neutral-500 must be followed by dark:text-neutral-400.
      const orphan = /text-neutral-500(?![^"'`]*dark:text-neutral-400)/;
      expect(source, `${file}: text-neutral-500 without dark:text-neutral-400`).not.toMatch(orphan);
    }
  });
});

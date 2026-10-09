// Builds every icon from the SVG sources in design/. Run it as `pnpm icons`.
//
//   1. design/icon.svg -> src-tauri/icons/source-1024.png            (@resvg/resvg-js)
//      design/tray.svg -> src-tauri/icons/tray-22.png, tray-44.png    (menu bar, 1x and 2x)
//   2. `tauri icon src-tauri/icons/source-1024.png`: every size, icon.icns, icon.ico, the
//      Windows Square*Logo set, plus android/ and ios/ sets.
//   3. Remove android/ and ios/ (PortReaper builds neither) and rewrite icon.icns with its
//      chunks in a fixed order (the Tauri CLI emits them in hash-map order, so the bytes differ
//      on every run even though the content does not).
//
// Pure JavaScript plus the Tauri CLI already in devDependencies: no Inkscape, no rsvg-convert.
// The output is byte-for-byte reproducible: a second run changes no tracked file.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src-tauri", "icons");
const source = join(outDir, "source-1024.png");

/** Renders one SVG to a square PNG of `size` px and asserts the result before writing it. */
function render(svgPath, size, outName) {
  const svg = readFileSync(join(root, svgPath), "utf8");
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    // The sources contain no text; skip the system font scan (faster, and no machine-dependent output).
    font: { loadSystemFonts: false },
  });
  const image = resvg.render();
  if (image.width !== size || image.height !== size) {
    throw new Error(`${svgPath}: expected ${size}x${size}, got ${image.width}x${image.height}`);
  }
  writeFileSync(join(outDir, outName), image.asPng());
  console.log(`${svgPath} -> ${outName} (${size}x${size})`);
}

/** Runs the Tauri CLI from node_modules/.bin so this works without pnpm on the PATH. */
function tauriIcon() {
  const bin = join(root, "node_modules", ".bin", process.platform === "win32" ? "tauri.cmd" : "tauri");
  const result = spawnSync(bin, ["icon", source], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`tauri icon failed (${result.status ?? result.error?.message})`);
  }
}

/**
 * Rewrites an .icns file with its chunks sorted by type. The format is a header ("icns" plus the
 * total length, both 4 bytes, length big-endian) followed by chunks of 4-byte type, 4-byte
 * length (including these 8 bytes) and the data. Readers find chunks by type, so the order is
 * free; fixing it makes the file reproducible.
 */
function canonicaliseIcns(path) {
  const buf = readFileSync(path);
  if (buf.toString("latin1", 0, 4) !== "icns" || buf.readUInt32BE(4) !== buf.length) {
    throw new Error(`${path}: not an icns file`);
  }
  const chunks = [];
  for (let off = 8; off < buf.length; ) {
    const length = buf.readUInt32BE(off + 4);
    if (length < 8 || off + length > buf.length) throw new Error(`${path}: bad chunk at ${off}`);
    chunks.push(buf.subarray(off, off + length));
    off += length;
  }
  chunks.sort((a, b) => a.toString("latin1", 0, 4).localeCompare(b.toString("latin1", 0, 4)));
  const header = Buffer.alloc(8);
  header.write("icns", 0, "latin1");
  header.writeUInt32BE(buf.length, 4);
  writeFileSync(path, Buffer.concat([header, ...chunks]));
  console.log(`icon.icns: ${chunks.length} chunks in canonical order`);
}

mkdirSync(outDir, { recursive: true });
// `tauri icon` needs a square PNG of at least 1024 px.
render("design/icon.svg", 1024, "source-1024.png");
render("design/tray.svg", 22, "tray-22.png");
render("design/tray.svg", 44, "tray-44.png");

tauriIcon();

for (const unused of ["android", "ios"]) {
  const dir = join(outDir, unused);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    console.log(`removed ${unused}/ (not built)`);
  }
}
canonicaliseIcns(join(outDir, "icon.icns"));

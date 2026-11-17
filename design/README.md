# Prismatic Cut Socket

PortReaper's identity from v0.5 on (v0.2–v0.4 were "Cyber Scythe", one coral glyph). The idea is
unchanged: **a port is a socket, and freeing it is one clean sweep.** The icon is that socket,
cut in two by the arc of a scythe. What v0.5 adds is light: the cut now separates two colours,
the warm piece that was swept and the cool piece that stays, and the socket's opening is a pane
of glass. Still no skull, no blade, no text.

## Colours

The app's tokens live in `src/style.css` (`:root`, flipped for dark by `prefers-color-scheme`);
components use the Tailwind utilities, never a hex. The icon uses five fixed colours:

| name | hex | where |
|---|---|---|
| Tactical Obsidian | `#121316` | the default plate, and the plate of the in-app mark |
| Void Black | `#0A0B0E` | the dark plate |
| Neon Amber → Signal Coral | `#FF9A3C` → `#FF4528` | the left piece, the one the cut swept |
| Azure → Violet | `#4EA1FF` → `#A78BFA` | the right piece |

Coral is still the app's `--brand` (the kill, the selection, destructive buttons); the icon is
the one place it shares the stage.

## The icon

All five sources share one geometry, 1024 px on Apple's grid (824 px plate, 100 px margin,
radius 185): the face of an Ethernet socket as a bold ring (96 px wall, 24 px outer corners,
sharp hollow) with the latch tab below, cut by one 88 px quadratic arc from (388,892) to
(636,132) that bows toward the upper-left. The left piece is the glyph clipped left of the arc's
centreline, the right piece the rest; the cut mask opens the gap between them.

- `icon.svg`: the app icon, default appearance. Obsidian plate a touch lighter at the top, 2 px
  hairline, a faint glow, the glyph's bloom (blur 28, 55 %), the glass panel in the opening, then
  the two pieces. `pnpm icons` renders it.
- `icon-dark.svg`: the dark appearance. Void Black plate, deeper bloom (blur 36, 80 %) and glow,
  brighter hairline.
- `icon-tinted.svg`: the tinted / clear appearance as macOS draws it: the glyph in one colour on
  a slate plate, no gradients, no bloom. A preview.
- `glyph.svg`: the glyph alone, white on transparent: the single-colour layer for macOS 26's
  tinted and clear appearances.
- `tray.svg`: the glyph for the menu bar, black on transparent, a touch lighter (84 px wall and
  cut); macOS treats it as a template image and tints it itself.
- `src/components/BrandMark.vue`: the icon in small for the window and the ⌘⇧K strip: plate,
  glass, the two pieces, no bloom.

`pnpm icons` renders `icon.svg` and `tray.svg` into `src-tauri/icons/` (every size, `.icns`,
`.ico`, the Windows set, the two tray PNGs) and is byte-reproducible. Never edit the PNGs by hand.

The legibility test is `src-tauri/icons/32x32.png`: two brackets with a diagonal gap, one warm,
one cool. At 16 px it is a ring with a gap. If a change loses the gap, the change is wrong.

## Appearances

macOS 26 shows a dark and a tinted icon when the app ships them, from an Icon Composer `.icon`
file compiled into the bundle's `Assets.car`. Tauri bundles one `.icns`, so today every
appearance shows `icon.svg`. `icon-dark.svg`, `icon-tinted.svg` and `glyph.svg` are the inputs
for that `.icon` file, which has to be made in Icon Composer and built with Xcode's `actool` on a
Mac.

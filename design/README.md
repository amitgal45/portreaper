# Prismatic Cut Socket

PortReaper's identity from v0.5 on (v0.2–v0.4 were "Cyber Scythe", one coral glyph). The idea is
unchanged: **a port is a socket, and freeing it is one clean sweep.** The icon is that socket,
cut in two by the arc of a scythe. What v0.5 adds is light: the cut now separates two colours,
the warm piece that was swept and the cool piece that stays, and the socket's opening is a pane
of glass. Still no skull, no blade, no text.

## Colours

The app's tokens live in `src/style.css` (`:root`, flipped for dark by `prefers-color-scheme`);
components use the Tailwind utilities, never a hex. The icon has its own fixed palette, which is
not made of tokens (it looks the same in light and dark, like any Dock icon):

| name | hex | where |
|---|---|---|
| Tactical Obsidian | `#121316` | the plate: the in-app mark flat, `icon.svg` as a vertical gradient around it (`#1A1C21` → `#0E0F12`) |
| Void Black | `#0A0B0E` | the dark plate, a vertical gradient around it (`#101116` → `#07080A`) |
| Neon Amber → Signal Coral | `#FF9A3C` → `#FF4528` | the left piece, the one the cut swept |
| Azure → Violet | `#4EA1FF` → `#A78BFA` | the right piece |
| glow | `#FF6A3D` → `#8B7CF6` | the faint radial glow behind the socket (20–30 % at the centre) |

`src/lib/app-icon.ts` holds the in-app mark's copy of these (a test keeps it equal to
`icon.svg`), and only `AppMark.vue` imports it. Coral is still the app's `--brand` (the kill, the
selection, destructive buttons); the icon is the one place it shares the stage.

## The icon

The icon's four sources (`icon.svg`, `icon-dark.svg`, `icon-tinted.svg`, `glyph.svg`) share one
geometry, 1024 px on Apple's grid (824 px plate, 100 px margin, radius 185): the face of an
Ethernet socket as a bold ring (96 px wall, 24 px outer corners, sharp hollow) with the latch tab
below, cut by one 88 px quadratic arc from (388,892) to (636,132) that bows toward the
upper-left. The left piece is the glyph clipped left of the arc's centreline, the right piece the
rest; the cut mask opens the gap between them. `tray.svg` is the lighter variant for the menu bar.
`AppMark.test.ts` checks that the four sources still draw `lib/app-icon.ts`'s socket and cut.

- `icon.svg`: the app icon, default appearance. Obsidian plate a touch lighter at the top, 2 px
  hairline, a faint glow, then, all cut by the arc: the glyph's bloom (blur 28, 55 %), the glass
  panel in the opening and the two pieces. The bloom is cut too, so the gap stays plate.
  `pnpm icons` renders it.
- `icon-dark.svg`: a preview of the dark appearance. Void Black plate, deeper bloom (blur 36,
  80 %), brighter hairline.
- `icon-tinted.svg`: a preview of the tinted / clear appearance: the glyph in one colour on a
  slate plate, no gradients on the glyph, no bloom.
- `glyph.svg`: the glyph alone, white on transparent: the single-colour layer for macOS 26's
  tinted and clear appearances.
- `tray.svg`: the glyph for the menu bar, black on transparent, a touch lighter (84 px wall and
  cut); macOS treats it as a template image and tints it itself.
- `src/components/AppMark.vue`: the icon in small for the window (the sidebar, the first-run card,
  Settings → About) and the ⌘⇧K strip: plate, glass, the two pieces, no bloom. Not to be
  confused with a row's brand mark (`FrameworkIcon`), which is a stack's logo.

`pnpm icons` renders `icon.svg` and `tray.svg` into `src-tauri/icons/` (every size, `.icns`,
`.ico`, the Windows set, the two tray PNGs) and is byte-reproducible. Never edit the PNGs by hand.

The legibility test is `src-tauri/icons/32x32.png`: two brackets with a diagonal gap, one warm,
one cool. At 16 px it is a ring with a gap. If a change loses the gap, the change is wrong.

## Appearances

macOS 26 uses an app's own dark and tinted icons when the app ships an Icon Composer `.icon` file
compiled into the bundle's `Assets.car`; for an app that ships only an `.icns`, as Tauri builds
it, macOS derives the other appearances from that icon itself. `icon-dark.svg` and
`icon-tinted.svg` are previews of what an `.icon` file should give. Icon Composer builds it from
layers, with settings per appearance: the warm piece, the cool piece and the glass as layers
(`glyph.svg` is the single-colour layer for tinted and clear), and the plate as the background
fill. That file has to be made in Icon Composer and built with Xcode's `actool` on a Mac.

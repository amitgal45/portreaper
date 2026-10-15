# Cyber Scythe

PortReaper's identity from v0.2 on. The idea in one sentence: **a port is a socket, and freeing
it is one clean sweep.** The icon is that socket, cut in two by the arc of a scythe, and nothing
else is drawn, because the cut is the story. The app follows the same economy: dark surfaces so
the list is the only bright thing, one hot colour that always means "kill" (and, by extension,
the brand), and four cool signals that each mean exactly one thing. No skull, no blade, no
gradients, no second theme.

## Tokens

The hexes live in `src/style.css` (`@theme`, dark only) and nowhere else: components use the
tokens, never a hex. The icon uses the same two surfaces and the same accent.

| token | name | hex | means |
|---|---|---|---|
| `--color-void` | Void Black | `#0A0B0E` | the window ground |
| `--color-obsidian` | Tactical Obsidian | `#121316` | panels, the strip, the icon plate |
| `--color-steel` | Steel | `#1B1D22` | raised surfaces: rows, inputs, the drawer |
| `--color-edge` | Edge | `#26292F` | hairlines and borders |
| `--color-ink` | Ink | `#F2F3F5` | text |
| `--color-ink-muted` | Ink Muted | `#A3A7B0` | secondary text: paths, commands, counts |
| `--color-ink-faint` | Ink Faint | `#6B7079` | hints, placeholders, scrollbars |
| `--color-coral` | Signal Coral | `#FF4528` | the kill and the brand: the glyph, the selection, destructive buttons |
| `--color-amber-neon` | Neon Amber | `#FF9A3C` | alive but wrong: zombies, port collisions, warnings |
| `--color-emerald-signal` | Signal Emerald | `#10B981` | freed, healthy, done |
| `--color-azure` | Azure | `#4EA1FF` | databases and anything protected |
| `--color-violet` | Violet | `#A78BFA` | local AI servers |

A colour never means two things, and coral is never decoration.

## The icon

- `icon.svg`: the app icon, 1024 px on Apple's grid (824 px plate, 100 px margin, radius 185).
  Coral on obsidian. The glyph is the face of an Ethernet socket as a bold ring (96 px wall,
  24 px outer corners, sharp hollow), cut by one 88 px arc that bows 60 px toward the upper-left.
- `tray.svg`: the same glyph, black on transparent, a touch lighter (84 px), for the menu bar.
  macOS treats it as a template image and tints it itself.
- `pnpm icons` renders both into `src-tauri/icons/` (every size, `.icns`, `.ico`, the two tray
  PNGs) and is byte-reproducible. Never edit the PNGs by hand.

The legibility test is `src-tauri/icons/32x32.png`: two bold brackets with a diagonal gap. At
16 px it is a ring with a gap. If a change loses the gap, the change is wrong.

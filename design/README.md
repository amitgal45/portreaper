# Cyber Scythe

PortReaper's identity from v0.2 on. The idea in one sentence: **a port is a socket, and freeing
it is one clean sweep.** The icon is that socket, cut in two by the arc of a scythe, with the two
severed brackets displaced along the cut. The app follows the same economy: dark surfaces so the
list is the only bright thing, one hot colour that always means "kill" (and, by extension, the
brand), and four cool/warm signals that each mean exactly one thing. No skull, no blade, no text.

## Tokens

The hexes live in `src/style.css` (`@theme`, dark only) and nowhere else: components use the
tokens, never a hex. The icon uses the same dark surfaces and the same semantic signal palette.

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

## The icon

- `icon.svg`: the app icon, 1024 px on Apple's grid (824 px plate, 100 px margin, radius 185).
  Anodized Tactical Obsidian (`#121316`) to Void Black (`#0A0B0E`) squircle plate with a subtle
  radar micro-grid, subsurface glow, and specular glass rim. On it, the face of an Ethernet socket
  (108 px wall, 26 px outer corners) sliced by a tapered scythe arc (164 px top entry to 128 px
  bottom exit) and sheared 20 px along the cut into two floating liquid-glass brackets—the left
  bracket in Neon Amber (`#FF9A3C`) to Signal Coral (`#FF4528`), and the right bracket in Azure
  (`#4EA1FF`) to Violet (`#A78BFA`) to Signal Coral (`#FF4528`)—over a translucent frosted-glass
  echo chamber.
- `tray.svg`: the same sheared, tapered Cut Socket glyph as a pure compound `<path>`, black on
  transparent, a touch lighter (98 px wall, 22 px corners), for the menu bar. macOS treats it as a
  template image and tints it itself.
- `pnpm icons` renders both into `src-tauri/icons/` (every size, `.icns`, `.ico`, the two tray
  PNGs) and is byte-reproducible. Never edit the PNGs by hand.

The legibility test is `src-tauri/icons/32x32.png`: two bold displaced brackets with a wide
diagonal gap. At 16 px it is a stepped ring split by a > 2 px channel. If a change loses the gap,
the change is wrong.

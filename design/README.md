# Prismatic Cut Socket

PortReaper's identity from v0.5 on ("Cyber Scythe — Prismatic Cut Socket", concept 3B; v0.2–v0.4
were a single coral glyph). The idea in one sentence is unchanged: **a port is a socket, and
freeing it is one clean sweep.** The icon is that socket, cut in two by the arc of a scythe, with
the two severed brackets displaced along the cut. No skull, no blade, no text. The concepts it
was chosen from are in `concepts/` (see `concepts/README.md`).

## Colours

The app's tokens live in `src/style.css` (`:root`, flipped for dark by `prefers-color-scheme`);
components use the Tailwind utilities, never a hex, and `--brand` is still Signal Coral
(`#FF4528`). The icon has its own fixed palette, not made of tokens (it looks the same in light
and dark, like any Dock icon):

| part | hexes |
|---|---|
| plate (`bg-grad`) | Anodized Obsidian `#1E222D` → Tactical Obsidian `#121316` → Void Black `#0A0B0E` |
| left bracket (`prism-left`) | amber `#FFB74D` → Signal Coral `#FF4528` → rose `#E11D48` |
| right bracket (`prism-right`) | Azure `#4EA1FF` → Violet `#A78BFA` → Signal Coral `#FF4528` |
| echo plate (`echo-glass`) | white 16 % → Violet 6 % |
| aura, rim, bloom | Signal Coral and Azure at low opacity, white highlights |

`src/lib/app-icon.ts` holds the in-app mark's copy of the plate, brackets and echo plate;
`src/components/AppMark.test.ts` keeps it equal to `icon.svg`, and only `AppMark.vue` imports it.

## The icon

- `icon.svg`: the app icon, 1024 px on Apple's grid (824 px plate, 100 px margin, radius 185).
  Anodized obsidian-to-void squircle plate with a subtle radar micro-grid, a coral/azure
  subsurface aura and a specular glass rim. On it, the face of an Ethernet socket (108 px wall,
  26 px outer corners) sliced by a tapered scythe arc (164 px at the top entry, 128 px at the
  bottom exit) and sheared 20 px along the cut into two floating liquid-glass brackets, with a
  drop shadow and a coral bloom, over a translucent frosted-glass echo plate. The gap is in the
  geometry (two separate paths), not a mask.
- `icon-dark.svg`: the dark appearance: Void Black plate, a stronger aura and glow.
- `icon-tinted.svg`: the tinted / clear appearance: the two brackets in one colour (`#F2F3F5`) on
  a translucent slate plate.
- `glyph.svg`: the two brackets alone, one compound path: the single-colour foreground layer for
  macOS 26 Icon Composer.
- `tray.svg`: the same sheared, tapered glyph as one compound path, black on transparent, a touch
  lighter (98 px wall, 22 px corners), for the menu bar. macOS treats it as a template image and
  tints it itself.
- `src/components/AppMark.vue`: the icon in small for the window (the sidebar, the first-run card,
  Settings → About) and the ⌘⇧K strip: plate, echo plate and the two brackets; no shadow, aura,
  grid or rim. Not to be confused with a row's brand mark (`FrameworkIcon`), a stack's logo.

The four icon sources and `AppMark` draw the same two bracket paths (`AppMark.test.ts` checks).
`pnpm icons` renders `icon.svg` and `tray.svg` into `src-tauri/icons/` (every size, `.icns`,
`.ico`, the Windows set, the two tray PNGs) and is byte-reproducible. Never edit the PNGs by hand.

The legibility test is `src-tauri/icons/32x32.png`: two bold displaced brackets with a wide
diagonal gap. At 16 px it is a stepped ring split by a channel of more than 2 px. If a change
loses the gap, the change is wrong.

## Appearances

macOS 26 uses an app's own dark and tinted icons when the app ships an Icon Composer `.icon` file
compiled into the bundle's `Assets.car`. For an app that ships only an `.icns`, as Tauri builds
it, macOS derives the other appearances from that icon itself. `icon-dark.svg` and
`icon-tinted.svg` show what the `.icon` file should give, and `glyph.svg` is its single-colour
layer. That file has to be made in Icon Composer and built with Xcode's `actool` on a Mac.

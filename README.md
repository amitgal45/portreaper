# PortReaper

See every listening port on your Mac, which project and branch it belongs to, and kill it in one click.

Instead of `node 3000` you see `shop-api on feature/cart`. Stray dev servers that lost their
terminal are marked. Databases and system daemons ask twice before dying.

![PortReaper: nine listening ports grouped by project, the first one selected](docs/screenshot.png)

*Mock data, from the browser build (`pnpm dev`), 760×540. Regenerate with `pnpm screenshot`;
`docs/screenshot-dark.png` is the same window in dark mode.*

## Run it

```bash
pnpm install
pnpm tauri dev          # the app
pnpm dev                # the UI alone, in a browser, against a mock core
```

## Check it

```bash
pnpm check                                        # Biome, vue-tsc, Vitest
pnpm e2e                                          # Playwright (WebKit, Chromium) against the mock core
cargo test --manifest-path src-tauri/Cargo.toml   # the Rust core
pnpm tauri build --bundles app                    # an unsigned .app
```

## How it is built

Tauri 2 with a small Rust core (`listeners` for sockets, `sysinfo` for processes) and a Vue 3 UI.
`src-tauri/src/model.rs` and `src/types.ts` are the contract between the two.

Status: v0.1 in progress, macOS only.

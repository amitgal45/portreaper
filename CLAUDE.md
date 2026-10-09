# portreaper — Repo Context
Part of: PortReaper (`~/work/portreaper`). Startup-wide rules come from the parent CLAUDE.md.

## This repo
- Purpose: a macOS desktop app that shows every listening port, which project and branch it
  belongs to, and kills it in one click. Lives in the Dock and in the menu bar. Windows later;
  nothing here may assume macOS where a crate already covers both.
- Stack: Tauri 2 (Rust 1.85+, edition 2021) + Vue 3.5 + TypeScript 6 + Vite 8 + Tailwind 4 +
  reka-ui + lucide-vue-next. Lint/format: Biome 2. Tests: Vitest 5 (happy-dom) and `cargo test`.
  Node 24, pnpm 11.
- Run: `pnpm tauri dev` (the app) · `pnpm dev` (UI only, in a browser, against the mock core).
  Test: `pnpm check` (Biome + vue-tsc + Vitest) and `cargo test --manifest-path src-tauri/Cargo.toml`.
  Both must pass before a PR opens. `pnpm tauri build --bundles app` makes an unsigned .app.
  Browser tests: `pnpm e2e` (Playwright, WebKit + Chromium, against the mock on port 1430; 1420 is the app's).
- Layout:
  - `src-tauri/src/model.rs` ⇄ `src/types.ts` — the contract. Change both in one commit.
  - `src-tauri/src/{ports,kill,project,tray,shortcuts}.rs` — one module per work package;
    `lib.rs` wires them and registers every plugin; `commands.rs` is the thin invoke layer.
  - `src/api/` — `tauri.ts` (real), `mock.ts` (browser and tests), `index.ts` picks one.
  - `src/components/`, `src/composables/` — the UI (WP-3).
- Landmines:
  - `cargo test` opens real sockets and kills real child processes it spawned. Never make a test
    kill a pid it did not create.
  - `kill.rs` must refuse pid 0, pid 1 and its own pid before sending any signal. A permission
    error is `Refused`, not `Failed`.
  - The title bar is hidden (`titleBarStyle: Overlay`): the top strip of the UI must carry
    `data-tauri-drag-region` or the window cannot be moved.
  - A new plugin goes in three places: `Cargo.toml`, `lib.rs`, `capabilities/default.json`.
  - `listeners` and `sysinfo` see other users' processes only partially without root. Show what
    is known and leave the rest `null`; never fail the whole list over one process.
  - `src-tauri/gen/` is generated and ignored. `src-tauri/target/` is 2+ GB; never commit it.

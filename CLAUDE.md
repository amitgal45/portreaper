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

## Release (WP-16)
- The app updates itself from GitHub Releases: `src-tauri/src/update.rs` checks the endpoint in
  `src-tauri/tauri.conf.json` (`plugins.updater`) and verifies the bundle with the public key
  there. Updates are only found once the repository is public
  (`gh repo edit amitgal45/portreaper --visibility public`); a private one answers 404 and the
  app stays quiet.
- To ship `X.Y.Z`:
  1. Add a `## X.Y.Z` section at the top of `CHANGELOG.md`; it becomes the release body and the
     update dialog's notes.
  2. Bump `version` in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` in
     one commit (`src/lib/version-parity.test.ts` fails on a mismatch; run `cargo build` so
     `Cargo.lock` follows), and let the owner merge it.
  3. On `main`: `git tag vX.Y.Z && git push origin vX.Y.Z`. `.github/workflows/release.yml`
     refuses a tag that does not match the app version, then builds, signs and publishes the
     release with the `.dmg`, the `.app.tar.gz` + `.sig` and `latest.json`.
- `createUpdaterArtifacts` lives in `src-tauri/tauri.release.conf.json`, which only the release
  job merges in (`--config`): with it on, the Tauri CLI refuses to build without the private key,
  and CI's unsigned `pnpm tauri build --bundles app` has none. Keep it out of `tauri.conf.json`.
- The signing key. Private: `~/.tauri/portreaper.key`, and in the repository's Actions secrets
  `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty). Public:
  `~/.tauri/portreaper.key.pub`, pasted into `tauri.conf.json`. Never commit, print, copy or move
  the private key; an app built with a different key cannot verify these releases, and a lost
  key means every installed app stops updating until it is reinstalled by hand.
- Signing: release builds are signed with the owner's Developer ID and notarized by Apple. The six
  `APPLE_*` repository secrets (`APPLE_CERTIFICATE` = the `.p12` as base64, `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY` = `Developer ID Application: <name> (<team id>)`, `APPLE_ID`,
  `APPLE_PASSWORD` = an app-specific password, `APPLE_TEAM_ID`) go to tauri-action's env; the
  Tauri bundler imports the certificate into a throwaway keychain, signs with the hardened
  runtime, notarizes with `notarytool` and staples the ticket. `release.yml` refuses to run with
  any of the six missing: a bundle the CLI does not sign opens as "damaged" on Apple Silicon.
  CI's PR build stays ad-hoc (`APPLE_SIGNING_IDENTITY: "-"`), because fork PRs get no secrets.
  Setting or renewing the secrets (the certificate expires after five years):
  `ops/runbooks/apple-signing.md` in the meta-repo runs `ops/scripts/apple-secrets.sh`. The
  certificate's private key lives in the owner's login keychain; never export, print or commit
  it outside that script. Check a release with `spctl -a -vv PortReaper.app`
  ("source=Notarized Developer ID") and `xcrun stapler validate PortReaper.app`.

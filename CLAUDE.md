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
  3. On `main`: `git tag vX.Y.Z && git push origin vX.Y.Z` (the `release tags` ruleset lets only
     its bypass list create a `v*` tag). The run starts at once, with no approval:
     `.github/workflows/release.yml` refuses a tag that does not match the app version, builds,
     signs and publishes the release with the `.dmg`, the `.app.tar.gz` + `.sig` and
     `latest.json`. Releases here are immutable (Settings > General > Releases): a published
     release can never gain, replace or lose a file, and its tag name can never be used again,
     even after the release is deleted. So the release stays a draft until all four files are on
     it, and one step publishes it (`src/lib/release-workflow.test.ts` pins that order). v0.5.0
     was lost to the old order, published first and uploaded after: GitHub refused the upload,
     kept an empty release under that name, and its changes shipped as 0.5.1. A draft the publish
     step refuses publishes nothing: delete the draft, then re-run the release; the tag stays.
  4. The same job then writes `Casks/portreaper.rb` in `amitgal45/homebrew-tap`
     (`scripts/update-tap.sh`) from `packaging/homebrew/portreaper.rb`, the template, with the
     new version and the published DMG's SHA-256. It needs the `TAP_TOKEN` secret: a
     fine-grained token for that one repository with Contents: Read and write. A token that
     cannot read the tap stops the run before building (the job's first step); one that can read
     but not write fails only the last step, after the release is out. Retry it, or backfill an
     older release, with a manual run of Release from `main` with `tag` set. Never
     "Re-run failed jobs" on a release: it reruns the whole job (a rebuild and a new notarization)
     and may replace the published assets.
  5. A manual run needs no approval, and anyone with write access can start one, the agents' bot
     account included. It only points the tap at an existing release with `main`'s template and
     script, so the worst a stray run does is point it at an older release; a manual run with
     the latest tag puts it back.
- Secrets: all of them (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, the six
  `APPLE_*`, `TAP_TOKEN`) live in the `release` environment, never at repository level: a
  repository secret is readable by a workflow pushed to any branch by anyone with write access,
  the agents' bot account included. The environment's deployment rules admit only the `main`
  branch and `v*` tags, and it has no required reviewers. What guards those two refs is the
  rulesets: `protect-main` (a PR and the owner's approval before anything lands on `main`) and
  `release tags` (only its bypass list creates, moves or deletes a `v*` tag). `release.yml` names
  the environment in both of its jobs (`release` for a tag, `tap` for a manual run), and each run
  has exactly one of them. Set or rotate a secret with
  `gh secret set NAME --env release --repo amitgal45/portreaper` from the owner's machine. Never
  run `gh secret set` without `--env release`: it would create a repository secret again, which
  any branch's workflow can read, while releases kept signing with the environment's old copy.
  `src/lib/release-workflow.test.ts` pins that only the environment's two jobs name a secret.
- `createUpdaterArtifacts` lives in `src-tauri/tauri.release.conf.json`, which only the release
  job merges in (`--config`): with it on, the Tauri CLI refuses to build without the private key,
  and CI's unsigned `pnpm tauri build --bundles app` has none. Keep it out of `tauri.conf.json`.
- The signing key. Private: `~/.tauri/portreaper.key`, and in the `release` environment's secrets
  `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty). Public:
  `~/.tauri/portreaper.key.pub`, pasted into `tauri.conf.json`. Never commit, print, copy or move
  the private key; an app built with a different key cannot verify these releases, and a lost
  key means every installed app stops updating until it is reinstalled by hand.
- Signing: release builds are signed with the owner's Developer ID and notarized by Apple. The six
  `APPLE_*` secrets of the `release` environment (`APPLE_CERTIFICATE` = the `.p12` as base64, `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY` = `Developer ID Application: <name> (<team id>)`, `APPLE_ID`,
  `APPLE_PASSWORD` = an app-specific password, `APPLE_TEAM_ID`) go to tauri-action's env; the
  Tauri bundler imports the certificate into a throwaway keychain, signs with the hardened
  runtime, notarizes with `notarytool` and staples the ticket. `release.yml` refuses to run with
  any of the six missing: a bundle the CLI does not sign opens as "damaged" on Apple Silicon.
  CI's PR build stays ad-hoc (`APPLE_SIGNING_IDENTITY: "-"`), because fork PRs get no secrets.
  Setting or renewing the secrets (the certificate expires after five years):
  `ops/runbooks/apple-signing.md` in the meta-repo runs `ops/scripts/apple-secrets.sh`, which must
  set them with `--env release` (see Secrets above). The
  certificate's private key lives in the owner's login keychain; never export, print or commit
  it outside that script. Check a release with `spctl -a -vv PortReaper.app`
  ("source=Notarized Developer ID") and `xcrun stapler validate PortReaper.app`.

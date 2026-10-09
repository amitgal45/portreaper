# PortReaper

**Kill ports. See what is behind them.**

PortReaper is a small macOS app that lists every listening port on your machine, names the
project and git branch behind each one, and kills the process in one click. It lives in the Dock
and in the menu bar. Instead of `node 48213` you see `shop-api · feature/cart · vite`.

Status: **v0.1 in progress, macOS only.** Nothing is released yet; the list below is what v0.1 is
being built to do, work package by work package.

<!-- Screenshot placeholder. docs/screenshot.png is added at WP-6 (integration), once the real
     core runs behind the UI. Keep this note until the file exists. -->
> Screenshot: `docs/screenshot.png`, coming at WP-6 once the real core runs behind the UI.

## What it does (v0.1)

- **Every listening port.** TCP and UDP, IPv4 and IPv6 merged, with the process behind it: name,
  command line, working directory, user, memory, uptime. Ports open to the whole network are
  marked, so are dev servers that lost their terminal.
- **The project behind the port.** Name from `package.json`, `Cargo.toml`, `pyproject.toml` or
  `go.mod` (else the folder), the git branch read from `.git/HEAD` (worktrees included), and the
  tool from the command line: `vite`, `next`, `node`, `docker`, `postgres`... When it is not sure
  it shows nothing rather than a guess.
- **Kill in one click.** SIGTERM, up to 3 s to close sockets cleanly, then SIGKILL. ⌥-click
  sends SIGKILL at once. "Kill all" frees a whole project.
- **Guards.** It never signals pid 0, pid 1 or itself. Databases, Docker, system daemons and
  other users' processes are marked protected and ask a second time before dying.
- **One table, one search box.** Grouped by project, keyboard driven (↑ ↓ Enter ⌘⌫ Esc, type a
  port number to search), refreshed every 2 s while the window is visible. Row actions: open
  `localhost:<port>` in the browser, copy `kill -9 <pid>`, copy the command line, reveal the
  project folder.
- **Menu bar.** An icon with the count of open ports and one "Free :3000 · shop-api" item per
  port. ⌘⇧P brings the window up from anywhere. Closing the window hides it; the app stays in the
  Dock; Quit lives in the tray menu and the app menu.
- **Nothing leaves the machine.** No analytics, no network calls, no crash reporting.

## Install

There is no download yet. Build it from source (Xcode Command Line Tools, Rust stable 1.85+,
Node 24, pnpm 11). Clone the repository, then:

```bash
pnpm install
pnpm tauri build --bundles app
open src-tauri/target/release/bundle/macos/PortReaper.app
```

Once the repository has a GitHub remote, CI (`.github/workflows/ci.yml`) builds an unsigned
`.app` for every push that can be downloaded from the workflow run.

## Develop

```bash
pnpm tauri dev                                    # the app, with hot reload
pnpm dev                                          # the UI alone, in a browser, against a mock core
pnpm check                                        # Biome, vue-tsc, Vitest
cargo test --manifest-path src-tauri/Cargo.toml   # the Rust core (opens real sockets, kills only children it spawned)
pnpm icons                                        # regenerate every icon from design/*.svg
```

## How it works

A Rust core (Tauri 2) reads listening sockets with the `listeners` crate and process details with
`sysinfo`, then walks up from each process's working directory to find its project manifest and
`.git/HEAD`. A Vue 3 window asks the core for the list every 2 s while visible and sends kill
requests back; `src-tauri/src/model.rs` and `src/types.ts` are the contract between the two.

## FAQ

**Why is the app unsigned?**
There is no Apple Developer certificate yet. An app you build yourself opens normally. A
downloaded build carries macOS's quarantine flag and is refused on first launch: open
System Settings → Privacy & Security and click "Open Anyway", or run
`xattr -dr com.apple.quarantine PortReaper.app`.

**What does it read, and where does it go?**
The list of listening sockets, and for each process behind one: pid, name, command line, working
directory, executable path, user, memory, start time and parent pid. It reads them to show them
and to find the project. Nothing is sent anywhere: the core's dependencies
(`src-tauri/Cargo.toml`) contain no HTTP client, the UI is bundled with the app and loads nothing
remote, and there is no analytics SDK.

**Why does it not ask for sudo?**
Your own processes can be listed and signalled by your own user, and a dev server is your own
process. Processes of other users (root daemons, for example) show up with what the kernel reveals
to a normal user and cannot be killed; the app says so instead of asking for a password. There is
no privileged helper.

## License

MIT, see [LICENSE](LICENSE).

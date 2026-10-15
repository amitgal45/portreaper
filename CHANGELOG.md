# Changelog

The section at the top is the next release's body: `.github/workflows/release.yml` copies the
section whose heading matches the tag (`v0.2.0` → `## 0.2.0`) into the GitHub Release, and the
app shows it in its update dialog. Add a section for every release before tagging it
(the recipe is in `CLAUDE.md`).

## 0.3.0

- Preferences that take effect the moment they change: the Dock icon (or menu bar only), start
  at login, the two global shortcuts, the refresh rate, the kill default and notifications are
  stored, applied by the core and shared by the window and the menu bar. "Preferences…" in the
  menu-bar menu; "Start at login" there and in the window are one switch.
- One universal build: the same `.dmg` runs on Intel and Apple Silicon Macs.
- WP-17b: The Preferences view (⌘,) and a first-run card.
- WP-18: Watch a port: a notification when it frees up or gets taken.
- WP-19: Text contrast at AA everywhere; a wider default window.
- WP-20: Docker containers by name; Kill stops the container.

## 0.2.1

- The repository is public and releases are published here. No change in the app.

## 0.2.0

- Every listening port, classified: TCP and UDP, IPv4 and IPv6 merged, with the process behind
  it and a category (web, api, db, ai, system, other); the stack named when the command line
  gives it away (Next.js, NestJS, PostgreSQL, Ollama); a public-LAN badge; zombies (dev servers
  that lost their terminal) and "Reap zombies" to free them all at once.
- The project behind the port: name from `package.json`, `Cargo.toml`, `pyproject.toml` or
  `go.mod`, the git branch, and the tool from the command line. Nothing is shown when unsure.
- The Board: a sidebar with category filters and the two alarms, summary cards, the table
  grouped by project, and the inspector (process tree, working directory, branch, bind address,
  full command, Kill and Restart) as a third column or a slide-over.
- The Taskline: everything PortReaper did this session, with timing and memory given back;
  kills from the menu bar and the strip included. Relaunch brings a killed process back.
- Kill in one click: SIGTERM, up to 3 s, then SIGKILL; ⌥-click forces; "Kill all" frees a project.
- Guards: never pid 0, pid 1 or itself; databases, Docker, system daemons and other users'
  processes are protected and ask a second time.
- ⌘⇧K from anywhere: the strip with the port most likely in your way already selected.
- Menu bar: the open-port count, one "Free :3000 · shop-api" item per port, ⌘⇧P for the window.
- Updates itself from GitHub Releases: signed bundles, checked at launch and every six hours,
  offered in a dialog and in the sidebar; "Check for Updates…" in the menu bar.
- Nothing leaves the machine besides the update check: no analytics, no crash reporting.

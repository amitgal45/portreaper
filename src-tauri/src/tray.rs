//! The menu-bar icon, its menu, and what happens when the window is closed.
//!
//! Owned by WP-4, extended by WP-8a. The app lives in the Dock like a normal app; the tray is
//! the fast path: a count of open ports, "Free a port…" (the Quick window), a Shortcuts submenu
//! with one "Free :3000 · shop-api" item per port and two bulk kills, show/quit, and "Start at
//! login".
//!
//! The pure part is [`shortcuts_model`], built on [`menu_model`]: the port list in, every menu
//! line out. Everything the tray shows is derived from it, so it is the part that gets unit
//! tests.
//!
//! A Tauri 2 tray menu is static once built, so a background thread re-reads the ports every
//! [`REFRESH_INTERVAL`] (and at once whenever the window is shown) and swaps the menu on the
//! main thread, but only when the model changed, so a menu the user holds open is left alone.
//! Freeing a port from the menu goes through `crate::ports::listing` and
//! `crate::taskline::kill_recorded`, the same path the UI's commands take, so a tray kill lands
//! in the Taskline too; then it posts a notification. Nothing here may panic: every runtime
//! failure is a [`warn`] on stderr and the app carries on.

use std::collections::HashSet;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::Duration;

use serde::Serialize;
use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, Window, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_notification::NotificationExt as _;

use crate::model::{EventKind, KillOutcome, PortEntry, Protocol};
use crate::{quick, shortcuts, taskline, update};

/// How many "Free :PORT" items the menu shows at most.
pub const MAX_MENU_PORTS: usize = 12;
/// How often the menu is rebuilt from a fresh port list.
pub const REFRESH_INTERVAL: Duration = Duration::from_secs(5);
/// Emitted to the UI when a protected port is picked from the tray: the window is shown and the
/// UI selects that port and asks its confirmations there. Payload: [`SelectPort`].
pub const SELECT_PORT_EVENT: &str = "tray:select-port";

/// The main window's label in `tauri.conf.json`.
const MAIN_WINDOW: &str = "main";
const TRAY_ID: &str = "main";

const ID_HEADER: &str = "header";
const ID_QUICK: &str = "quick";
const ID_SHORTCUTS: &str = "shortcuts";
const ID_KILL_ORPHANS: &str = "kill-orphans";
const ID_KILL_DEV_SERVERS: &str = "kill-dev-servers";
const ID_OPEN: &str = "open";
const ID_NO_PORTS: &str = "no-ports";
const ID_CHECK_UPDATES: &str = "check-updates";
const ID_AUTOSTART: &str = "autostart";
const ID_QUIT: &str = "quit";
const ID_PORT_PREFIX: &str = "port:";

/// One "Free :PORT" line in the tray menu, derived from the port list by [`menu_model`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuEntry {
    pub port: u16,
    pub protocol: Protocol,
    /// `"Free :3000 · shop-api"`, with `" (protected)"` appended when `protected` is set.
    pub label: String,
    /// The tray has no confirmation dialog, so a protected port is never killed from the menu:
    /// its item shows the main window with that port selected and the UI asks there.
    pub protected: bool,
}

/// The payload of [`SELECT_PORT_EVENT`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectPort {
    pub port: u16,
    pub protocol: Protocol,
}

/// The menu lines for `entries`: one per distinct `(port, protocol)`, TCP first, then by port,
/// at most `max` of them. A port is protected when any process on it is. The label names the
/// project when one is known, else the process.
pub fn menu_model(entries: &[PortEntry], max: usize) -> Vec<MenuEntry> {
    let mut model = distinct_ports(entries);
    model.truncate(max);
    model
}

/// Everything the menu shows about the ports, derived from the list by [`shortcuts_model`].
/// Two equal models make the same menu, so the refresh thread compares them and leaves an
/// unchanged menu alone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShortcutsModel {
    /// The disabled first line: `"PortReaper · 9 ports"`, `"PortReaper · no ports"` at zero.
    pub header: String,
    /// The `Free :PORT · name` lines of the Shortcuts submenu, as [`menu_model`] makes them.
    pub ports: Vec<MenuEntry>,
    /// What "Kill lost-terminal servers" kills: every orphan pid that is not protected, once.
    pub orphans: Vec<u32>,
    /// What "Kill all dev servers" kills: every pid with a project that is not protected, once.
    pub dev_servers: Vec<u32>,
}

impl ShortcutsModel {
    /// `"Kill lost-terminal servers (2)"`; no count at zero, where the item is disabled.
    pub fn orphans_label(&self) -> String {
        counted_label("Kill lost-terminal servers", self.orphans.len())
    }

    /// `"Kill all dev servers (4)"`; no count at zero, where the item is disabled.
    pub fn dev_servers_label(&self) -> String {
        counted_label("Kill all dev servers", self.dev_servers.len())
    }
}

/// The whole menu model for `entries`. Pids are distinct and sorted; a pid that is protected
/// on any of its sockets is in neither bulk list, so the tray never widens what a kill reaches.
pub fn shortcuts_model(entries: &[PortEntry]) -> ShortcutsModel {
    let protected = distinct_pids(entries, |e| e.protected);
    let unprotected = |e: &PortEntry| protected.binary_search(&e.pid).is_err();
    ShortcutsModel {
        header: header(entries),
        ports: menu_model(entries, MAX_MENU_PORTS),
        orphans: distinct_pids(entries, |e| e.orphan && unprotected(e)),
        dev_servers: distinct_pids(entries, |e| e.project.is_some() && unprotected(e)),
    }
}

/// `"PortReaper · N ports"` with the freeable count the title shows; `no ports` at zero.
pub fn header(entries: &[PortEntry]) -> String {
    match freeable_count(entries) {
        0 => "PortReaper · no ports".to_string(),
        1 => "PortReaper · 1 port".to_string(),
        n => format!("PortReaper · {n} ports"),
    }
}

/// The distinct, sorted pids of the entries `keep` accepts.
fn distinct_pids(entries: &[PortEntry], keep: impl Fn(&PortEntry) -> bool) -> Vec<u32> {
    let mut pids: Vec<u32> = entries.iter().filter(|e| keep(e)).map(|e| e.pid).collect();
    pids.sort_unstable();
    pids.dedup();
    pids
}

/// `"Kill all dev servers (4)"`, or just the verb at zero.
fn counted_label(label: &str, count: usize) -> String {
    match count {
        0 => label.to_string(),
        n => format!("{label} ({n})"),
    }
}

/// The one notification after a bulk kill: `Freed 4 ports · 3 processes`, with `· 1 refused`
/// when some pids would not die, or `Could not free any port · 2 refused` when none did.
fn bulk_summary(ports: usize, processes: usize, refused: usize) -> String {
    let mut summary = if processes == 0 {
        "Could not free any port".to_string()
    } else {
        format!("Freed {} · {}", plural(ports, "port", "ports"), plural(processes, "process", "processes"))
    };
    if refused > 0 {
        summary.push_str(&format!(" · {refused} refused"));
    }
    summary
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// Like [`menu_model`] without the cap: the title and tooltip count every port.
fn distinct_ports(entries: &[PortEntry]) -> Vec<MenuEntry> {
    struct Line<'a> {
        port: u16,
        protocol: Protocol,
        project: Option<&'a str>,
        process: &'a str,
        protected: bool,
    }

    let mut lines: Vec<Line<'_>> = Vec::new();
    for entry in entries {
        let project = entry.project.as_ref().map(|p| p.name.as_str());
        match lines.iter_mut().find(|l| l.port == entry.port && l.protocol == entry.protocol) {
            Some(line) => {
                line.protected |= entry.protected;
                if line.project.is_none() {
                    line.project = project;
                }
            }
            None => lines.push(Line {
                port: entry.port,
                protocol: entry.protocol,
                project,
                process: &entry.process_name,
                protected: entry.protected,
            }),
        }
    }
    lines.sort_by_key(|l| (l.protocol != Protocol::Tcp, l.port));
    lines
        .into_iter()
        .map(|l| {
            let name = l.project.unwrap_or(l.process);
            let suffix = if l.protected { " (protected)" } else { "" };
            MenuEntry {
                port: l.port,
                protocol: l.protocol,
                label: format!("Free :{} · {}{}", l.port, name, suffix),
                protected: l.protected,
            }
        })
        .collect()
}

/// The number of ports the user can free from the tray: every distinct port that is not
/// protected, not capped like the menu is.
fn freeable_count(entries: &[PortEntry]) -> usize {
    distinct_ports(entries).iter().filter(|m| !m.protected).count()
}

/// The text beside the icon on macOS: the freeable port count, or nothing at zero.
pub fn tray_title(entries: &[PortEntry]) -> String {
    match freeable_count(entries) {
        0 => String::new(),
        n => n.to_string(),
    }
}

/// `"PortReaper · N ports"`, with the same count the title shows.
pub fn tray_tooltip(entries: &[PortEntry]) -> String {
    match freeable_count(entries) {
        1 => "PortReaper · 1 port".to_string(),
        n => format!("PortReaper · {n} ports"),
    }
}

/// The menu id of a port item: `port:3000:tcp`.
fn port_id(entry: &MenuEntry) -> String {
    let protocol = match entry.protocol {
        Protocol::Tcp => "tcp",
        Protocol::Udp => "udp",
    };
    format!("{ID_PORT_PREFIX}{}:{protocol}", entry.port)
}

/// The inverse of [`port_id`]; `None` for every other menu id.
fn parse_port_id(id: &str) -> Option<(u16, Protocol)> {
    let rest = id.strip_prefix(ID_PORT_PREFIX)?;
    let (port, protocol) = rest.split_once(':')?;
    let protocol = match protocol {
        "tcp" => Protocol::Tcp,
        "udp" => Protocol::Udp,
        _ => return None,
    };
    Some((port.parse().ok()?, protocol))
}

/// The warnings the spec asks for. The crate has no logger yet, so they go to stderr, which
/// `pnpm tauri dev` shows in the terminal and a packaged app hands to the system log.
pub(crate) fn warn(message: impl std::fmt::Display) {
    eprintln!("warn: {message}");
}

/// The lines that are not warnings but belong in the log: a bulk kill's per-pid outcomes, the
/// first-run autostart.
pub(crate) fn info(message: impl std::fmt::Display) {
    eprintln!("info: {message}");
}

/// What the refresh thread listens for besides its timer.
enum Signal {
    /// Re-read the ports now; swap the menu only if the model changed.
    Refresh,
    /// Re-read and swap even if the ports did not change (the "Start at login" mark moved).
    Rebuild,
    /// The app is exiting.
    Stop,
}

/// Managed state: the way into the refresh thread.
struct TrayState {
    signals: Sender<Signal>,
}

/// Everything the tray shows. Two equal snapshots look the same, so the refresh thread compares
/// them and leaves an unchanged menu alone.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Snapshot {
    shortcuts: ShortcutsModel,
    title: String,
    tooltip: String,
    autostart: bool,
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let (signals, inbox) = mpsc::channel();
    app.manage(TrayState { signals });

    // Built empty; the refresh thread fills it within milliseconds.
    let snapshot = Snapshot {
        shortcuts: shortcuts_model(&[]),
        title: tray_title(&[]),
        tooltip: tray_tooltip(&[]),
        autostart: autostart_enabled(app),
    };
    let menu = build_menu(app, &snapshot)?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .icon_as_template(true)
        .tooltip(&snapshot.tooltip)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(on_tray_icon_event);
    // The menu-bar glyph: black on transparent, rendered from design/tray.svg at 2x, and marked
    // as a template above so macOS tints it for light and dark menu bars.
    match tauri::image::Image::from_bytes(include_bytes!("../icons/tray-44.png")) {
        Ok(icon) => tray = tray.icon(icon),
        Err(e) => {
            warn(&format!("tray glyph failed to load, using the app icon: {e}"));
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
        }
    }
    tray.build(app)?;

    let handle = app.clone();
    std::thread::Builder::new().name("tray-refresh".into()).spawn(move || refresh_loop(&handle, &inbox))?;
    Ok(())
}

/// Runs on its own thread for the life of the app: re-reads the ports every [`REFRESH_INTERVAL`]
/// or when asked, and hands a changed snapshot to the main thread for the swap.
fn refresh_loop(app: &AppHandle, inbox: &Receiver<Signal>) {
    let mut last: Option<Snapshot> = None;
    loop {
        let snapshot = take_snapshot(app);
        if last.as_ref() != Some(&snapshot) {
            let handle = app.clone();
            let applied = snapshot.clone();
            match app.run_on_main_thread(move || apply_snapshot(&handle, &applied)) {
                Ok(()) => last = Some(snapshot),
                Err(e) => warn(format_args!("could not schedule the tray refresh: {e}")),
            }
        }
        match inbox.recv_timeout(REFRESH_INTERVAL) {
            Ok(Signal::Refresh) | Err(RecvTimeoutError::Timeout) => {}
            Ok(Signal::Rebuild) => last = None,
            Ok(Signal::Stop) | Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

fn take_snapshot(app: &AppHandle) -> Snapshot {
    let entries = crate::ports::list().unwrap_or_else(|e| {
        warn(format_args!("could not list ports for the tray: {e}"));
        Vec::new()
    });
    Snapshot {
        shortcuts: shortcuts_model(&entries),
        title: tray_title(&entries),
        tooltip: tray_tooltip(&entries),
        autostart: autostart_enabled(app),
    }
}

/// Main thread only: swaps the menu, title and tooltip for `snapshot`.
fn apply_snapshot(app: &AppHandle, snapshot: &Snapshot) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        warn("the tray icon is gone; nothing to refresh");
        return;
    };
    match build_menu(app, snapshot) {
        Ok(menu) => {
            if let Err(e) = tray.set_menu(Some(menu)) {
                warn(format_args!("could not swap the tray menu: {e}"));
            }
        }
        Err(e) => warn(format_args!("could not build the tray menu: {e}")),
    }
    let title = Some(snapshot.title.as_str()).filter(|t| !t.is_empty());
    if let Err(e) = tray.set_title(title) {
        warn(format_args!("could not set the tray title: {e}"));
    }
    if let Err(e) = tray.set_tooltip(Some(&snapshot.tooltip)) {
        warn(format_args!("could not set the tray tooltip: {e}"));
    }
}

/// The header (disabled) · `Free a port…` ⌘⇧K · separator · `Shortcuts ▸` (the port items, or
/// a disabled `No ports`; separator; the two bulk kills, disabled at zero) · separator ·
/// `Open PortReaper` ⌘⇧P · `Check for Updates…` · `Start at login` · `Quit PortReaper`.
///
/// The accelerators are labels: a status-item menu never fires them. `shortcuts.rs` registers
/// the real ones.
fn build_menu(app: &AppHandle, snapshot: &Snapshot) -> tauri::Result<Menu<tauri::Wry>> {
    let model = &snapshot.shortcuts;
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, ID_HEADER, &model.header, false, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, ID_QUICK, "Free a port…", true, Some(shortcuts::QUICK_WINDOW))?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    let submenu = Submenu::with_id(app, ID_SHORTCUTS, "Shortcuts", true)?;
    if model.ports.is_empty() {
        submenu.append(&MenuItem::with_id(app, ID_NO_PORTS, "No ports", false, None::<&str>)?)?;
    }
    for entry in &model.ports {
        submenu.append(&MenuItem::with_id(app, port_id(entry), &entry.label, true, None::<&str>)?)?;
    }
    submenu.append(&PredefinedMenuItem::separator(app)?)?;
    let orphans = !model.orphans.is_empty();
    submenu.append(&MenuItem::with_id(app, ID_KILL_ORPHANS, model.orphans_label(), orphans, None::<&str>)?)?;
    let dev_servers = !model.dev_servers.is_empty();
    submenu.append(&MenuItem::with_id(app, ID_KILL_DEV_SERVERS, model.dev_servers_label(), dev_servers, None::<&str>)?)?;
    menu.append(&submenu)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    menu.append(&MenuItem::with_id(app, ID_OPEN, "Open PortReaper", true, Some(shortcuts::TOGGLE_WINDOW))?)?;
    menu.append(&MenuItem::with_id(app, ID_CHECK_UPDATES, "Check for Updates…", true, None::<&str>)?)?;
    menu.append(&CheckMenuItem::with_id(app, ID_AUTOSTART, "Start at login", true, snapshot.autostart, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, ID_QUIT, "Quit PortReaper", true, None::<&str>)?)?;
    Ok(menu)
}

/// Every menu event in the app lands here, the app menu's included; ids that are not ours pass.
fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    match id {
        ID_OPEN => show_window(app),
        ID_QUICK => quick::show_quick(app),
        ID_AUTOSTART => toggle_autostart(app),
        // The check waits on the network and on a dialog; it gets its own thread.
        ID_CHECK_UPDATES => update::spawn_check(app, update::Trigger::Manual),
        ID_QUIT => app.exit(0),
        ID_KILL_ORPHANS => spawn_bulk_kill(app, Bulk::Orphans),
        ID_KILL_DEV_SERVERS => spawn_bulk_kill(app, Bulk::DevServers),
        ID_HEADER | ID_NO_PORTS | ID_SHORTCUTS => {}
        other => {
            if let Some((port, protocol)) = parse_port_id(other) {
                // A graceful kill waits up to `kill::GRACE_MS`; that must not block the event loop.
                let app = app.clone();
                std::thread::spawn(move || free_from_tray(&app, port, protocol));
            }
        }
    }
}

fn on_tray_icon_event(tray: &TrayIcon, event: TrayIconEvent) {
    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
        show_window(tray.app_handle());
    }
}

/// Closing either window hides it: the tray, the Dock and ⌘⇧P bring the main one back, ⌘⇧K the
/// Quick one; Quit ends the app. The Quick window also hides the moment it loses focus.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    match (window.label(), event) {
        (MAIN_WINDOW | quick::QUICK_WINDOW, WindowEvent::CloseRequested { api, .. }) => {
            api.prevent_close();
            if let Err(e) = window.hide() {
                warn(format_args!("could not hide the {} window: {e}", window.label()));
            }
        }
        (quick::QUICK_WINDOW, WindowEvent::Focused(false)) => quick::hide_quick(window.app_handle()),
        _ => {}
    }
}

/// The event-loop callback wired in `lib.rs`: a Dock click with no visible window shows it, and
/// exit stops the refresh thread.
pub fn on_run_event(app: &AppHandle, event: RunEvent) {
    match event {
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { has_visible_windows: false, .. } => show_window(app),
        RunEvent::Exit => signal(app, Signal::Stop),
        _ => {}
    }
}

/// Shows and focuses the main window, and asks for a fresh menu while it is up.
pub(crate) fn show_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        warn("the main window is gone; cannot show it");
        return;
    };
    if window.is_minimized().unwrap_or(false) {
        if let Err(e) = window.unminimize() {
            warn(format_args!("could not unminimize the window: {e}"));
        }
    }
    if let Err(e) = window.show() {
        warn(format_args!("could not show the window: {e}"));
    }
    if let Err(e) = window.set_focus() {
        warn(format_args!("could not focus the window: {e}"));
    }
    signal(app, Signal::Refresh);
}

fn signal(app: &AppHandle, signal: Signal) {
    match app.try_state::<TrayState>() {
        Some(state) => {
            if state.signals.send(signal).is_err() {
                warn("the tray refresh thread is gone");
            }
        }
        None => warn("the tray is not set up; nothing to refresh"),
    }
}

fn autostart_enabled(app: &AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or_else(|e| {
        warn(format_args!("could not read the start-at-login state: {e}"));
        false
    })
}

fn toggle_autostart(app: &AppHandle) {
    let autostart = app.autolaunch();
    let result = match autostart.is_enabled() {
        Ok(true) => autostart.disable(),
        Ok(false) => autostart.enable(),
        Err(e) => Err(e),
    };
    if let Err(e) = result {
        warn(format_args!("could not toggle start at login: {e}"));
    }
    // The check mark follows the real state, whatever happened.
    signal(app, Signal::Rebuild);
}

/// Frees `port` from the tray: a graceful kill of every process on it, then a notification. A
/// protected port is not killed here (the tray cannot ask twice); the window is shown with that
/// port selected instead.
fn free_from_tray(app: &AppHandle, port: u16, protocol: Protocol) {
    // The menu can be up to `REFRESH_INTERVAL` stale: look again before touching anything.
    let listing = match crate::ports::listing() {
        Ok(listing) => listing,
        Err(e) => {
            warn(format_args!("could not list ports to free :{port}: {e}"));
            notify(app, &format!("Could not free port {port} · {e}"));
            return;
        }
    };
    let on_port: Vec<&PortEntry> =
        listing.entries.iter().filter(|e| e.port == port && e.protocol == protocol).collect();
    if on_port.is_empty() {
        notify(app, &format!("Could not free port {port} · nothing is listening on it any more"));
        signal(app, Signal::Refresh);
        return;
    }
    if on_port.iter().any(|e| e.protected) {
        select_port_in_window(app, port, protocol);
        return;
    }

    let mut freed = Vec::new();
    let mut failures = Vec::new();
    // One kill per pid, recorded against its entry on this port; the list is sorted by port
    // then pid, so the first entry of a pid is the one to keep.
    let mut seen: Vec<u32> = Vec::new();
    for entry in &on_port {
        let (name, pid) = (entry.process_name.as_str(), entry.pid);
        if seen.contains(&pid) {
            continue;
        }
        seen.push(pid);
        match taskline::kill_recorded(app, &listing, entry, false, None) {
            KillOutcome::Killed { .. } => freed.push(format!("{name} ({pid})")),
            KillOutcome::NotFound { .. } => freed.push(format!("{name} ({pid}, already gone)")),
            KillOutcome::Refused { reason, .. } => failures.push(format!("{name} ({pid}): {reason}")),
            KillOutcome::Failed { error, .. } => failures.push(format!("{name} ({pid}): {error}")),
        }
    }
    let message = if failures.is_empty() {
        format!("Freed port {port} · {}", freed.join(", "))
    } else {
        format!("Could not free port {port} · {}", failures.join("; "))
    };
    notify(app, &message);
    signal(app, Signal::Refresh);
}

/// The two bulk kills of the Shortcuts submenu.
#[derive(Debug, Clone, Copy)]
enum Bulk {
    /// Every orphan (lost-terminal) server that is not protected.
    Orphans,
    /// Every process with a project that is not protected.
    DevServers,
}

impl Bulk {
    fn pids(self, model: &ShortcutsModel) -> &[u32] {
        match self {
            Bulk::Orphans => &model.orphans,
            Bulk::DevServers => &model.dev_servers,
        }
    }

    fn nothing_to_kill(self) -> &'static str {
        match self {
            Bulk::Orphans => "No lost-terminal servers to kill",
            Bulk::DevServers => "No dev servers to kill",
        }
    }

    /// How the Taskline names a kill from this action: a reaped zombie for the lost-terminal
    /// one, the plain `portFreed`/`forceKilled` for the other.
    fn event_kind(self) -> Option<EventKind> {
        match self {
            Bulk::Orphans => Some(EventKind::ZombieReaped),
            Bulk::DevServers => None,
        }
    }
}

/// A graceful kill waits up to `kill::GRACE_MS` per pid; that must not block the event loop.
fn spawn_bulk_kill(app: &AppHandle, bulk: Bulk) {
    let app = app.clone();
    std::thread::spawn(move || bulk_kill(&app, bulk));
}

/// Kills every pid a fresh list puts under `bulk`, gracefully and once each, logs each outcome,
/// then posts one summary notification.
fn bulk_kill(app: &AppHandle, bulk: Bulk) {
    // The menu can be up to `REFRESH_INTERVAL` stale: decide from a fresh list, never the menu.
    let listing = match crate::ports::listing() {
        Ok(listing) => listing,
        Err(e) => {
            warn(format_args!("could not list ports for a bulk kill: {e}"));
            notify(app, &format!("Could not list ports · {e}"));
            return;
        }
    };
    let entries = &listing.entries;
    let model = shortcuts_model(entries);
    let pids = bulk.pids(&model);
    if pids.is_empty() {
        notify(app, bulk.nothing_to_kill());
        signal(app, Signal::Refresh);
        return;
    }
    let mut freed: Vec<u32> = Vec::new();
    let mut refused = 0;
    for &pid in pids {
        // The model's pids come from these entries, so each has one; the first is its lowest port.
        let Some(entry) = entries.iter().find(|e| e.pid == pid) else {
            continue;
        };
        let name = entry.process_name.as_str();
        match taskline::kill_recorded(app, &listing, entry, false, bulk.event_kind()) {
            KillOutcome::Killed { graceful: true, .. } => {
                info(format_args!("killed {name} ({pid})"));
                freed.push(pid);
            }
            KillOutcome::Killed { graceful: false, .. } => {
                info(format_args!("killed {name} ({pid}) with SIGKILL after it ignored SIGTERM"));
                freed.push(pid);
            }
            KillOutcome::NotFound { .. } => {
                info(format_args!("{name} ({pid}) was already gone"));
                freed.push(pid);
            }
            KillOutcome::Refused { reason, .. } => {
                warn(format_args!("refused to kill {name} ({pid}): {reason}"));
                refused += 1;
            }
            KillOutcome::Failed { error, .. } => {
                warn(format_args!("could not kill {name} ({pid}): {error}"));
                refused += 1;
            }
        }
    }
    let ports: HashSet<(u16, Protocol)> =
        entries.iter().filter(|e| freed.contains(&e.pid)).map(|e| (e.port, e.protocol)).collect();
    notify(app, &bulk_summary(ports.len(), freed.len(), refused));
    signal(app, Signal::Refresh);
}

fn select_port_in_window(app: &AppHandle, port: u16, protocol: Protocol) {
    show_window(app);
    if let Err(e) = app.emit(SELECT_PORT_EVENT, SelectPort { port, protocol }) {
        warn(format_args!("could not tell the window to select :{port}: {e}"));
    }
}

/// A desktop notification titled with the product name. Unsigned builds may be refused by macOS;
/// that is a warning, not a failure.
fn notify(app: &AppHandle, body: &str) {
    if let Err(e) = app.notification().builder().body(body).show() {
        warn(format_args!("could not post a notification: {e}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{BindScope, Category, ProjectInfo, ProjectKind};

    fn entry(port: u16, protocol: Protocol, address: &str, pid: u32, process: &str) -> PortEntry {
        PortEntry {
            port,
            protocol,
            bind: BindScope::Loopback,
            address: address.into(),
            pid,
            process_name: process.into(),
            command: String::new(),
            cwd: None,
            exe: None,
            user: None,
            memory_bytes: 0,
            started_at: None,
            parent_pid: None,
            orphan: false,
            project: None,
            protected: false,
            category: Category::Other,
            framework: None,
        }
    }

    fn with_project(mut e: PortEntry, name: &str) -> PortEntry {
        e.project = Some(ProjectInfo {
            name: name.into(),
            root: format!("/Users/amit/work/{name}"),
            kind: ProjectKind::Node,
            branch: None,
            tool: None,
        });
        e
    }

    fn protected(mut e: PortEntry) -> PortEntry {
        e.protected = true;
        e
    }

    fn orphan(mut e: PortEntry) -> PortEntry {
        e.orphan = true;
        e
    }

    fn labels(model: &[MenuEntry]) -> Vec<&str> {
        model.iter().map(|m| m.label.as_str()).collect()
    }

    #[test]
    fn labels_use_the_project_name_or_the_process_name() {
        let entries = vec![
            with_project(entry(3000, Protocol::Tcp, "127.0.0.1", 1, "node"), "shop-api"),
            entry(5173, Protocol::Tcp, "127.0.0.1", 2, "node"),
        ];
        assert_eq!(labels(&menu_model(&entries, 12)), ["Free :3000 · shop-api", "Free :5173 · node"]);
    }

    #[test]
    fn ipv4_and_ipv6_sockets_of_one_port_are_one_line() {
        let entries = vec![
            entry(3000, Protocol::Tcp, "127.0.0.1", 1, "node"),
            entry(3000, Protocol::Tcp, "::1", 1, "node"),
            entry(3000, Protocol::Tcp, "0.0.0.0", 7, "other"),
        ];
        let model = menu_model(&entries, 12);
        assert_eq!(model.len(), 1);
        assert_eq!(model[0].label, "Free :3000 · node");
    }

    #[test]
    fn tcp_and_udp_on_the_same_port_are_two_lines_tcp_first() {
        let entries = vec![
            entry(5353, Protocol::Udp, "0.0.0.0", 1, "mdns"),
            entry(5353, Protocol::Tcp, "0.0.0.0", 2, "svc"),
        ];
        let model = menu_model(&entries, 12);
        assert_eq!(model.iter().map(|m| m.protocol).collect::<Vec<_>>(), [Protocol::Tcp, Protocol::Udp]);
    }

    #[test]
    fn sorted_by_port_within_a_protocol_whatever_the_input_order() {
        let entries = vec![
            entry(8080, Protocol::Tcp, "127.0.0.1", 1, "java"),
            entry(53, Protocol::Udp, "127.0.0.1", 2, "dns"),
            entry(3000, Protocol::Tcp, "127.0.0.1", 3, "node"),
            entry(443, Protocol::Tcp, "127.0.0.1", 4, "nginx"),
        ];
        let ports: Vec<(u16, Protocol)> = menu_model(&entries, 12).iter().map(|m| (m.port, m.protocol)).collect();
        assert_eq!(ports, [(443, Protocol::Tcp), (3000, Protocol::Tcp), (8080, Protocol::Tcp), (53, Protocol::Udp)]);
    }

    #[test]
    fn capped_at_max_after_sorting() {
        let entries: Vec<PortEntry> =
            (0..20u16).rev().map(|i| entry(4000 + i, Protocol::Tcp, "127.0.0.1", u32::from(i) + 1, "node")).collect();
        let model = menu_model(&entries, MAX_MENU_PORTS);
        assert_eq!(model.len(), 12);
        assert_eq!(model.first().map(|m| m.port), Some(4000));
        assert_eq!(model.last().map(|m| m.port), Some(4011));
        assert!(menu_model(&entries, 0).is_empty());
    }

    #[test]
    fn protected_ports_are_listed_and_marked() {
        let entries = vec![
            protected(with_project(entry(5432, Protocol::Tcp, "127.0.0.1", 1, "postgres"), "shop-db")),
            entry(3000, Protocol::Tcp, "127.0.0.1", 2, "node"),
        ];
        let model = menu_model(&entries, 12);
        assert_eq!(labels(&model), ["Free :3000 · node", "Free :5432 · shop-db (protected)"]);
        assert!(!model[0].protected);
        assert!(model[1].protected);
    }

    #[test]
    fn a_port_is_protected_when_any_process_on_it_is() {
        let entries = vec![
            entry(6379, Protocol::Tcp, "127.0.0.1", 1, "redis-server"),
            protected(entry(6379, Protocol::Tcp, "::1", 1, "redis-server")),
        ];
        let model = menu_model(&entries, 12);
        assert_eq!(model.len(), 1);
        assert!(model[0].protected);
        assert_eq!(model[0].label, "Free :6379 · redis-server (protected)");
    }

    #[test]
    fn a_later_socket_can_supply_the_project_name() {
        let entries = vec![
            entry(3000, Protocol::Tcp, "127.0.0.1", 1, "node"),
            with_project(entry(3000, Protocol::Tcp, "::1", 1, "node"), "shop-api"),
        ];
        assert_eq!(labels(&menu_model(&entries, 12)), ["Free :3000 · shop-api"]);
    }

    #[test]
    fn title_counts_freeable_ports_and_is_empty_at_zero() {
        assert_eq!(tray_title(&[]), "");
        assert_eq!(tray_tooltip(&[]), "PortReaper · 0 ports");
        let entries = vec![
            entry(3000, Protocol::Tcp, "127.0.0.1", 1, "node"),
            entry(3000, Protocol::Tcp, "::1", 1, "node"),
            protected(entry(5432, Protocol::Tcp, "127.0.0.1", 2, "postgres")),
        ];
        assert_eq!(tray_title(&entries), "1", "one port twice is one, and protected ports do not count");
        assert_eq!(tray_tooltip(&entries), "PortReaper · 1 port");
        let entries: Vec<PortEntry> =
            (0..15u16).map(|i| entry(4000 + i, Protocol::Tcp, "127.0.0.1", u32::from(i) + 1, "node")).collect();
        assert_eq!(tray_title(&entries), "15", "the count is not capped like the menu is");
        assert_eq!(tray_tooltip(&entries), "PortReaper · 15 ports");
    }

    #[test]
    fn port_ids_round_trip_and_reject_everything_else() {
        let tcp = MenuEntry { port: 3000, protocol: Protocol::Tcp, label: String::new(), protected: false };
        let udp = MenuEntry { port: 53, protocol: Protocol::Udp, label: String::new(), protected: false };
        assert_eq!(port_id(&tcp), "port:3000:tcp");
        assert_eq!(parse_port_id(&port_id(&tcp)), Some((3000, Protocol::Tcp)));
        assert_eq!(parse_port_id(&port_id(&udp)), Some((53, Protocol::Udp)));
        for bad in ["open", "quit", "port:", "port:3000", "port:x:tcp", "port:70000:tcp", "port:3000:sctp"] {
            assert_eq!(parse_port_id(bad), None, "{bad}");
        }
    }

    #[test]
    fn select_port_payload_matches_the_ui_contract() {
        let json = serde_json::to_value(SelectPort { port: 5432, protocol: Protocol::Tcp }).unwrap();
        assert_eq!(json, serde_json::json!({ "port": 5432, "protocol": "tcp" }));
    }

    #[test]
    fn header_counts_what_the_title_counts() {
        assert_eq!(header(&[]), "PortReaper · no ports");
        let one = vec![
            entry(3000, Protocol::Tcp, "127.0.0.1", 1, "node"),
            entry(3000, Protocol::Tcp, "::1", 1, "node"),
            protected(entry(5432, Protocol::Tcp, "127.0.0.1", 2, "postgres")),
        ];
        assert_eq!(header(&one), "PortReaper · 1 port", "one port twice is one, and protected ports do not count");
        let many: Vec<PortEntry> =
            (0..9u16).map(|i| entry(4000 + i, Protocol::Tcp, "127.0.0.1", u32::from(i) + 1, "node")).collect();
        assert_eq!(header(&many), "PortReaper · 9 ports");
    }

    #[test]
    fn shortcuts_model_lists_the_ports_like_the_menu_model_does() {
        let entries: Vec<PortEntry> =
            (0..20u16).map(|i| entry(4000 + i, Protocol::Tcp, "127.0.0.1", u32::from(i) + 1, "node")).collect();
        let model = shortcuts_model(&entries);
        assert_eq!(model.ports, menu_model(&entries, MAX_MENU_PORTS));
        assert_eq!(model.ports.len(), MAX_MENU_PORTS);
        assert_eq!(model.header, "PortReaper · 20 ports", "the header is not capped like the list is");
    }

    #[test]
    fn orphans_are_the_distinct_unprotected_orphan_pids() {
        let entries = vec![
            orphan(entry(3000, Protocol::Tcp, "127.0.0.1", 10, "node")),
            orphan(entry(3000, Protocol::Tcp, "::1", 10, "node")),
            orphan(entry(3001, Protocol::Tcp, "127.0.0.1", 10, "node")),
            orphan(protected(entry(5432, Protocol::Tcp, "127.0.0.1", 20, "postgres"))),
            entry(5173, Protocol::Tcp, "127.0.0.1", 30, "node"),
            orphan(entry(8080, Protocol::Tcp, "127.0.0.1", 5, "java")),
        ];
        let model = shortcuts_model(&entries);
        assert_eq!(model.orphans, [5, 10], "one pid on three sockets counts once; protected and attached ones not at all");
        assert_eq!(model.orphans_label(), "Kill lost-terminal servers (2)");
    }

    #[test]
    fn dev_servers_are_the_distinct_unprotected_pids_with_a_project() {
        let entries = vec![
            with_project(entry(3000, Protocol::Tcp, "127.0.0.1", 10, "node"), "shop-api"),
            with_project(entry(3000, Protocol::Tcp, "::1", 10, "node"), "shop-api"),
            with_project(entry(5173, Protocol::Tcp, "127.0.0.1", 11, "node"), "portreaper"),
            entry(8080, Protocol::Tcp, "127.0.0.1", 12, "java"),
            protected(with_project(entry(5432, Protocol::Tcp, "127.0.0.1", 13, "postgres"), "shop-db")),
        ];
        let model = shortcuts_model(&entries);
        assert_eq!(model.dev_servers, [10, 11], "no project or protected: not a dev server");
        assert_eq!(model.dev_servers_label(), "Kill all dev servers (2)");
    }

    #[test]
    fn a_pid_protected_on_any_socket_is_in_no_bulk_list() {
        let entries = vec![
            orphan(with_project(entry(6379, Protocol::Tcp, "127.0.0.1", 7, "redis-server"), "cache")),
            orphan(protected(with_project(entry(6379, Protocol::Tcp, "::1", 7, "redis-server"), "cache"))),
        ];
        let model = shortcuts_model(&entries);
        assert!(model.orphans.is_empty());
        assert!(model.dev_servers.is_empty());
        assert!(model.ports[0].protected, "it is still listed, marked, so the item shows the window");
    }

    #[test]
    fn bulk_items_lose_their_count_at_zero_where_they_are_disabled() {
        let model = shortcuts_model(&[]);
        assert_eq!(model.orphans_label(), "Kill lost-terminal servers");
        assert_eq!(model.dev_servers_label(), "Kill all dev servers");
        assert!(model.orphans.is_empty() && model.dev_servers.is_empty(), "both items are disabled at zero");
        assert_eq!(model.header, "PortReaper · no ports");
        assert!(model.ports.is_empty());
    }

    #[test]
    fn only_a_change_in_the_list_changes_the_model() {
        let entries = vec![orphan(with_project(entry(3000, Protocol::Tcp, "127.0.0.1", 1, "node"), "shop-api"))];
        assert_eq!(shortcuts_model(&entries), shortcuts_model(&entries.clone()));
        let mut attached = entries.clone();
        attached[0].orphan = false;
        assert_ne!(shortcuts_model(&entries), shortcuts_model(&attached), "an orphan flag alone moves a count");
    }

    #[test]
    fn bulk_summary_counts_and_pluralises() {
        assert_eq!(bulk_summary(4, 3, 0), "Freed 4 ports · 3 processes");
        assert_eq!(bulk_summary(1, 1, 0), "Freed 1 port · 1 process");
        assert_eq!(bulk_summary(2, 2, 1), "Freed 2 ports · 2 processes · 1 refused");
        assert_eq!(bulk_summary(0, 0, 2), "Could not free any port · 2 refused");
    }
}

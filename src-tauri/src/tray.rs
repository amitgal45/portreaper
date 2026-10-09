//! The menu-bar icon, its menu, and what happens when the window is closed.
//!
//! Owned by WP-4. The app lives in the Dock like a normal app; the tray is the fast path:
//! a count of open ports, "Free :3000 · shop-api" items, show/quit, and "Start at login".
//!
//! The pure part is [`menu_model`]: the port list in, the menu lines out. Everything the tray
//! shows is derived from it, so it is the part that gets unit tests.
//!
//! A Tauri 2 tray menu is static once built, so a background thread re-reads the ports every
//! [`REFRESH_INTERVAL`] (and at once whenever the window is shown) and swaps the menu on the
//! main thread, but only when the model changed, so a menu the user holds open is left alone.
//! Freeing a port from the menu goes through `crate::ports::list` and `crate::kill::kill`
//! directly, then posts a notification. Nothing here may panic: every runtime failure is a
//! [`warn`] on stderr and the app carries on.

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::Duration;

use serde::Serialize;
use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, Window, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_notification::NotificationExt as _;

use crate::model::{KillOutcome, KillRequest, PortEntry, Protocol};

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

const ID_OPEN: &str = "open";
const ID_NO_PORTS: &str = "no-ports";
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
    menu: Vec<MenuEntry>,
    title: String,
    tooltip: String,
    autostart: bool,
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let (signals, inbox) = mpsc::channel();
    app.manage(TrayState { signals });

    // Built empty; the refresh thread fills it within milliseconds.
    let snapshot = Snapshot {
        menu: Vec::new(),
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
    match app.default_window_icon() {
        // The app icon stands in until WP-6 supplies the real template icon.
        Some(icon) => tray = tray.icon(icon.clone()),
        None => warn("no default window icon; the tray shows its title only"),
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
        menu: menu_model(&entries, MAX_MENU_PORTS),
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

/// `Open PortReaper` · separator · the port items (or a disabled `No ports`) · separator ·
/// `Start at login` · `Quit PortReaper`.
fn build_menu(app: &AppHandle, snapshot: &Snapshot) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, ID_OPEN, "Open PortReaper", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    if snapshot.menu.is_empty() {
        menu.append(&MenuItem::with_id(app, ID_NO_PORTS, "No ports", false, None::<&str>)?)?;
    }
    for entry in &snapshot.menu {
        menu.append(&MenuItem::with_id(app, port_id(entry), &entry.label, true, None::<&str>)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&CheckMenuItem::with_id(app, ID_AUTOSTART, "Start at login", true, snapshot.autostart, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, ID_QUIT, "Quit PortReaper", true, None::<&str>)?)?;
    Ok(menu)
}

/// Every menu event in the app lands here, the app menu's included; ids that are not ours pass.
fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    match id {
        ID_OPEN => show_window(app),
        ID_AUTOSTART => toggle_autostart(app),
        ID_QUIT => app.exit(0),
        ID_NO_PORTS => {}
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

/// Closing the main window hides it: the tray, the Dock and ⌘⇧P bring it back; Quit ends the app.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        if window.label() != MAIN_WINDOW {
            return;
        }
        api.prevent_close();
        if let Err(e) = window.hide() {
            warn(format_args!("could not hide the window: {e}"));
        }
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
    let entries = match crate::ports::list() {
        Ok(entries) => entries,
        Err(e) => {
            warn(format_args!("could not list ports to free :{port}: {e}"));
            notify(app, &format!("Could not free port {port} · {e}"));
            return;
        }
    };
    let on_port: Vec<&PortEntry> = entries.iter().filter(|e| e.port == port && e.protocol == protocol).collect();
    if on_port.is_empty() {
        notify(app, &format!("Could not free port {port} · nothing is listening on it any more"));
        signal(app, Signal::Refresh);
        return;
    }
    if on_port.iter().any(|e| e.protected) {
        select_port_in_window(app, port, protocol);
        return;
    }

    let mut pids: Vec<u32> = on_port.iter().map(|e| e.pid).collect();
    pids.sort_unstable();
    pids.dedup();
    let mut freed = Vec::new();
    let mut failures = Vec::new();
    for pid in pids {
        let name = on_port.iter().find(|e| e.pid == pid).map_or("?", |e| e.process_name.as_str());
        match crate::kill::kill(&KillRequest { pid, force: false }) {
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
    use crate::model::{BindScope, ProjectInfo, ProjectKind};

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
}

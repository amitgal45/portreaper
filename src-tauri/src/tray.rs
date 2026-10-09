//! The menu-bar icon, its menu, and what happens when the window is closed.
//!
//! Owned by WP-4. The app lives in the Dock like a normal app; the tray is the fast path:
//! a count of open ports, "Free :3000 · shop-api" items, show/quit, and "Start at login".
//!
//! The pure part is [`menu_model`]: the port list in, the menu lines out. Everything the tray
//! shows is derived from it, so it is the part that gets unit tests.

use tauri::{AppHandle, Window, WindowEvent};

use crate::model::{PortEntry, Protocol};

/// How many "Free :PORT" items the menu shows at most.
pub const MAX_MENU_PORTS: usize = 12;

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

const ID_PORT_PREFIX: &str = "port:";

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

pub fn setup(_app: &AppHandle) -> tauri::Result<()> {
    // WP-4 replaces this stub.
    Ok(())
}

/// Called for every window event. WP-4 turns a close into a hide so the tray keeps working.
pub fn on_window_event(_window: &Window, _event: &WindowEvent) {}

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
}

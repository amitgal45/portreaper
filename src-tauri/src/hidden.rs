//! Hidden ports: the ones the user asked PortReaper to leave alone (macOS's AirPlay Receiver
//! holds 5000 and 7000 on every Mac, and most users never want to see them).
//!
//! The rule: a hidden port is hidden wherever PortReaper lists ports: by number, TCP and UDP
//! alike; a portless (`stdio`, port 0) entry cannot be hidden; the Taskline keeps what already
//! happened. The list is `Settings::hidden_ports`, stored with the other preferences and
//! normalized by [`normalize`] on the way in and out of the store.
//!
//! Every path that lists ports runs `taskline::observe` and `watch::observe` on the whole
//! listing first and filters with [`visible`] afterwards: collision detection and the watches'
//! baselines need the truth, so unhiding a port never replays or invents a transition. What the
//! user is told (the window's list, the tray's lines and count, the watches' events and
//! notifications) and what a bulk kill reaches (`reap_zombies`, the tray's two bulk items) leave
//! the hidden ports out. A kill the user asked for by pid or by port stays as it is: nothing in
//! the UI offers a hidden port.

use tauri::AppHandle;

use crate::model::PortEntry;

/// The most ports the user can hide. A list in Preferences, not a firewall: 64 is far more than
/// anyone types by hand, and it keeps the store and every lookup small.
pub const MAX_HIDDEN: usize = 64;

/// The hidden list as it is stored and looked up: port 0 dropped (a portless entry has no number
/// to hide), sorted, distinct, and the lowest [`MAX_HIDDEN`] kept.
pub fn normalize(ports: &[u16]) -> Vec<u16> {
    let mut hidden: Vec<u16> = ports.iter().copied().filter(|&port| port != 0).collect();
    hidden.sort_unstable();
    hidden.dedup();
    hidden.truncate(MAX_HIDDEN);
    hidden
}

/// Whether `port` is in `hidden`, which must be [`normalize`]d. Port 0 never is.
pub fn is_hidden(port: u16, hidden: &[u16]) -> bool {
    port != 0 && hidden.binary_search(&port).is_ok()
}

/// The entries whose port is not hidden, in their order. `entries` comes back untouched when
/// nothing is hidden, so the common case costs nothing.
pub fn visible(entries: Vec<PortEntry>, hidden: &[u16]) -> Vec<PortEntry> {
    if hidden.is_empty() {
        return entries;
    }
    entries.into_iter().filter(|e| !is_hidden(e.port, hidden)).collect()
}

/// The hidden ports as stored, already normalized by `settings::load`.
pub fn hidden_ports(app: &AppHandle) -> Vec<u16> {
    crate::settings::load(app).hidden_ports
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{BindScope, Category, Protocol};

    fn entry(port: u16, protocol: Protocol, pid: u32) -> PortEntry {
        PortEntry {
            port,
            protocol,
            bind: BindScope::Loopback,
            address: (if port == 0 { "stdio" } else { "127.0.0.1" }).to_string(),
            pid,
            process_name: "node".into(),
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
            container: None,
        }
    }

    #[test]
    fn normalize_drops_zero_sorts_dedupes_and_keeps_the_lowest_sixty_four() {
        assert!(normalize(&[]).is_empty());
        assert!(normalize(&[0, 0]).is_empty(), "a portless entry has no number to hide");
        assert_eq!(normalize(&[7000, 0, 5000, 7000, 5000]), [5000, 7000]);
        let many: Vec<u16> = (1..=70u16).rev().collect();
        let capped = normalize(&many);
        assert_eq!(capped.len(), MAX_HIDDEN);
        assert_eq!(capped.first(), Some(&1));
        assert_eq!(capped.last(), Some(&64), "the lowest 64 are kept, whatever the input order");
        assert_eq!(normalize(&capped), capped, "normalizing twice changes nothing");
    }

    #[test]
    fn only_a_listed_port_is_hidden_and_port_zero_never_is() {
        let hidden = normalize(&[7000, 5000]);
        assert!(is_hidden(5000, &hidden));
        assert!(is_hidden(7000, &hidden));
        assert!(!is_hidden(3000, &hidden), "not in the list");
        assert!(!is_hidden(0, &hidden));
        assert!(!is_hidden(0, &[0]), "even a list that holds 0, which normalize never makes");
        assert!(!is_hidden(5000, &[]));
    }

    #[test]
    fn visible_drops_tcp_and_udp_on_a_hidden_number_and_keeps_the_rest_in_order() {
        let entries = vec![
            entry(3000, Protocol::Tcp, 10),
            entry(5000, Protocol::Tcp, 635),
            entry(5000, Protocol::Udp, 635),
            entry(0, Protocol::Tcp, 20),
            entry(7000, Protocol::Tcp, 635),
            entry(8080, Protocol::Tcp, 30),
        ];
        let shown = visible(entries.clone(), &normalize(&[5000, 7000]));
        let ports: Vec<(u16, Protocol)> = shown.iter().map(|e| (e.port, e.protocol)).collect();
        assert_eq!(ports, [(3000, Protocol::Tcp), (0, Protocol::Tcp), (8080, Protocol::Tcp)]);
        assert_eq!(shown[1].address, "stdio", "the portless entry stays");
        assert_eq!(visible(entries.clone(), &[]), entries, "nothing hidden: the list as it was");
    }

    #[test]
    fn a_shown_port_keeps_the_protection_its_pid_has_on_a_hidden_one() {
        // pid 10 (node) on :3000 and on :5432, where the port protected that socket alone.
        let mut entries = vec![entry(3000, Protocol::Tcp, 10), entry(5432, Protocol::Tcp, 10), entry(8080, Protocol::Tcp, 30)];
        entries[1].protected = true;
        // What `ports::listing` does before any caller filters.
        crate::ports::protect_whole_pids(&mut entries);
        let shown = visible(entries, &normalize(&[5432]));
        let flags: Vec<(u16, bool)> = shown.iter().map(|e| (e.port, e.protected)).collect();
        assert_eq!(flags, [(3000, true), (8080, false)], "a Kill of :3000 still asks: it takes :5432 with it");
    }
}

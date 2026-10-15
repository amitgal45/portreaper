//! Watched ports: "tell me when :3000 is free" and "tell me when something takes :5432".
//!
//! Owned by WP-18. A watch is a port and a protocol the user marked. [`Watches`] is Tauri
//! managed state, one per app, a mutex around the pure [`Book`]: every watch with the state it
//! was last seen in. The book is compared with every listing the core already makes (the tray's
//! refresh thread, the UI's poll) through [`observe`], and a watch whose state changed becomes a
//! transition: the Tauri event [`EVENT`] to every window with the new [`WatchedPort`], a desktop
//! notification when the user wants them, and, for a port that went free, a `portFreed` in the
//! Taskline naming the last holder. "Taken" is not recorded: the notification and the mark in
//! the list say enough, and `collisionResolved` already covers a port PortReaper itself freed.
//!
//! The first listing after a watch is created, or after the app launched, sets its baseline
//! without a word. The watches survive a restart: the store key [`STORE_KEY`] in `settings.json`
//! holds `[{port, protocol}]`; the state is not stored, it is read again on launch.
//!
//! Nothing here panics: a poisoned mutex yields the book it holds, a missing state is a warning,
//! and every `app`-level function is safe to call from any thread.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt as _;
use tauri_plugin_store::StoreExt as _;

use crate::model::{PortEntry, Protocol, Settings, TasklineEvent, WatchState, WatchedPort};
use crate::settings::STORE_FILE;
use crate::taskline::Taskline;
use crate::tray::{info, warn};

/// The Tauri event a transition is emitted as, to all windows. The payload is the watch in its
/// new state, serialised like `watched_ports` returns it.
pub const EVENT: &str = "watch:changed";
/// The store key, in `settings.json`: an array of `{port, protocol}`.
pub const STORE_KEY: &str = "watchedPorts";
/// The `Settings` field the notifications are gated on, as WP-17a stores it next to
/// `firstRunDone`. While the key is missing the default applies.
const NOTIFICATIONS_KEY: &str = "notifications";

/// What the store keeps per watch: the port and the protocol, nothing else.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct WatchKey {
    pub port: u16,
    pub protocol: Protocol,
}

impl WatchKey {
    fn matches(&self, entry: &PortEntry) -> bool {
        entry.port == self.port && entry.protocol == self.protocol
    }
}

/// One watch between listings: its key, the state it was last seen in, and who held it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Watch {
    key: WatchKey,
    /// `None` until the first listing after the watch was created or the app launched.
    state: Option<WatchState>,
    /// The holder while listening; the last holder while free.
    pid: Option<u32>,
    process_name: Option<String>,
    project: Option<String>,
    since_ms: u64,
}

impl Watch {
    fn new(key: WatchKey, now_ms: u64) -> Self {
        Self { key, state: None, pid: None, process_name: None, project: None, since_ms: now_ms }
    }

    fn take_holder(&mut self, holder: &PortEntry) {
        self.pid = Some(holder.pid);
        self.process_name = Some(holder.process_name.clone());
        self.project = holder.project.as_ref().map(|p| p.name.clone());
    }

    /// The watch as the UI sees it. One nothing has looked at yet reads as free with no holder.
    fn snapshot(&self) -> WatchedPort {
        WatchedPort {
            port: self.key.port,
            protocol: self.key.protocol,
            state: self.state.unwrap_or(WatchState::Free),
            pid: self.pid,
            process_name: self.process_name.clone(),
            project: self.project.clone(),
            since_ms: self.since_ms,
        }
    }

    /// Compares the watch with a fresh listing and moves it on. `Some` is a transition worth
    /// telling: the watch in its new state.
    fn step(&mut self, entries: &[PortEntry], now_ms: u64) -> Option<WatchedPort> {
        // The lowest pid on the port: the IPv4 and IPv6 sockets of one server are one holder.
        let holder = entries.iter().filter(|e| self.key.matches(e)).min_by_key(|e| e.pid);
        let now = if holder.is_some() { WatchState::Listening } else { WatchState::Free };
        let before = self.state;
        // A free port keeps its last holder: that is who the notification and the feed name.
        if let Some(holder) = holder {
            self.take_holder(holder);
        }
        self.state = Some(now);
        match before {
            // The baseline: nothing to say, and the state began when the watch did.
            None => None,
            // Still the same; a listening port that changed hands got its new holder silently.
            Some(prev) if prev == now => None,
            Some(_) => {
                self.since_ms = now_ms;
                Some(self.snapshot())
            }
        }
    }
}

/// The pure book of watches, in port order with TCP first. Deterministic given the clock,
/// which every method takes as `now_ms` so the transitions can be tested.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Book {
    watches: Vec<Watch>,
}

impl Book {
    /// The book for what the store held. A port listed twice is one watch.
    pub fn from_keys(keys: impl IntoIterator<Item = WatchKey>, now_ms: u64) -> Self {
        let mut book = Self::default();
        for key in keys {
            book.add(key, now_ms);
        }
        book
    }

    /// What the store keeps.
    pub fn keys(&self) -> Vec<WatchKey> {
        self.watches.iter().map(|w| w.key).collect()
    }

    pub fn list(&self) -> Vec<WatchedPort> {
        self.watches.iter().map(Watch::snapshot).collect()
    }

    /// `false` when the port was already watched.
    pub fn add(&mut self, key: WatchKey, now_ms: u64) -> bool {
        if self.watches.iter().any(|w| w.key == key) {
            return false;
        }
        self.watches.push(Watch::new(key, now_ms));
        self.watches.sort_by_key(|w| (w.key.port, w.key.protocol != Protocol::Tcp));
        true
    }

    /// `false` when the port was not watched.
    pub fn remove(&mut self, key: WatchKey) -> bool {
        let before = self.watches.len();
        self.watches.retain(|w| w.key != key);
        self.watches.len() != before
    }

    /// Compares every watch with a fresh listing: the watches whose state changed, in port
    /// order, each in its new state. A watch seen for the first time only takes its baseline.
    pub fn diff(&mut self, entries: &[PortEntry], now_ms: u64) -> Vec<WatchedPort> {
        self.watches.iter_mut().filter_map(|w| w.step(entries, now_ms)).collect()
    }
}

/// The managed state: the one [`Book`] of the app behind a mutex.
#[derive(Default)]
pub struct Watches {
    book: Mutex<Book>,
}

impl Watches {
    /// The watches the store remembers, none of them looked at yet. A store that cannot be
    /// opened or a key that does not parse means no watches, with a warning: a watch is cheap
    /// to set again.
    pub fn load(app: &AppHandle) -> Self {
        let keys = match app.store(STORE_FILE) {
            Ok(store) => match store.get(STORE_KEY) {
                None => Vec::new(),
                Some(value) => serde_json::from_value::<Vec<WatchKey>>(value).unwrap_or_else(|e| {
                    warn(format_args!("ignoring {STORE_KEY} in {STORE_FILE}: {e}"));
                    Vec::new()
                }),
            },
            Err(e) => {
                warn(format_args!("could not open {STORE_FILE}; no port is watched: {e}"));
                Vec::new()
            }
        };
        let book = Book::from_keys(keys, now_ms());
        if !book.watches.is_empty() {
            info(format_args!("watching {} port(s) from the last session", book.watches.len()));
        }
        Self { book: Mutex::new(book) }
    }

    /// A thread that panicked while holding the book poisons the mutex; the book inside is
    /// still the best record there is, so it is used rather than lost.
    fn lock(&self) -> MutexGuard<'_, Book> {
        self.book.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn list(&self) -> Vec<WatchedPort> {
        self.lock().list()
    }

    pub fn observe(&self, entries: &[PortEntry]) -> Vec<WatchedPort> {
        self.lock().diff(entries, now_ms())
    }

    fn keys(&self) -> Vec<WatchKey> {
        self.lock().keys()
    }

    fn add(&self, key: WatchKey) -> bool {
        self.lock().add(key, now_ms())
    }

    fn remove(&self, key: WatchKey) -> bool {
        self.lock().remove(key)
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Called once from `setup`, before the tray's refresh thread starts observing: the watches
/// the store remembers become the managed state.
pub fn setup(app: &AppHandle) {
    app.manage(Watches::load(app));
}

/// The managed watches, or a warning: an app built without `.manage(Watches::load(..))` lists
/// and kills as before, it just watches nothing.
pub(crate) fn state(app: &AppHandle) -> Option<State<'_, Watches>> {
    let state = app.try_state::<Watches>();
    if state.is_none() {
        warn("the watches are not managed; no port is watched");
    }
    state
}

/// Tells every window about `watch`'s new state.
fn emit(app: &AppHandle, watch: &WatchedPort) {
    if let Err(e) = app.emit(EVENT, watch.clone()) {
        warn(format_args!("could not emit {EVENT} for port {}: {e}", watch.port));
    }
}

/// What a transition leaves in the Taskline: a `portFreed` for a port that went free, nothing
/// for one that was taken.
pub(crate) fn record_in(taskline: &Taskline, watch: &WatchedPort) -> Option<TasklineEvent> {
    (watch.state == WatchState::Free).then(|| taskline.record_watch_freed(watch))
}

/// `node (48213)`, or `process (48213)` when the OS gave no name, or whatever is known.
fn holder_label(watch: &WatchedPort) -> String {
    let name = match watch.process_name.as_deref() {
        Some("") | None => "process",
        Some(name) => name,
    };
    match watch.pid {
        Some(pid) => format!("{name} ({pid})"),
        None => name.to_string(),
    }
}

/// The notification for a transition: its title and its body.
pub fn notification_text(watch: &WatchedPort) -> (String, String) {
    let holder = holder_label(watch);
    match watch.state {
        WatchState::Free => (format!("Port {} is free", watch.port), format!("{holder} stopped listening.")),
        WatchState::Listening => (
            format!("Port {} taken", watch.port),
            match &watch.project {
                Some(project) => format!("{holder} · {project}"),
                None => holder,
            },
        ),
    }
}

/// Whether the user wants notifications: `Settings::notifications` as WP-17a stores it in
/// `settings.json`, the default while the key is not there. `crate::settings::current(app)`
/// replaces the body once it exists.
fn notifications_enabled(app: &AppHandle) -> bool {
    let stored = app.store(STORE_FILE).ok().and_then(|s| s.get(NOTIFICATIONS_KEY)).and_then(|v| v.as_bool());
    stored.unwrap_or(Settings::default().notifications)
}

/// A desktop notification with the watch's title. A refusal (an unsigned build, a user who said
/// no in System Settings) is warned about once; later ones stay quiet, and the window's toast
/// still shows.
fn post(app: &AppHandle, title: &str, body: &str) {
    static REFUSED: AtomicBool = AtomicBool::new(false);
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        if !REFUSED.swap(true, Ordering::Relaxed) {
            warn(format_args!("could not post a notification (later refusals are not logged): {e}"));
        }
    }
}

/// Looks at a fresh list for watched ports that changed state and tells about each one: the
/// windows through [`EVENT`], the Taskline for a port that went free, and a notification when
/// the user wants them. Called by every path that lists ports; the first call after a watch was
/// created or the app launched only sets the baseline.
pub fn observe(app: &AppHandle, entries: &[PortEntry]) {
    let Some(watches) = state(app) else {
        return;
    };
    let transitions = watches.observe(entries);
    if transitions.is_empty() {
        return;
    }
    let notify = notifications_enabled(app);
    for watch in &transitions {
        emit(app, watch);
        if let Some(event) = crate::taskline::state(app).and_then(|t| record_in(&t, watch)) {
            crate::taskline::emit(app, &event);
        }
        let (title, body) = notification_text(watch);
        info(format_args!("{title}: {body}"));
        if notify {
            post(app, &title, &body);
        }
    }
}

/// One listing through [`observe`], so a watch that was never looked at gets its baseline. A
/// transition found here is real and is told like any other.
fn refresh(app: &AppHandle) {
    match crate::ports::list() {
        Ok(entries) => observe(app, &entries),
        Err(e) => warn(format_args!("could not list ports to refresh the watches: {e}")),
    }
}

/// Every watch in its current state, after one fresh listing: a new session answers with real
/// states, not with baselines still to be taken.
pub fn list(app: &AppHandle) -> Vec<WatchedPort> {
    refresh(app);
    state(app).map(|w| w.list()).unwrap_or_default()
}

/// Watches `port`, stores the set, and answers with every watch in its current state.
pub fn watch(app: &AppHandle, port: u16, protocol: Protocol) -> Vec<WatchedPort> {
    if let Some(watches) = state(app) {
        if watches.add(WatchKey { port, protocol }) {
            save(app, &watches.keys());
        }
    }
    list(app)
}

/// Stops watching `port`, stores the set, and answers with every watch in its current state.
pub fn unwatch(app: &AppHandle, port: u16, protocol: Protocol) -> Vec<WatchedPort> {
    if let Some(watches) = state(app) {
        if watches.remove(WatchKey { port, protocol }) {
            save(app, &watches.keys());
        }
    }
    list(app)
}

/// Writes the set of watches to the store. A store that cannot be written is a warning: the
/// watches stand for this session.
fn save(app: &AppHandle, keys: &[WatchKey]) {
    let store = match app.store(STORE_FILE) {
        Ok(store) => store,
        Err(e) => {
            warn(format_args!("could not open {STORE_FILE} to save the watches: {e}"));
            return;
        }
    };
    let value = match serde_json::to_value(keys) {
        Ok(value) => value,
        Err(e) => {
            warn(format_args!("could not serialise the watches: {e}"));
            return;
        }
    };
    store.set(STORE_KEY, value);
    if let Err(e) = store.save() {
        warn(format_args!("could not save {STORE_FILE}: {e}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{BindScope, Category, EventKind, ProjectInfo, ProjectKind};

    fn entry(port: u16, pid: u32, name: &str) -> PortEntry {
        PortEntry {
            port,
            protocol: Protocol::Tcp,
            bind: BindScope::Loopback,
            address: "127.0.0.1".into(),
            pid,
            process_name: name.into(),
            command: format!("{name} server.js"),
            cwd: Some("/Users/amit/work/shop-api".into()),
            exe: Some(format!("/opt/homebrew/bin/{name}")),
            user: Some("amit".into()),
            memory_bytes: 412 * 1024 * 1024,
            started_at: Some(1_700_000_000),
            parent_pid: Some(900),
            orphan: false,
            project: Some(ProjectInfo {
                name: "shop-api".into(),
                root: "/Users/amit/work/shop-api".into(),
                kind: ProjectKind::Node,
                branch: None,
                tool: Some("next".into()),
            }),
            protected: false,
            category: Category::Web,
            framework: Some("Next.js".into()),
            container: None,
        }
    }

    fn tcp(port: u16) -> WatchKey {
        WatchKey { port, protocol: Protocol::Tcp }
    }

    const T0: u64 = 1_700_000_000_000;

    #[test]
    fn a_new_watch_takes_its_baseline_without_a_word() {
        let mut book = Book::from_keys([tcp(5432), tcp(3000)], T0);
        assert!(book.diff(&[entry(3000, 48213, "node")], T0 + 1).is_empty());
        let list = book.list();
        assert_eq!(
            list[0],
            WatchedPort {
                port: 3000,
                protocol: Protocol::Tcp,
                state: WatchState::Listening,
                pid: Some(48213),
                process_name: Some("node".into()),
                project: Some("shop-api".into()),
                since_ms: T0,
            },
            "listening since the watch was set, with the holder"
        );
        assert_eq!(list[1].port, 5432, "in port order");
        assert_eq!((list[1].state, list[1].pid, list[1].since_ms), (WatchState::Free, None, T0));
        // The same list again: nothing to say.
        assert!(book.diff(&[entry(3000, 48213, "node")], T0 + 2).is_empty());
        assert_eq!(book.list()[0].since_ms, T0);
    }

    #[test]
    fn listening_to_free_names_the_last_holder_once() {
        let mut book = Book::from_keys([tcp(3000)], T0);
        book.diff(&[entry(3000, 48213, "node")], T0);
        let freed = book.diff(&[], T0 + 5000);
        assert_eq!(freed.len(), 1);
        assert_eq!(freed[0].state, WatchState::Free);
        assert_eq!((freed[0].pid, freed[0].process_name.as_deref()), (Some(48213), Some("node")));
        assert_eq!(freed[0].project.as_deref(), Some("shop-api"));
        assert_eq!(freed[0].since_ms, T0 + 5000, "free since this listing");
        assert_eq!(book.list(), freed, "the book agrees with what it said");
        // Said once: the port staying free is not news.
        assert!(book.diff(&[], T0 + 6000).is_empty());
        assert_eq!(book.list()[0].since_ms, T0 + 5000);
    }

    #[test]
    fn free_to_listening_names_the_new_holder() {
        let mut book = Book::from_keys([tcp(3000)], T0);
        assert!(book.diff(&[], T0).is_empty(), "the baseline is free");
        let mut taker = entry(3000, 51022, "node");
        taker.project = None;
        let taken = book.diff(&[taker], T0 + 1);
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].state, WatchState::Listening);
        assert_eq!((taken[0].pid, taken[0].process_name.as_deref(), taken[0].project.as_deref()), (Some(51022), Some("node"), None));
        assert_eq!(taken[0].since_ms, T0 + 1);
        // Unrelated ports changing is nothing to a watch.
        assert!(book.diff(&[entry(5173, 2, "node"), entry(3000, 51022, "node")], T0 + 2).is_empty());
    }

    #[test]
    fn a_port_that_changes_hands_while_listening_is_no_transition_but_the_holder_follows() {
        let mut book = Book::from_keys([tcp(3000)], T0);
        book.diff(&[entry(3000, 48213, "node")], T0);
        assert!(book.diff(&[entry(3000, 48290, "python3")], T0 + 1).is_empty());
        let watch = &book.list()[0];
        assert_eq!((watch.pid, watch.process_name.as_deref()), (Some(48290), Some("python3")));
        assert_eq!(watch.since_ms, T0, "it never stopped listening");
        // When it frees, the feed names who held it last.
        let freed = book.diff(&[], T0 + 2);
        assert_eq!(freed[0].process_name.as_deref(), Some("python3"));
    }

    #[test]
    fn the_sockets_of_one_server_are_one_state() {
        let mut book = Book::from_keys([tcp(3000)], T0);
        let mut v6 = entry(3000, 48213, "node");
        v6.address = "::1".into();
        let v4 = entry(3000, 48213, "node");
        assert!(book.diff(&[v4.clone(), v6.clone()], T0).is_empty());
        assert_eq!(book.list()[0].pid, Some(48213));
        // One socket closing is not the port freeing up.
        assert!(book.diff(&[v6], T0 + 1).is_empty());
        assert_eq!(book.diff(&[], T0 + 2).len(), 1, "both gone: free");
        // Two different pids on one port (a forked server): the lowest pid is the holder.
        let taken = book.diff(&[entry(3000, 48300, "node"), entry(3000, 48213, "node")], T0 + 3);
        assert_eq!(taken[0].pid, Some(48213));
    }

    #[test]
    fn udp_and_tcp_on_one_number_are_two_watches() {
        let udp = WatchKey { port: 3000, protocol: Protocol::Udp };
        let mut book = Book::from_keys([udp, tcp(3000)], T0);
        assert_eq!(book.keys(), [tcp(3000), udp], "TCP first");
        let mut mdns = entry(3000, 4102, "mdns");
        mdns.protocol = Protocol::Udp;
        assert!(book.diff(&[mdns.clone()], T0).is_empty());
        let list = book.list();
        assert_eq!((list[0].protocol, list[0].state), (Protocol::Tcp, WatchState::Free));
        assert_eq!((list[1].protocol, list[1].state), (Protocol::Udp, WatchState::Listening));
        let freed = book.diff(&[], T0 + 1);
        assert_eq!(freed.len(), 1);
        assert_eq!(freed[0].protocol, Protocol::Udp);
    }

    #[test]
    fn the_store_round_trips_port_and_protocol() {
        let keys = vec![tcp(3000), WatchKey { port: 5432, protocol: Protocol::Udp }];
        let json = serde_json::to_value(&keys).unwrap();
        assert_eq!(
            json,
            serde_json::json!([{ "port": 3000, "protocol": "tcp" }, { "port": 5432, "protocol": "udp" }])
        );
        let back: Vec<WatchKey> = serde_json::from_value(json).unwrap();
        assert_eq!(back, keys);
        // A store with the same port twice: one watch, and the book keeps its order.
        let book = Book::from_keys([tcp(3000), tcp(3000), tcp(80)], T0);
        assert_eq!(book.keys(), [tcp(80), tcp(3000)]);
        // What the store gets after the UI's add and remove.
        let mut book = Book::default();
        assert!(book.add(tcp(3000), T0));
        assert!(!book.add(tcp(3000), T0), "already watched");
        assert!(book.remove(tcp(3000)));
        assert!(!book.remove(tcp(3000)), "not watched");
        assert!(book.keys().is_empty());
    }

    #[test]
    fn a_freed_port_lands_in_the_taskline_once_and_a_taken_one_does_not() {
        let taskline = Taskline::default();
        let mut book = Book::from_keys([tcp(3000)], T0);
        book.diff(&[entry(3000, 48213, "node")], T0);

        let freed = book.diff(&[], T0 + 1);
        let event = record_in(&taskline, &freed[0]).expect("a freed port is recorded");
        assert_eq!(event.kind, EventKind::PortFreed);
        assert_eq!(event.message, "Port 3000 is free (watched).");
        assert_eq!((event.port, event.protocol, event.pid), (3000, Protocol::Tcp, 48213));
        assert_eq!(event.process_name, "node");
        assert_eq!(event.project.as_deref(), Some("shop-api"));
        assert_eq!((event.memory_bytes, event.duration_ms), (0, 0), "nothing was killed");
        assert!(!event.relaunchable, "we did not stop it, so we do not offer to bring it back");
        assert_eq!(taskline.events(), [event.clone()], "exactly one event");

        let taken = book.diff(&[entry(3000, 51022, "node")], T0 + 2);
        assert!(record_in(&taskline, &taken[0]).is_none(), "taken is not news for the feed");
        assert_eq!(taskline.events().len(), 1);
    }

    #[test]
    fn the_notification_reads_like_the_spec() {
        let mut book = Book::from_keys([tcp(3000)], T0);
        book.diff(&[entry(3000, 48213, "node")], T0);
        let freed = book.diff(&[], T0 + 1);
        assert_eq!(notification_text(&freed[0]), ("Port 3000 is free".into(), "node (48213) stopped listening.".into()));

        let mut taker = entry(3000, 51022, "node");
        taker.project = None;
        let taken = book.diff(&[taker], T0 + 2);
        assert_eq!(notification_text(&taken[0]), ("Port 3000 taken".into(), "node (51022)".into()));

        book.diff(&[], T0 + 3);
        let taken = book.diff(&[entry(3000, 51022, "node")], T0 + 4);
        assert_eq!(notification_text(&taken[0]).1, "node (51022) · shop-api");

        // A holder the OS would not name.
        book.diff(&[], T0 + 5);
        let taken = book.diff(&[entry(3000, 7, "")], T0 + 6);
        assert_eq!(notification_text(&taken[0]).1, "process (7) · shop-api");
    }

    #[test]
    fn the_managed_watches_survive_a_poisoned_lock() {
        let watches = std::sync::Arc::new(Watches::default());
        assert!(watches.add(tcp(3000)));
        let poisoner = std::sync::Arc::clone(&watches);
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.lock();
            panic!("poison the book on purpose");
        })
        .join();
        assert!(watches.book.is_poisoned());
        assert_eq!(watches.list().len(), 1, "what it holds is still readable");
        assert!(watches.observe(&[entry(3000, 48213, "node")]).is_empty(), "and still takes a baseline");
        assert!(watches.remove(tcp(3000)), "and writable");
        assert!(watches.keys().is_empty());
    }
}

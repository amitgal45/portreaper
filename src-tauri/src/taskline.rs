//! The Taskline: the session log of what PortReaper did, kept in the core so that a kill from
//! the Studio, the HUD or the tray lands in one feed.
//!
//! Owned by WP-10. [`Taskline`] is Tauri managed state, one per app, a mutex around the pure
//! [`Log`]: the events newest first and capped at [`CAP`]; a [`KillRecord`] (argv, cwd, exe) for
//! every event that can be relaunched; and a mark for each port freed in the last
//! [`COLLISION_WINDOW`], so that [`Log::observe`] can turn "that port now has a different pid"
//! into a `collisionResolved` event, the closest the machine comes to telling us somebody's
//! `EADDRINUSE` went away. Every event is also emitted as the Tauri event [`EVENT`] to all
//! windows, so the Studio and the HUD learn of a tray kill without polling.
//!
//! Nothing here panics: a poisoned mutex yields what it holds (an event half-written is still
//! an event), a missing state is a warning, and every `app`-level function is safe to call from
//! any thread.

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::model::{EventKind, KillOutcome, KillRequest, PortEntry, Protocol, TasklineEvent};
use crate::ports::Listing;
use crate::tray::warn;

/// The Tauri event every recorded [`TasklineEvent`] is emitted as, to all windows. The payload
/// is the event itself, serialised like `taskline_events` returns it.
pub const EVENT: &str = "taskline:event";
/// How many events the session keeps. Older ones fall off the end, their records with them.
pub const CAP: usize = 500;
/// How long after we freed a port a different pid on it counts as a resolved collision.
pub const COLLISION_WINDOW: Duration = Duration::from_secs(60);

/// What relaunching needs: the command line as it was, where it ran, and the binary that ran.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KillRecord {
    pub argv: Vec<String>,
    pub cwd: String,
    pub exe: Option<String>,
}

/// A port we freed, waiting to see who takes it.
#[derive(Debug, Clone)]
struct FreedMark {
    at: Instant,
    old_pid: u32,
    old_name: String,
}

/// The pure log. Every method is deterministic given the clock, which [`Log::observe_at`] takes
/// as a parameter so the window can be tested.
#[derive(Default)]
pub(crate) struct Log {
    /// Newest first.
    events: VecDeque<TasklineEvent>,
    /// By event id, for the events whose `relaunchable` is true.
    records: HashMap<u64, KillRecord>,
    recently_freed: HashMap<(u16, Protocol), FreedMark>,
    /// The last id handed out; ids are monotonic for the session and never reused after `clear`.
    next_id: u64,
}

impl Log {
    /// Records what a kill did to `entry`'s process. `argv` is the command line relaunch would
    /// need (none when sysinfo could not read it), `elapsed` how long the whole kill took, and
    /// `kind_override` lets a bulk action name the event (`ZombieReaped`); it applies only when
    /// the process was in fact killed, since a refusal is a refusal whoever asked.
    pub fn record_kill(
        &mut self,
        entry: &PortEntry,
        argv: Option<&[String]>,
        request: &KillRequest,
        outcome: &KillOutcome,
        elapsed: Duration,
        kind_override: Option<EventKind>,
    ) -> TasklineEvent {
        let name = display_name(entry);
        let pid = entry.pid;
        let port = entry.port;
        let (kind, message, duration_ms) = match outcome {
            KillOutcome::Killed { graceful, waited_ms, .. } => {
                let (kind, message) = match (kind_override, request.force, *graceful) {
                    (Some(EventKind::ZombieReaped), _, _) => {
                        (EventKind::ZombieReaped, format!("Reaped {name} ({pid}), a lost-terminal server on port {port}."))
                    }
                    (_, true, _) => (EventKind::ForceKilled, format!("Force-killed {name} ({pid}). Port {port} is free.")),
                    (_, false, false) => (
                        EventKind::ForceKilled,
                        format!("Killed {name} ({pid}) with SIGKILL after it ignored SIGTERM. Port {port} is free."),
                    ),
                    (_, false, true) => (EventKind::PortFreed, format!("Killed {name} ({pid}). Port {port} is free.")),
                };
                (kind, message, *waited_ms)
            }
            KillOutcome::NotFound { .. } => {
                (EventKind::PortFreed, format!("{name} ({pid}) was already gone. Port {port} is free."), millis(elapsed))
            }
            KillOutcome::Refused { reason, .. } => {
                (EventKind::Refused, format!("Refused to kill {name} ({pid}): {reason}."), millis(elapsed))
            }
            KillOutcome::Failed { error, .. } => {
                (EventKind::Failed, format!("Could not kill {name} ({pid}): {error}."), millis(elapsed))
            }
        };

        let killed = matches!(outcome, KillOutcome::Killed { .. });
        // Relaunching needs the arguments and the directory; a protected process is never
        // brought back by a click, the user starts those on purpose.
        let record = match (killed && !entry.protected, argv, &entry.cwd) {
            (true, Some(argv), Some(cwd)) if !argv.is_empty() => {
                Some(KillRecord { argv: argv.to_vec(), cwd: cwd.clone(), exe: entry.exe.clone() })
            }
            _ => None,
        };
        if killed {
            self.recently_freed.insert(
                (entry.port, entry.protocol),
                FreedMark { at: Instant::now(), old_pid: pid, old_name: name.to_string() },
            );
        }

        let event = self.push(kind, entry, pid, entry.memory_bytes, duration_ms, message, record.is_some());
        if let Some(record) = record {
            self.records.insert(event.id, record);
        }
        event
    }

    /// Records what stopping a container did to `entry`'s port (WP-20): the port is freed, the
    /// process behind it (Docker's backend) stays. `container` is `None` only for a refusal
    /// decided before `docker` ran, where the request could not name one. Nothing here is
    /// relaunchable (a stopped container is started on purpose, `docker start`, not by a click)
    /// and no memory came back that the feed could count: the backend keeps its own.
    pub fn record_stop(
        &mut self,
        entry: &PortEntry,
        container: Option<&str>,
        force: bool,
        outcome: &KillOutcome,
        elapsed: Duration,
    ) -> TasklineEvent {
        let port = entry.port;
        let subject = match container {
            Some(name) => format!("container {name}"),
            None => format!("a container of {} ({})", display_name(entry), entry.pid),
        };
        let (kind, message, duration_ms) = match outcome {
            KillOutcome::Killed { waited_ms, .. } if force => {
                (EventKind::ForceKilled, format!("Killed {subject}. Port {port} is free."), *waited_ms)
            }
            KillOutcome::Killed { waited_ms, .. } => {
                (EventKind::PortFreed, format!("Stopped {subject}. Port {port} is free."), *waited_ms)
            }
            KillOutcome::NotFound { .. } => (
                EventKind::PortFreed,
                format!("{} was already stopped. Port {port} is free.", capitalised(&subject)),
                millis(elapsed),
            ),
            KillOutcome::Refused { reason, .. } => {
                (EventKind::Refused, format!("Refused to stop {subject}: {reason}."), millis(elapsed))
            }
            KillOutcome::Failed { error, .. } => {
                (EventKind::Failed, format!("Could not stop {subject}: {error}."), millis(elapsed))
            }
        };
        if matches!(outcome, KillOutcome::Killed { .. }) {
            // A restarted container comes back under the same backend pid: `observe` stays quiet
            // for it, as it does for a kill that did not take, and speaks for a different pid.
            self.recently_freed.insert(
                (entry.port, entry.protocol),
                FreedMark { at: Instant::now(), old_pid: entry.pid, old_name: subject },
            );
        }
        self.push(kind, entry, entry.pid, 0, duration_ms, message, false)
    }

    /// Records that `source`'s process is running again as `pid`.
    pub fn record_relaunch(&mut self, source: &TasklineEvent, pid: u32, elapsed: Duration) -> TasklineEvent {
        let message = format!("Relaunched {} on port {} (new pid {pid}).", source.process_name, source.port);
        let event = TasklineEvent {
            id: self.take_id(),
            at_ms: now_ms(),
            kind: EventKind::Relaunched,
            port: source.port,
            protocol: source.protocol,
            pid,
            process_name: source.process_name.clone(),
            project: source.project.clone(),
            // Nothing was killed: no memory came back, and there is nothing to relaunch from here.
            memory_bytes: 0,
            duration_ms: millis(elapsed),
            message,
            relaunchable: false,
        };
        self.insert(event.clone());
        event
    }

    /// Looks at a fresh list for ports we freed lately that another process has taken, and
    /// records a `collisionResolved` for each. A port retaken by the same pid means the kill did
    /// not take; that is not an event (the next kill will say so), and the mark is dropped.
    pub fn observe(&mut self, entries: &[PortEntry]) -> Vec<TasklineEvent> {
        self.observe_at(entries, Instant::now())
    }

    fn observe_at(&mut self, entries: &[PortEntry], now: Instant) -> Vec<TasklineEvent> {
        self.recently_freed.retain(|_, mark| now.duration_since(mark.at) <= COLLISION_WINDOW);
        let mut taken: Vec<((u16, Protocol), FreedMark, PortEntry)> = Vec::new();
        for entry in entries {
            if let Some(mark) = self.recently_freed.remove(&(entry.port, entry.protocol)) {
                taken.push(((entry.port, entry.protocol), mark, entry.clone()));
            }
        }
        // In port order, TCP first, so two collisions in one poll read like the list does.
        taken.sort_by_key(|((port, protocol), _, _)| (*port, *protocol != Protocol::Tcp));
        taken
            .into_iter()
            .filter(|(_, mark, entry)| entry.pid != mark.old_pid)
            .map(|(_, mark, entry)| {
                let message = format!(
                    "Port {}, freed from {} ({}), is now {} ({}).",
                    entry.port,
                    mark.old_name,
                    mark.old_pid,
                    display_name(&entry),
                    entry.pid
                );
                self.push(EventKind::CollisionResolved, &entry, entry.pid, 0, 0, message, false)
            })
            .collect()
    }

    /// Everything recorded, newest first.
    pub fn events(&self) -> Vec<TasklineEvent> {
        self.events.iter().cloned().collect()
    }

    /// Forgets the session: the feed, the records and the marks. Ids keep counting, so an event
    /// the UI still holds can never be confused with a new one.
    pub fn clear(&mut self) {
        self.events.clear();
        self.records.clear();
        self.recently_freed.clear();
    }

    /// The event with `id` and, when it can be relaunched, its record.
    pub fn source(&self, id: u64) -> Option<(TasklineEvent, Option<KillRecord>)> {
        let event = self.events.iter().find(|e| e.id == id)?;
        Some((event.clone(), self.records.get(&id).cloned()))
    }

    fn push(
        &mut self,
        kind: EventKind,
        entry: &PortEntry,
        pid: u32,
        memory_bytes: u64,
        duration_ms: u64,
        message: String,
        relaunchable: bool,
    ) -> TasklineEvent {
        let event = TasklineEvent {
            id: self.take_id(),
            at_ms: now_ms(),
            kind,
            port: entry.port,
            protocol: entry.protocol,
            pid,
            process_name: entry.process_name.clone(),
            project: entry.project.as_ref().map(|p| p.name.clone()),
            memory_bytes,
            duration_ms,
            message,
            relaunchable,
        };
        self.insert(event.clone());
        event
    }

    fn insert(&mut self, event: TasklineEvent) {
        self.events.push_front(event);
        while self.events.len() > CAP {
            if let Some(old) = self.events.pop_back() {
                self.records.remove(&old.id);
            }
        }
    }

    fn take_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }
}

/// `process` when the OS gave no name, so a sentence never reads "Killed  (48213)".
fn display_name(entry: &PortEntry) -> &str {
    if entry.process_name.is_empty() {
        "process"
    } else {
        &entry.process_name
    }
}

/// `container shop-db` → `Container shop-db`, for the start of a sentence.
fn capitalised(subject: &str) -> String {
    let mut chars = subject.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

fn millis(elapsed: Duration) -> u64 {
    u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| millis(d))
}

/// The managed state: the one [`Log`] of the session behind a mutex.
#[derive(Default)]
pub struct Taskline {
    log: Mutex<Log>,
}

impl Taskline {
    /// A thread that panicked while holding the log poisons the mutex; the log inside is still
    /// the best record there is, so it is used rather than lost.
    fn lock(&self) -> MutexGuard<'_, Log> {
        self.log.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Kills `request.pid`, timed, and records what happened to `entry`. This is the one kill
    /// path for every surface, so the tests of relaunch go through it too.
    pub fn kill_and_record(
        &self,
        entry: &PortEntry,
        argv: Option<&[String]>,
        request: &KillRequest,
        kind_override: Option<EventKind>,
    ) -> (KillOutcome, TasklineEvent) {
        let started = Instant::now();
        let outcome = crate::kill::kill(request);
        let event = self.lock().record_kill(entry, argv, request, &outcome, started.elapsed(), kind_override);
        (outcome, event)
    }

    /// Stops `container` (`docker stop`, or `docker kill` when `force`), timed, and records what
    /// happened to `entry`'s port (WP-20). The twin of [`Taskline::kill_and_record`] for the one
    /// kind of entry whose Kill must not touch the process.
    pub fn stop_and_record(&self, entry: &PortEntry, container: &str, force: bool) -> (KillOutcome, TasklineEvent) {
        let started = Instant::now();
        let outcome = crate::docker::stop(container, force, entry.pid);
        let event = self.lock().record_stop(entry, Some(container), force, &outcome, started.elapsed());
        (outcome, event)
    }

    pub fn record_relaunch(&self, source: &TasklineEvent, pid: u32, elapsed: Duration) -> TasklineEvent {
        self.lock().record_relaunch(source, pid, elapsed)
    }

    pub fn observe(&self, entries: &[PortEntry]) -> Vec<TasklineEvent> {
        self.lock().observe(entries)
    }

    pub fn events(&self) -> Vec<TasklineEvent> {
        self.lock().events()
    }

    pub fn clear(&self) {
        self.lock().clear();
    }

    pub fn source(&self, id: u64) -> Option<(TasklineEvent, Option<KillRecord>)> {
        self.lock().source(id)
    }
}

/// The managed Taskline, or a warning: an app built without `.manage(Taskline::default())`
/// still kills, it just does not remember.
pub(crate) fn state(app: &AppHandle) -> Option<State<'_, Taskline>> {
    let state = app.try_state::<Taskline>();
    if state.is_none() {
        warn("the Taskline is not managed; nothing is recorded");
    }
    state
}

/// Tells every window about `event`. A window that is not open yet reads the feed when it does.
pub(crate) fn emit(app: &AppHandle, event: &TasklineEvent) {
    if let Err(e) = app.emit(EVENT, event.clone()) {
        warn(format_args!("could not emit {EVENT} for event {}: {e}", event.id));
    }
}

/// Kills `entry`'s process the way every surface does and records the outcome: the entry was
/// looked up in `listing` before the kill, because afterwards there is nothing left to describe.
pub(crate) fn kill_recorded(
    app: &AppHandle,
    listing: &Listing,
    entry: &PortEntry,
    force: bool,
    kind_override: Option<EventKind>,
) -> KillOutcome {
    let request = KillRequest { pid: entry.pid, force };
    let Some(taskline) = state(app) else {
        return crate::kill::kill(&request);
    };
    let argv = listing.argv.get(&entry.pid).map(Vec::as_slice);
    let (outcome, event) = taskline.kill_and_record(entry, argv, &request, kind_override);
    emit(app, &event);
    outcome
}

/// Stops the container behind `entry` the way [`kill_recorded`] kills a process, and records
/// the outcome (WP-20). The process (Docker's backend) is never signalled.
pub(crate) fn stop_recorded(app: &AppHandle, entry: &PortEntry, container: &str, force: bool) -> KillOutcome {
    let Some(taskline) = state(app) else {
        return crate::docker::stop(container, force, entry.pid);
    };
    let (outcome, event) = taskline.stop_and_record(entry, container, force);
    emit(app, &event);
    outcome
}

/// A container stop refused before `docker` ran: `commands::kill_listed` could not tell which
/// container a pid-only request meant. Recorded like every refusal, so the feed says why.
pub(crate) fn stop_refused(app: &AppHandle, entry: &PortEntry, reason: String) -> KillOutcome {
    let outcome = KillOutcome::Refused { pid: entry.pid, reason };
    if let Some(taskline) = state(app) {
        let event = taskline.lock().record_stop(entry, None, false, &outcome, Duration::ZERO);
        emit(app, &event);
    }
    outcome
}

/// Looks at a fresh list for resolved collisions and tells the windows about each one.
pub fn observe(app: &AppHandle, entries: &[PortEntry]) {
    if let Some(taskline) = state(app) {
        for event in taskline.observe(entries) {
            emit(app, &event);
        }
    }
}

pub fn events(app: &AppHandle) -> Vec<TasklineEvent> {
    state(app).map(|t| t.events()).unwrap_or_default()
}

pub fn clear(app: &AppHandle) {
    if let Some(taskline) = state(app) {
        taskline.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{BindScope, Category, ProjectInfo, ProjectKind};

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

    fn argv(name: &str) -> Vec<String> {
        vec![name.to_string(), "server.js".to_string()]
    }

    fn killed(pid: u32, graceful: bool) -> KillOutcome {
        KillOutcome::Killed { pid, graceful, waited_ms: 180 }
    }

    fn request(pid: u32, force: bool) -> KillRequest {
        KillRequest { pid, force }
    }

    const ELAPSED: Duration = Duration::from_millis(250);

    #[test]
    fn a_graceful_kill_is_port_freed_with_the_sentence_the_ui_shows() {
        let mut log = Log::default();
        let e = entry(3000, 48213, "node");
        let event = log.record_kill(&e, Some(&argv("node")), &request(48213, false), &killed(48213, true), ELAPSED, None);
        assert_eq!(event.kind, EventKind::PortFreed);
        assert_eq!(event.message, "Killed node (48213). Port 3000 is free.");
        assert_eq!((event.port, event.protocol, event.pid), (3000, Protocol::Tcp, 48213));
        assert_eq!(event.process_name, "node");
        assert_eq!(event.project.as_deref(), Some("shop-api"));
        assert_eq!(event.memory_bytes, 412 * 1024 * 1024, "what the kill gave back");
        assert_eq!(event.duration_ms, 180, "the kill's own measurement, not the round trip");
        assert!(event.relaunchable);
        assert!(event.at_ms > 1_700_000_000_000, "unix milliseconds");
        assert_eq!(log.source(event.id).unwrap().1, Some(KillRecord { argv: argv("node"), cwd: "/Users/amit/work/shop-api".into(), exe: Some("/opt/homebrew/bin/node".into()) }));
    }

    #[test]
    fn force_and_escalation_are_force_killed() {
        let mut log = Log::default();
        let e = entry(3000, 48213, "node");
        let forced = log.record_kill(&e, Some(&argv("node")), &request(48213, true), &killed(48213, false), ELAPSED, None);
        assert_eq!(forced.kind, EventKind::ForceKilled);
        assert_eq!(forced.message, "Force-killed node (48213). Port 3000 is free.");
        assert!(forced.relaunchable);

        let escalated = log.record_kill(&e, Some(&argv("node")), &request(48213, false), &killed(48213, false), ELAPSED, None);
        assert_eq!(escalated.kind, EventKind::ForceKilled);
        assert_eq!(escalated.message, "Killed node (48213) with SIGKILL after it ignored SIGTERM. Port 3000 is free.");
    }

    #[test]
    fn a_reaped_zombie_says_so_but_a_refusal_is_a_refusal_whoever_asked() {
        let mut log = Log::default();
        let mut e = entry(5174, 39871, "node");
        e.orphan = true;
        let reaped = log.record_kill(&e, Some(&argv("node")), &request(39871, false), &killed(39871, true), ELAPSED, Some(EventKind::ZombieReaped));
        assert_eq!(reaped.kind, EventKind::ZombieReaped);
        assert_eq!(reaped.message, "Reaped node (39871), a lost-terminal server on port 5174.");
        assert!(reaped.relaunchable);

        let refused = KillOutcome::Refused { pid: 39871, reason: "not permitted: it belongs to another user".into() };
        let event = log.record_kill(&e, None, &request(39871, false), &refused, ELAPSED, Some(EventKind::ZombieReaped));
        assert_eq!(event.kind, EventKind::Refused);
        assert_eq!(event.message, "Refused to kill node (39871): not permitted: it belongs to another user.");
        assert_eq!(event.duration_ms, 250, "no kill to measure: the round trip");
        assert!(!event.relaunchable);
    }

    #[test]
    fn failures_and_vanished_processes_keep_their_reason() {
        let mut log = Log::default();
        let e = entry(8080, 22104, "node");
        let failed = KillOutcome::Failed { pid: 22104, error: "still alive after SIGKILL".into() };
        let event = log.record_kill(&e, Some(&argv("node")), &request(22104, true), &failed, ELAPSED, None);
        assert_eq!(event.kind, EventKind::Failed);
        assert_eq!(event.message, "Could not kill node (22104): still alive after SIGKILL.");
        assert!(!event.relaunchable, "it is still running; nothing to bring back");

        let gone = KillOutcome::NotFound { pid: 22104 };
        let event = log.record_kill(&e, Some(&argv("node")), &request(22104, false), &gone, ELAPSED, None);
        assert_eq!(event.kind, EventKind::PortFreed);
        assert_eq!(event.message, "node (22104) was already gone. Port 8080 is free.");
        assert!(!event.relaunchable, "we did not kill it, so we do not offer to undo it");

        let mut nameless = entry(8080, 22104, "");
        nameless.project = None;
        let event = log.record_kill(&nameless, None, &request(22104, false), &killed(22104, true), ELAPSED, None);
        assert_eq!(event.message, "Killed process (22104). Port 8080 is free.");
        assert_eq!(event.project, None);
    }

    #[test]
    fn relaunchable_needs_a_successful_kill_of_an_unprotected_process_with_argv_and_cwd() {
        let mut log = Log::default();
        let e = entry(3000, 1, "node");
        let ok = request(1, false);
        let out = killed(1, true);
        assert!(log.record_kill(&e, Some(&argv("node")), &ok, &out, ELAPSED, None).relaunchable);
        assert!(!log.record_kill(&e, None, &ok, &out, ELAPSED, None).relaunchable, "argv unreadable (another user)");
        assert!(!log.record_kill(&e, Some(&[]), &ok, &out, ELAPSED, None).relaunchable, "empty argv");
        let mut no_cwd = e.clone();
        no_cwd.cwd = None;
        assert!(!log.record_kill(&no_cwd, Some(&argv("node")), &ok, &out, ELAPSED, None).relaunchable);
        let mut protected = e.clone();
        protected.protected = true;
        let event = log.record_kill(&protected, Some(&argv("postgres")), &ok, &out, ELAPSED, None);
        assert!(!event.relaunchable, "a database is started on purpose, not by a click");
        assert_eq!(log.source(event.id).unwrap().1, None, "no record is kept for it");
    }

    #[test]
    fn events_are_newest_first_with_monotonic_ids_and_capped() {
        let mut log = Log::default();
        for i in 0..(CAP as u32 + 10) {
            let e = entry(3000 + (i % 10) as u16, 1000 + i, "node");
            log.record_kill(&e, Some(&argv("node")), &request(1000 + i, false), &killed(1000 + i, true), ELAPSED, None);
        }
        let events = log.events();
        assert_eq!(events.len(), CAP);
        assert_eq!(events[0].id, CAP as u64 + 10, "the newest is first");
        assert_eq!(events[CAP - 1].id, 11, "the ten oldest fell off");
        assert!(events.windows(2).all(|w| w[0].id == w[1].id + 1), "ids are consecutive, newest first");
        assert!(events.windows(2).all(|w| w[0].at_ms >= w[1].at_ms));
        assert!(log.source(1).is_none(), "an evicted event is gone, record included");
        assert!(log.source(11).is_some_and(|(_, record)| record.is_some()));
    }

    #[test]
    fn clear_forgets_everything_but_keeps_counting() {
        let mut log = Log::default();
        let e = entry(3000, 48213, "node");
        let first = log.record_kill(&e, Some(&argv("node")), &request(48213, false), &killed(48213, true), ELAPSED, None);
        log.clear();
        assert!(log.events().is_empty());
        assert!(log.source(first.id).is_none());
        assert!(log.observe(&[entry(3000, 1, "python3")]).is_empty(), "the marks went too");
        let next = log.record_kill(&e, Some(&argv("node")), &request(48213, false), &killed(48213, true), ELAPSED, None);
        assert_eq!(next.id, first.id + 1, "an id is never handed out twice in a session");
    }

    #[test]
    fn observe_reports_a_freed_port_taken_by_a_different_pid_within_the_window() {
        let mut log = Log::default();
        let e = entry(3000, 48213, "node");
        log.record_kill(&e, Some(&argv("node")), &request(48213, false), &killed(48213, true), ELAPSED, None);
        let now = Instant::now();

        // Still free: nothing to say, and the mark stays.
        assert!(log.observe_at(&[entry(5173, 2, "node")], now).is_empty());

        let mut taker = entry(3000, 48290, "python3");
        taker.project = None;
        let events = log.observe_at(&[taker.clone()], now + Duration::from_secs(30));
        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert_eq!(event.kind, EventKind::CollisionResolved);
        assert_eq!(event.message, "Port 3000, freed from node (48213), is now python3 (48290).");
        assert_eq!((event.port, event.pid, event.process_name.as_str()), (3000, 48290, "python3"));
        assert_eq!((event.memory_bytes, event.duration_ms), (0, 0), "nothing was killed");
        assert!(!event.relaunchable);
        assert_eq!(log.events().len(), 2);
        assert_eq!(log.events()[0].kind, EventKind::CollisionResolved, "newest first");

        // Said once: the same list again is silent.
        assert!(log.observe_at(&[taker], now + Duration::from_secs(31)).is_empty());
    }

    #[test]
    fn observe_is_silent_for_the_same_pid_and_after_the_window() {
        let mut log = Log::default();
        let e = entry(3000, 48213, "node");
        log.record_kill(&e, Some(&argv("node")), &request(48213, false), &killed(48213, true), ELAPSED, None);
        let now = Instant::now();
        // The kill did not take: not a collision, and the mark is spent.
        assert!(log.observe_at(&[entry(3000, 48213, "node")], now).is_empty());
        assert!(log.observe_at(&[entry(3000, 48290, "python3")], now + Duration::from_secs(1)).is_empty(), "the mark was dropped");

        // Too late: a minute on, whoever holds the port has nothing to do with us.
        log.record_kill(&e, Some(&argv("node")), &request(48213, false), &killed(48213, true), ELAPSED, None);
        let late = Instant::now() + COLLISION_WINDOW + Duration::from_secs(1);
        assert!(log.observe_at(&[entry(3000, 48290, "python3")], late).is_empty());

        // A failed kill marks nothing.
        let refused = KillOutcome::Refused { pid: 48213, reason: "launchd".into() };
        log.record_kill(&e, None, &request(48213, false), &refused, ELAPSED, None);
        assert!(log.observe_at(&[entry(3000, 48290, "python3")], Instant::now()).is_empty());

        // UDP on the same number is another port.
        log.record_kill(&e, Some(&argv("node")), &request(48213, false), &killed(48213, true), ELAPSED, None);
        let mut udp = entry(3000, 48290, "mdns");
        udp.protocol = Protocol::Udp;
        assert!(log.observe_at(&[udp], Instant::now()).is_empty());
    }

    #[test]
    fn the_managed_taskline_survives_a_poisoned_lock() {
        let taskline = std::sync::Arc::new(Taskline::default());
        let e = entry(3000, 48213, "node");
        taskline.lock().record_kill(&e, Some(&argv("node")), &request(48213, false), &killed(48213, true), ELAPSED, None);
        let poisoner = std::sync::Arc::clone(&taskline);
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.lock();
            panic!("poison the log on purpose");
        })
        .join();
        assert!(taskline.log.is_poisoned());
        assert_eq!(taskline.events().len(), 1, "what it holds is still readable");
        taskline.clear();
        assert!(taskline.events().is_empty(), "and writable");
    }

    fn container_entry() -> PortEntry {
        let mut e = entry(5432, 11710, "com.docker.backend");
        e.command = "/Applications/Docker.app/Contents/MacOS/com.docker.backend".into();
        e.cwd = Some("/".into());
        e.exe = Some("/Applications/Docker.app/Contents/MacOS/com.docker.backend".into());
        e.memory_bytes = 1200 * 1024 * 1024;
        e.project = Some(ProjectInfo { name: "postgres:16".into(), root: String::new(), kind: ProjectKind::Unknown, branch: None, tool: Some("docker".into()) });
        e.protected = true;
        e.category = Category::Db;
        e.framework = Some("PostgreSQL".into());
        e.container = Some("shop-db".into());
        e
    }

    #[test]
    fn a_container_stop_is_port_freed_with_the_sentence_the_ui_shows_and_nothing_to_relaunch() {
        let mut log = Log::default();
        let e = container_entry();
        let event = log.record_stop(&e, Some("shop-db"), false, &killed(11710, true), ELAPSED);
        assert_eq!(event.kind, EventKind::PortFreed);
        assert_eq!(event.message, "Stopped container shop-db. Port 5432 is free.");
        assert_eq!((event.port, event.protocol, event.pid), (5432, Protocol::Tcp, 11710));
        assert_eq!(event.process_name, "com.docker.backend");
        assert_eq!(event.project.as_deref(), Some("postgres:16"));
        assert_eq!(event.memory_bytes, 0, "the backend keeps its memory; nothing came back");
        assert_eq!(event.duration_ms, 180, "docker's own round trip");
        assert!(!event.relaunchable, "a container is started on purpose, not by a click");
        assert_eq!(log.source(event.id).unwrap().1, None, "no record is kept for it");

        let forced = log.record_stop(&e, Some("shop-db"), true, &killed(11710, false), ELAPSED);
        assert_eq!(forced.kind, EventKind::ForceKilled);
        assert_eq!(forced.message, "Killed container shop-db. Port 5432 is free.");
        assert!(!forced.relaunchable);
    }

    #[test]
    fn a_container_stop_that_did_not_happen_keeps_its_reason() {
        let mut log = Log::default();
        let e = container_entry();
        let gone = log.record_stop(&e, Some("shop-db"), false, &KillOutcome::NotFound { pid: 11710 }, ELAPSED);
        assert_eq!(gone.kind, EventKind::PortFreed);
        assert_eq!(gone.message, "Container shop-db was already stopped. Port 5432 is free.");
        assert_eq!(gone.duration_ms, 250, "no stop to measure: the round trip");

        let failed = KillOutcome::Failed { pid: 11710, error: "Cannot connect to the Docker daemon".into() };
        let event = log.record_stop(&e, Some("shop-db"), false, &failed, ELAPSED);
        assert_eq!(event.kind, EventKind::Failed);
        assert_eq!(event.message, "Could not stop container shop-db: Cannot connect to the Docker daemon.");

        // Refused before docker ran: the request named the pid, not the container.
        let refused = KillOutcome::Refused { pid: 11710, reason: "it publishes 2 containers (cache, shop-db) under one pid".into() };
        let event = log.record_stop(&e, None, false, &refused, Duration::ZERO);
        assert_eq!(event.kind, EventKind::Refused);
        assert_eq!(
            event.message,
            "Refused to stop a container of com.docker.backend (11710): it publishes 2 containers (cache, shop-db) under one pid."
        );
        assert!(!event.relaunchable);
        assert!(log.observe(&[entry(5432, 900, "postgres")]).is_empty(), "nothing was freed, so nothing is a collision");
    }

    #[test]
    fn a_stopped_container_coming_back_under_the_backend_is_not_a_collision_but_another_pid_is() {
        let mut log = Log::default();
        let e = container_entry();
        log.record_stop(&e, Some("shop-db"), false, &killed(11710, true), ELAPSED);
        let now = Instant::now();
        // `docker start shop-db`: the same backend pid holds the port again. Silent, mark spent.
        assert!(log.observe_at(&[container_entry()], now).is_empty());
        assert!(log.observe_at(&[entry(5432, 900, "postgres")], now + Duration::from_secs(1)).is_empty());

        log.record_stop(&e, Some("shop-db"), false, &killed(11710, true), ELAPSED);
        let events = log.observe_at(&[entry(5432, 900, "postgres")], Instant::now() + Duration::from_secs(5));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, EventKind::CollisionResolved);
        assert_eq!(events[0].message, "Port 5432, freed from container shop-db (11710), is now postgres (900).");
    }

    #[test]
    fn relaunch_record_names_the_new_pid_and_cannot_be_relaunched_itself() {
        let mut log = Log::default();
        let e = entry(3000, 48213, "node");
        let kill = log.record_kill(&e, Some(&argv("node")), &request(48213, false), &killed(48213, true), ELAPSED, None);
        let event = log.record_relaunch(&kill, 60001, Duration::from_millis(3));
        assert_eq!(event.kind, EventKind::Relaunched);
        assert_eq!(event.message, "Relaunched node on port 3000 (new pid 60001).");
        assert_eq!((event.port, event.pid, event.project.as_deref()), (3000, 60001, Some("shop-api")));
        assert_eq!(event.memory_bytes, 0);
        assert_eq!(event.duration_ms, 3);
        assert!(!event.relaunchable);
        assert_eq!(log.events().iter().map(|e| e.id).collect::<Vec<_>>(), [event.id, kill.id]);
        assert!(log.source(kill.id).unwrap().1.is_some(), "the original can be relaunched again");
    }
}

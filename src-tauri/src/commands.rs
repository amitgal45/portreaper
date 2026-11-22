//! The commands the UI can invoke. Thin: each one delegates to a module and converts errors
//! into something serialisable. Business rules live in the modules, not here.
//!
//! Every kill looks its entry up before killing (one `ports::listing()`), because afterwards
//! there is nothing left to describe, then kills and records through `taskline`. A pid the
//! listing does not have (it died, or it holds no port) is killed and not recorded.
//!
//! The hidden ports (`crate::hidden`) are left out of what the UI is shown (`list_ports`,
//! `watched_ports`) and of the one bulk kill here (`reap_zombies`). `kill_process` and
//! `free_port` are explicit requests and stay as they are: nothing in the UI offers a hidden port.
//! `free_port` kills only the processes its caller names (`KillTarget`), never whoever holds the
//! port by the time it runs.
//! Protection comes pid-wide from `ports::listing`, so a pid protected on a hidden socket is
//! still protected on the ones the user sees.

use tauri::AppHandle;

use crate::model::{
    EventKind, KillOutcome, KillRequest, KillTarget, PortEntry, ProcessNode, Protocol, RelaunchOutcome, Settings,
    TasklineEvent, WatchedPort,
};
use crate::ports::Listing;
use crate::tray::{info, warn};

/// Every listening port the user did not hide. The Taskline and the watches look at the whole
/// listing first: collisions and watch baselines need the truth, hidden ports included.
#[tauri::command]
pub fn list_ports(app: AppHandle) -> Result<Vec<PortEntry>, String> {
    let entries = crate::ports::list().map_err(|e| e.to_string())?;
    crate::taskline::observe(&app, &entries);
    crate::watch::observe(&app, &entries);
    Ok(crate::hidden::visible(entries, &crate::hidden::hidden_ports(&app)))
}

/// The start time goes through as the UI sent it: it is the process the user chose, and the fresh
/// listing's value would only describe whatever holds the pid now.
#[tauri::command]
pub fn kill_process(app: AppHandle, request: KillRequest) -> KillOutcome {
    // A list that cannot be read must not stop a kill the user asked for; it only goes unrecorded.
    match crate::ports::listing() {
        Ok(listing) => kill_listed(&app, &listing, request.pid, request.force, request.started_at, None, |_| true),
        Err(e) => {
            warn(format_args!("could not list ports before killing {}; the kill is not recorded: {e}", request.pid));
            crate::kill::kill(&request)
        }
    }
}

/// Frees `port` of the processes the caller chose, and of no other. One outcome per distinct pid
/// that holds the port now ([`free_plan`]): a pid in `expected` with the same start time is killed,
/// a protected one only when its target is `confirmed`; any other holder took the port after the
/// caller looked and is `Refused` without a signal. A chosen process that left the port gets no
/// outcome: an empty answer still means the port is free.
#[tauri::command]
pub fn free_port(
    app: AppHandle,
    port: u16,
    force: bool,
    expected: Vec<KillTarget>,
) -> Result<Vec<KillOutcome>, String> {
    let listing = crate::ports::listing().map_err(|e| e.to_string())?;
    Ok(free_plan(&listing.entries, port, &expected)
        .into_iter()
        .map(|(pid, step)| match step {
            FreeStep::Kill { started_at } => {
                kill_listed(&app, &listing, pid, force, started_at, None, |e| e.port == port)
            }
            FreeStep::Refuse { reason } => {
                info(format_args!("free :{port}: pid {pid} refused: {reason}"));
                KillOutcome::Refused { pid, reason }
            }
        })
        .collect())
}

/// What [`free_port`] does with one pid that holds the port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FreeStep {
    /// Kill it, checked against this start time (the caller's, else this listing's).
    Kill { started_at: Option<u64> },
    /// Send nothing and answer `Refused` with this reason.
    Refuse { reason: String },
}

/// The decision behind [`free_port`], one step per distinct pid on `port` in `entries`, sorted by
/// pid. Pure, so the rule is tested without a signal:
/// - a pid that is not in `expected`, or whose start time here differs from its target's, is not
///   the process the caller chose: refused;
/// - a pid protected here (pid-wide, as `ports::listing` makes it) whose target is not
///   `confirmed` is refused: the second confirmation is the core's rule, not only the UI's;
/// - anything else is killed. A start time one side does not know cannot differ; `kill::kill`
///   still checks the caller's when it has one.
pub(crate) fn free_plan(entries: &[PortEntry], port: u16, expected: &[KillTarget]) -> Vec<(u32, FreeStep)> {
    let mut pids: Vec<u32> = entries.iter().filter(|e| e.port == port).map(|e| e.pid).collect();
    pids.sort_unstable();
    pids.dedup();
    pids.into_iter()
        .map(|pid| {
            let mine = || entries.iter().filter(move |e| e.pid == pid);
            let name = mine().find(|e| e.port == port).map_or("", |e| e.process_name.as_str());
            let listed_at = mine().find_map(|e| e.started_at);
            let changed_hands = || FreeStep::Refuse {
                reason: format!(
                    "port {port} is now held by {name} ({pid}), not the process you chose; refresh and try again"
                ),
            };
            let Some(target) = expected.iter().find(|t| t.pid == pid) else {
                return (pid, changed_hands());
            };
            if matches!((target.started_at, listed_at), (Some(chosen), Some(now)) if chosen != now) {
                return (pid, changed_hands());
            }
            if mine().any(|e| e.protected) && !target.confirmed {
                let reason = format!("{name} ({pid}) is protected and was not confirmed; refresh and try again");
                return (pid, FreeStep::Refuse { reason });
            }
            (pid, FreeStep::Kill { started_at: target.started_at.or(listed_at) })
        })
        .collect()
}

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Kills every lost-terminal, unprotected process on a port the user did not hide
/// ([`reap_targets`]). One outcome per pid, each recorded as `zombieReaped` and checked against
/// the start time this listing gave it. A zombie that holds only hidden ports is left running: a
/// bulk kill never reaches what the user cannot see.
#[tauri::command]
pub fn reap_zombies(app: AppHandle) -> Result<Vec<KillOutcome>, String> {
    let listing = crate::ports::listing().map_err(|e| e.to_string())?;
    let hidden = crate::hidden::hidden_ports(&app);
    let zombie = |e: &PortEntry| reapable(e, &hidden);
    Ok(reap_targets(&listing.entries, &hidden)
        .into_iter()
        .map(|pid| {
            let started_at = started_at_of(&listing, pid);
            kill_listed(&app, &listing, pid, false, started_at, Some(EventKind::ZombieReaped), zombie)
        })
        .collect())
}

/// The start time `listing` gives `pid`: the `started_at` of its first entry, `None` when it has
/// no entry for the pid. What a kill decided from this listing checks the pid against.
fn started_at_of(listing: &Listing, pid: u32) -> Option<u64> {
    listing.entries.iter().find(|e| e.pid == pid).and_then(|e| e.started_at)
}

/// What Reap kills: the distinct, sorted pids of the entries that are orphans, not protected
/// and not on a hidden port. A pid protected on any of its sockets, a hidden one included, is
/// never a target: `ports::listing` already makes protection pid-wide, and this checks it again so
/// the rule holds for any list it is given (as `tray::visible_model` does).
pub(crate) fn reap_targets(entries: &[PortEntry], hidden: &[u16]) -> Vec<u32> {
    let mut protected: Vec<u32> = entries.iter().filter(|e| e.protected).map(|e| e.pid).collect();
    protected.sort_unstable();
    protected.dedup();
    let mut pids: Vec<u32> = entries
        .iter()
        .filter(|e| reapable(e, hidden) && protected.binary_search(&e.pid).is_err())
        .map(|e| e.pid)
        .collect();
    pids.sort_unstable();
    pids.dedup();
    pids
}

/// An entry Reap may kill: an orphan, not protected, on a port the user did not hide.
fn reapable(entry: &PortEntry, hidden: &[u16]) -> bool {
    entry.orphan && !entry.protected && !crate::hidden::is_hidden(entry.port, hidden)
}

/// Ancestry of a process, launchd first. Empty when nothing knows the pid.
#[tauri::command]
pub fn process_tree(pid: u32) -> Vec<ProcessNode> {
    crate::ports::tree(pid)
}

/// Everything PortReaper did this session, newest first.
#[tauri::command]
pub fn taskline_events(app: AppHandle) -> Vec<TasklineEvent> {
    crate::taskline::events(&app)
}

#[tauri::command]
pub fn clear_taskline(app: AppHandle) {
    crate::taskline::clear(&app);
}

/// Starts a killed process again from the command and cwd remembered for that event.
#[tauri::command]
pub fn relaunch(app: AppHandle, event_id: u64) -> RelaunchOutcome {
    crate::relaunch::relaunch(&app, event_id)
}

/// Checks GitHub Releases now and tells the user what it found in a native dialog: the offer,
/// "You're up to date", or why it could not check. Resolves when the dialog closed; never
/// resolves when the user took the update, because the app relaunches. `Err` only when the
/// check could not run at all.
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<(), String> {
    crate::update::on_thread(move || crate::update::check(&app, crate::update::Trigger::Manual)).await.map(|_| ())
}

/// Downloads and installs the update the last check found (the sidebar banner's Update and
/// Retry), then relaunches. `Err` with what the user should read when nothing was found yet or
/// the install failed; the failure was also emitted as `update:error`.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    crate::update::on_thread(move || crate::update::install_found(&app)).await?
}

/// The preferences as stored, with the live start-at-login state (WP-17a).
#[tauri::command]
pub fn get_settings(app: AppHandle) -> Settings {
    crate::settings::current(&app)
}

/// Stores `settings`, applies them (Dock icon, login item, shortcuts; the refresh interval and
/// the notification switch are read where they are used), emits `settings:changed` and returns
/// the effective value. `Err` names the field that could not be applied (a shortcut the plugin
/// cannot parse or another app owns: `quickShortcut: …` / `windowShortcut: …`); everything else
/// stands and the old shortcut stays registered.
#[tauri::command]
pub fn set_settings(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    crate::settings::update(&app, settings)
}

/// Every watched port with its current state (WP-18), after one fresh listing. A watch on a
/// hidden port is left out; it stays stored, and comes back when the port is shown again.
#[tauri::command]
pub fn watched_ports(app: AppHandle) -> Vec<WatchedPort> {
    crate::watch::list(&app)
}

/// Watches `port`; resolves with the full list afterwards.
#[tauri::command]
pub fn watch_port(app: AppHandle, port: u16, protocol: Protocol) -> Vec<WatchedPort> {
    crate::watch::watch(&app, port, protocol)
}

/// Stops watching `port`; resolves with the full list afterwards.
#[tauri::command]
pub fn unwatch_port(app: AppHandle, port: u16, protocol: Protocol) -> Vec<WatchedPort> {
    crate::watch::unwatch(&app, port, protocol)
}

/// Kills `pid` and records it against the first of its entries that `pick` accepts (the list
/// is sorted by port, so that is its lowest port). Without such an entry the kill still
/// happens, unrecorded: the user asked for it, and the Taskline cannot describe what it never
/// saw.
///
/// A pid whose picked entries publish a container (Docker's backend, which holds every
/// container's port under its one pid) is never killed here: the container is stopped instead
/// (`taskline::stop_recorded`, WP-20). When the picked entries belong to several containers the
/// request cannot say which one it meant (`kill_process` carries only the pid), and guessing
/// would stop the wrong one, so it is refused and the feed names them; `free_port` picks by
/// port, which is always one container.
///
/// `started_at` is the start time of the process the caller chose (`KillRequest::started_at`):
/// `kill::kill` refuses a pid that now belongs to another process. A container stop checks none:
/// it goes by the container's name and signals no pid.
fn kill_listed(
    app: &AppHandle,
    listing: &Listing,
    pid: u32,
    force: bool,
    started_at: Option<u64>,
    kind: Option<EventKind>,
    pick: impl Fn(&PortEntry) -> bool,
) -> KillOutcome {
    let picked: Vec<&PortEntry> = listing.entries.iter().filter(|e| e.pid == pid && pick(e)).collect();
    let Some(first) = picked.first().copied() else {
        info(format_args!("pid {pid} holds no port the list knows; killing it unrecorded"));
        return crate::kill::kill(&KillRequest { pid, force, started_at });
    };
    let mut containers: Vec<&PortEntry> = picked.iter().copied().filter(|e| e.container.is_some()).collect();
    containers.sort_by_key(|e| e.container.as_deref());
    containers.dedup_by_key(|e| e.container.clone());
    match containers.as_slice() {
        [] => crate::taskline::kill_recorded(app, listing, first, force, started_at, kind),
        [entry] => crate::taskline::stop_recorded(app, entry, entry.container.as_deref().unwrap_or_default(), force),
        several => {
            let names: Vec<&str> = several.iter().filter_map(|e| e.container.as_deref()).collect();
            let reason = format!(
                "it publishes {} containers ({}) under one pid; use Free a port on the port you mean",
                names.len(),
                names.join(", ")
            );
            crate::taskline::stop_refused(app, first, reason)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{BindScope, Category};

    fn entry(port: u16, pid: u32, orphan: bool, protected: bool) -> PortEntry {
        PortEntry {
            port,
            protocol: Protocol::Tcp,
            bind: BindScope::Loopback,
            address: "127.0.0.1".into(),
            pid,
            process_name: "node".into(),
            command: String::new(),
            cwd: None,
            exe: None,
            user: None,
            memory_bytes: 0,
            started_at: None,
            parent_pid: None,
            orphan,
            project: None,
            protected,
            category: Category::Other,
            framework: None,
            container: None,
            launchd: None,
        }
    }

    #[test]
    fn reap_spares_a_pid_protected_on_a_hidden_socket_and_an_orphan_only_on_hidden_ports() {
        let mut entries = vec![
            // pid 10: a lost terminal's node on :3000 and on :5432, where the port protects it.
            entry(3000, 10, true, false),
            entry(5432, 10, true, true),
            // pid 20: a plain lost-terminal server, on two ports.
            entry(4000, 20, true, false),
            entry(4001, 20, true, false),
            // pid 30: a lost-terminal server only on :5000.
            entry(5000, 30, true, false),
            // pid 40: its terminal is still there.
            entry(8080, 40, false, false),
        ];
        // What `ports::listing` hands every caller.
        crate::ports::protect_whole_pids(&mut entries);
        let hidden = crate::hidden::normalize(&[5432, 5000]);
        assert_eq!(
            reap_targets(&entries, &hidden),
            [20],
            "pid 10 is protected on :3000 too, and pid 30 holds only a hidden port"
        );
        assert_eq!(reap_targets(&entries, &[]), [20, 30], "nothing hidden: the orphan on :5000 is a target, pid 10 still not");
    }

    #[test]
    fn started_at_of_is_the_first_entry_of_the_pid() {
        let at = |port, pid, started_at| PortEntry { started_at, ..entry(port, pid, false, false) };
        let listing = Listing {
            entries: vec![
                at(3000, 10, Some(1_700_000_000)),
                at(3001, 10, Some(1_700_000_999)),
                at(4000, 20, None),
                at(5000, 30, Some(1_700_000_300)),
            ],
            argv: std::collections::HashMap::new(),
        };
        assert_eq!(started_at_of(&listing, 10), Some(1_700_000_000), "its first entry");
        assert_eq!(started_at_of(&listing, 20), None, "listed, start time unknown");
        assert_eq!(started_at_of(&listing, 30), Some(1_700_000_300));
        assert_eq!(started_at_of(&listing, 40), None, "not listed");
    }

    fn target(pid: u32, started_at: Option<u64>, confirmed: bool) -> KillTarget {
        KillTarget { pid, started_at, confirmed }
    }

    fn refused(step: &FreeStep) -> &str {
        match step {
            FreeStep::Refuse { reason } => reason,
            FreeStep::Kill { .. } => panic!("expected a refusal, got {step:?}"),
        }
    }

    #[test]
    fn free_plan_kills_only_the_processes_the_caller_chose() {
        let at = |port, pid, started_at| PortEntry { started_at, ..entry(port, pid, false, false) };
        let entries = vec![at(3000, 10, Some(100)), at(3000, 20, Some(200)), at(4000, 30, Some(300))];

        // Both holders chosen, with the start times the caller saw.
        let plan = free_plan(&entries, 3000, &[target(10, Some(100), false), target(20, Some(200), false)]);
        assert_eq!(
            plan,
            [(10, FreeStep::Kill { started_at: Some(100) }), (20, FreeStep::Kill { started_at: Some(200) })]
        );

        // pid 20 took the port after the caller looked: it is named and gets no signal.
        let plan = free_plan(&entries, 3000, &[target(10, Some(100), false)]);
        assert_eq!(plan[0], (10, FreeStep::Kill { started_at: Some(100) }));
        assert_eq!(
            refused(&plan[1].1),
            "port 3000 is now held by node (20), not the process you chose; refresh and try again"
        );

        // The same pid number, another process: the start time differs.
        let plan = free_plan(&entries, 3000, &[target(10, Some(99), false), target(20, Some(200), false)]);
        assert!(refused(&plan[0].1).starts_with("port 3000 is now held by node (10)"));
        assert_eq!(plan[1], (20, FreeStep::Kill { started_at: Some(200) }));

        // Nobody chosen: nobody killed. A pid on another port is never part of the plan.
        let plan = free_plan(&entries, 3000, &[target(30, Some(300), true)]);
        assert_eq!(plan.len(), 2);
        assert!(plan.iter().all(|(_, step)| matches!(step, FreeStep::Refuse { .. })));

        // The chosen process left and nothing took the port: an empty answer, the port is free.
        assert_eq!(free_plan(&entries, 5000, &[target(10, Some(100), false)]), []);
    }

    #[test]
    fn free_plan_kills_a_protected_process_only_when_confirmed() {
        let mut entries = vec![
            PortEntry { started_at: Some(100), ..entry(3000, 10, false, false) },
            // pid 10 also holds :5432, which protects it on :3000 too.
            PortEntry { started_at: Some(100), ..entry(5432, 10, false, true) },
        ];
        crate::ports::protect_whole_pids(&mut entries);

        let plan = free_plan(&entries, 3000, &[target(10, Some(100), false)]);
        assert_eq!(refused(&plan[0].1), "node (10) is protected and was not confirmed; refresh and try again");

        let plan = free_plan(&entries, 3000, &[target(10, Some(100), true)]);
        assert_eq!(plan, [(10, FreeStep::Kill { started_at: Some(100) })]);

        // Confirming one process does not confirm whoever holds the port now.
        let plan = free_plan(&entries, 3000, &[target(11, Some(100), true)]);
        assert!(refused(&plan[0].1).starts_with("port 3000 is now held by node (10)"));
    }

    #[test]
    fn free_plan_with_an_unknown_start_time_goes_by_the_pid_and_checks_what_is_known() {
        let at = |port, pid, started_at| PortEntry { started_at, ..entry(port, pid, false, false) };
        // The caller knew no start time: the kill is checked against this listing's.
        let plan = free_plan(&[at(3000, 10, Some(100))], 3000, &[target(10, None, false)]);
        assert_eq!(plan, [(10, FreeStep::Kill { started_at: Some(100) })]);
        // The listing knows none: `kill::kill` checks the caller's.
        let plan = free_plan(&[at(3000, 10, None)], 3000, &[target(10, Some(100), false)]);
        assert_eq!(plan, [(10, FreeStep::Kill { started_at: Some(100) })]);
    }

    /// A real socket and the real listing; no signal is sent, the plan is only read. The holder is
    /// this test process, which stands for "a process that took the port after the user decided".
    #[test]
    fn free_plan_refuses_a_real_listener_the_caller_did_not_choose() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let me = std::process::id();
        let listing = crate::ports::listing().expect("list ports");
        let mine = listing.entries.iter().find(|e| e.port == port && e.pid == me).expect("the listing has our socket");

        // The user chose another process on this port (it exited; we hold the port now).
        let plan = free_plan(&listing.entries, port, &[target(me.wrapping_add(1), mine.started_at, true)]);
        assert_eq!(plan.len(), 1, "only our pid holds :{port}");
        assert_eq!(plan[0].0, me);
        assert!(refused(&plan[0].1).contains("not the process you chose"), "{:?}", plan[0].1);

        // The same pid, started at another time: also not the chosen process.
        if let Some(started_at) = mine.started_at {
            let plan = free_plan(&listing.entries, port, &[target(me, Some(started_at + 1), true)]);
            assert!(refused(&plan[0].1).contains("not the process you chose"));
        }
        drop(listener);
    }

    #[test]
    fn reap_spares_a_pid_protected_on_another_socket_even_in_a_list_listing_did_not_make() {
        // No `protect_whole_pids` here: pid 10's :3000 row still says unprotected.
        let entries = vec![entry(3000, 10, true, false), entry(5432, 10, true, true), entry(4000, 20, true, false)];
        assert_eq!(reap_targets(&entries, &crate::hidden::normalize(&[5432])), [20]);
        assert_eq!(reap_targets(&entries, &[]), [20]);
    }
}

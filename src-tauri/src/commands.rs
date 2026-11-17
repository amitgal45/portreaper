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
//! Protection comes pid-wide from `ports::listing`, so a pid protected on a hidden socket is
//! still protected on the ones the user sees.

use tauri::AppHandle;

use crate::model::{
    EventKind, KillOutcome, KillRequest, PortEntry, ProcessNode, Protocol, RelaunchOutcome, Settings, TasklineEvent,
    WatchedPort,
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

#[tauri::command]
pub fn kill_process(app: AppHandle, request: KillRequest) -> KillOutcome {
    // A list that cannot be read must not stop a kill the user asked for; it only goes unrecorded.
    match crate::ports::listing() {
        Ok(listing) => kill_listed(&app, &listing, request.pid, request.force, None, |_| true),
        Err(e) => {
            warn(format_args!("could not list ports before killing {}; the kill is not recorded: {e}", request.pid));
            crate::kill::kill(&request)
        }
    }
}

/// Kills every process listening on `port`. One outcome per distinct pid.
#[tauri::command]
pub fn free_port(app: AppHandle, port: u16, force: bool) -> Result<Vec<KillOutcome>, String> {
    let listing = crate::ports::listing().map_err(|e| e.to_string())?;
    let pids = distinct_pids(&listing, |e| e.port == port);
    Ok(pids.into_iter().map(|pid| kill_listed(&app, &listing, pid, force, None, |e| e.port == port)).collect())
}

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Kills every lost-terminal, unprotected process on a port the user did not hide
/// ([`reap_targets`]). One outcome per pid, each recorded as `zombieReaped`. A zombie that holds
/// only hidden ports is left running: a bulk kill never reaches what the user cannot see.
#[tauri::command]
pub fn reap_zombies(app: AppHandle) -> Result<Vec<KillOutcome>, String> {
    let listing = crate::ports::listing().map_err(|e| e.to_string())?;
    let hidden = crate::hidden::hidden_ports(&app);
    let zombie = |e: &PortEntry| reapable(e, &hidden);
    Ok(reap_targets(&listing.entries, &hidden)
        .into_iter()
        .map(|pid| kill_listed(&app, &listing, pid, false, Some(EventKind::ZombieReaped), zombie))
        .collect())
}

/// What Reap kills: the distinct, sorted pids of the entries that are orphans, not protected
/// and not on a hidden port. `ports::listing` made protection pid-wide, so a pid protected on
/// any of its sockets, a hidden one included, is never a target.
pub(crate) fn reap_targets(entries: &[PortEntry], hidden: &[u16]) -> Vec<u32> {
    let mut pids: Vec<u32> = entries.iter().filter(|e| reapable(e, hidden)).map(|e| e.pid).collect();
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

/// The distinct, sorted pids of the entries `keep` accepts.
fn distinct_pids(listing: &Listing, keep: impl Fn(&PortEntry) -> bool) -> Vec<u32> {
    let mut pids: Vec<u32> = listing.entries.iter().filter(|e| keep(e)).map(|e| e.pid).collect();
    pids.sort_unstable();
    pids.dedup();
    pids
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
fn kill_listed(
    app: &AppHandle,
    listing: &Listing,
    pid: u32,
    force: bool,
    kind: Option<EventKind>,
    pick: impl Fn(&PortEntry) -> bool,
) -> KillOutcome {
    let picked: Vec<&PortEntry> = listing.entries.iter().filter(|e| e.pid == pid && pick(e)).collect();
    let Some(first) = picked.first().copied() else {
        info(format_args!("pid {pid} holds no port the list knows; killing it unrecorded"));
        return crate::kill::kill(&KillRequest { pid, force });
    };
    let mut containers: Vec<&PortEntry> = picked.iter().copied().filter(|e| e.container.is_some()).collect();
    containers.sort_by_key(|e| e.container.as_deref());
    containers.dedup_by_key(|e| e.container.clone());
    match containers.as_slice() {
        [] => crate::taskline::kill_recorded(app, listing, first, force, kind),
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
}

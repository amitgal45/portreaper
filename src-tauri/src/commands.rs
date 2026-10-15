//! The commands the UI can invoke. Thin: each one delegates to a module and converts errors
//! into something serialisable. Business rules live in the modules, not here.
//!
//! Every kill looks its entry up before killing (one `ports::listing()`), because afterwards
//! there is nothing left to describe, then kills and records through `taskline`. A pid the
//! listing does not have (it died, or it holds no port) is killed and not recorded.

use tauri::AppHandle;

use crate::model::{
    EventKind, KillOutcome, KillRequest, PortEntry, ProcessNode, Protocol, RelaunchOutcome, Settings, TasklineEvent,
    WatchedPort,
};
use crate::ports::Listing;
use crate::tray::{info, warn};

#[tauri::command]
pub fn list_ports(app: AppHandle) -> Result<Vec<PortEntry>, String> {
    let entries = crate::ports::list().map_err(|e| e.to_string())?;
    crate::taskline::observe(&app, &entries);
    crate::watch::observe(&app, &entries);
    Ok(entries)
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

/// Kills every lost-terminal, unprotected process. One outcome per pid, each recorded as
/// `zombieReaped`.
#[tauri::command]
pub fn reap_zombies(app: AppHandle) -> Result<Vec<KillOutcome>, String> {
    let listing = crate::ports::listing().map_err(|e| e.to_string())?;
    let zombie = |e: &PortEntry| e.orphan && !e.protected;
    let pids = distinct_pids(&listing, zombie);
    Ok(pids
        .into_iter()
        .map(|pid| kill_listed(&app, &listing, pid, false, Some(EventKind::ZombieReaped), zombie))
        .collect())
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

/// The preferences as stored, with the live start-at-login state (WP-17a). The foundation stub
/// answers the defaults.
#[tauri::command]
pub fn get_settings(_app: AppHandle) -> Settings {
    Settings::default()
}

/// Stores `settings`, applies them (Dock icon, login item, shortcuts, refresh), emits
/// `settings:changed` and returns the effective value. `Err` names the field that could not be
/// applied (a shortcut another app owns); everything else stands. The foundation stub echoes.
#[tauri::command]
pub fn set_settings(_app: AppHandle, settings: Settings) -> Result<Settings, String> {
    Ok(settings)
}

/// Every watched port with its current state (WP-18), after one fresh listing.
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
fn kill_listed(
    app: &AppHandle,
    listing: &Listing,
    pid: u32,
    force: bool,
    kind: Option<EventKind>,
    pick: impl Fn(&PortEntry) -> bool,
) -> KillOutcome {
    match listing.entries.iter().find(|e| e.pid == pid && pick(e)) {
        Some(entry) => crate::taskline::kill_recorded(app, listing, entry, force, kind),
        None => {
            info(format_args!("pid {pid} holds no port the list knows; killing it unrecorded"));
            crate::kill::kill(&KillRequest { pid, force })
        }
    }
}

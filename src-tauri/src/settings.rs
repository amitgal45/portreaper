//! Settings on disk, and the first-run rule for start at login.
//!
//! Owned by WP-8a. `settings.json` sits in the app data directory (on macOS
//! `~/Library/Application Support/dev.amitgal.portreaper/`) through `tauri-plugin-store`, the
//! same store the UI may use. One key so far: `firstRunDone`.
//!
//! "Always running" means: a release build enables start at login the first time it runs and
//! marks the store so it never does so again (the tray's "Start at login" check item is the way
//! back). A dev build never registers a login item, which would point at the debug binary, and
//! never touches the flag, so the release build's first run is still a first run. The decision
//! itself is [`should_enable_autostart`], pure and tested.

use std::io::ErrorKind;

use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_store::StoreExt as _;

use crate::tray::{info, warn};

/// The store file, relative to the app data directory.
pub const STORE_FILE: &str = "settings.json";
/// `true` once a release build has run: the key the first-run rule reads and writes.
pub const FIRST_RUN_DONE: &str = "firstRunDone";

/// Only a release build enables start at login, and only on its first run.
pub fn should_enable_autostart(first_run: bool, debug: bool) -> bool {
    first_run && !debug
}

/// Whether a release build has run before. A store that is missing is a fresh install; one that
/// exists but cannot be read counts as "done": start at login is never enabled on a guess.
pub fn first_run_done(app: &AppHandle) -> bool {
    let store = match app.store(STORE_FILE) {
        Ok(store) => store,
        Err(e) => {
            warn(format_args!("could not open {STORE_FILE}; treating this as not the first run: {e}"));
            return true;
        }
    };
    match store.reload() {
        Ok(()) => store.get(FIRST_RUN_DONE).and_then(|v| v.as_bool()).unwrap_or(false),
        Err(tauri_plugin_store::Error::Io(e)) if e.kind() == ErrorKind::NotFound => false,
        Err(e) => {
            warn(format_args!("could not read {STORE_FILE}; treating this as not the first run: {e}"));
            true
        }
    }
}

/// Records that the first run happened, so start at login is enabled once and never again.
pub fn mark_first_run(app: &AppHandle) {
    let store = match app.store(STORE_FILE) {
        Ok(store) => store,
        Err(e) => {
            warn(format_args!("could not open {STORE_FILE} to mark the first run: {e}"));
            return;
        }
    };
    store.set(FIRST_RUN_DONE, true);
    if let Err(e) = store.save() {
        warn(format_args!("could not save {STORE_FILE}: {e}"));
    }
}

/// Called once from `setup`: on a release build's first run, enables start at login and marks
/// the run. A failed enable is a warning; the mark is set anyway, so the app never fights a
/// user who turns it off later.
pub fn enable_autostart_on_first_run(app: &AppHandle) {
    let debug = cfg!(debug_assertions);
    // A dev build reads nothing and writes nothing: the flag must stay unset for the release
    // build's first run, which shares this store.
    let first_run = !debug && !first_run_done(app);
    if !should_enable_autostart(first_run, debug) {
        return;
    }
    match app.autolaunch().enable() {
        Ok(()) => info("first run: start at login is on; the tray's check item turns it off"),
        Err(e) => warn(format_args!("could not enable start at login on first run: {e}")),
    }
    mark_first_run(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_release_build_on_its_first_run_enables_autostart() {
        assert!(should_enable_autostart(true, false));
        assert!(!should_enable_autostart(true, true), "a dev build would register the debug binary");
        assert!(!should_enable_autostart(false, false), "not the first run: the user's choice stands");
        assert!(!should_enable_autostart(false, true));
    }
}

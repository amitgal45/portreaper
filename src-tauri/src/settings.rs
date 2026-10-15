//! Settings on disk, applied live, announced as `settings:changed`; and the first-run rule for
//! start at login.
//!
//! Owned by WP-8a, made real by WP-17a. `settings.json` sits in the app data directory (on macOS
//! `~/Library/Application Support/dev.amitgal.portreaper/`) through `tauri-plugin-store`, the
//! same store the UI may use. Every field of [`Settings`] is one top-level key in it, camelCase
//! as in the contract, next to `firstRunDone`. A key that is missing (a store written by 0.2.1)
//! or holds nonsense falls back to its default, field by field, so an old store upgrades
//! silently: that rule is [`merge_defaults`], pure and tested.
//!
//! A change goes through [`update`]: validate, store, apply, emit, in that order
//! ([`apply_order`]). Applying means the thing happens now: the Dock icon through the activation
//! policy, start at login through the autostart plugin, the shortcuts through
//! `crate::shortcuts`. The refresh interval and the notification switch are applied to nothing:
//! the tray reads them from the store on every tick, the UI from `get_settings`. A shortcut the
//! plugin rejects or another app owns is the one failure that is an error (`Err` naming the
//! field; the old accelerator stays registered and stored); every other failure is a warning in
//! the log and the state stays valid.
//!
//! "Always running" means: a release build enables start at login the first time it runs and
//! marks the store so it never does so again (the tray's "Start at login" check item and the
//! Preferences toggle are the way back). A dev build never registers a login item on its own,
//! which would point at the debug binary, and never touches the flag, so the release build's
//! first run is still a first run. The decision itself is [`should_enable_autostart`], pure and
//! tested.

use std::io::ErrorKind;

use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_store::StoreExt as _;

use crate::model::{DockIcon, Settings};
use crate::shortcuts;
use crate::tray::{info, warn};

/// The store file, relative to the app data directory.
pub const STORE_FILE: &str = "settings.json";
/// `true` once a release build has run: the key the first-run rule reads and writes.
pub const FIRST_RUN_DONE: &str = "firstRunDone";
/// Emitted to every window after a change went through [`update`]. Payload: the effective
/// [`Settings`], what `get_settings` would now return.
pub const CHANGED_EVENT: &str = "settings:changed";
/// The bounds of `refreshMs`: faster than a second would make the tray a CPU hog, slower than
/// half a minute makes it lie.
pub const MIN_REFRESH_MS: u32 = 1_000;
pub const MAX_REFRESH_MS: u32 = 30_000;

/// The steps of [`update`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Reject what can never be applied (a shortcut the plugin cannot parse) before anything is written.
    Validate,
    /// Write the store, so a crash while applying loses nothing the user chose.
    Store,
    /// Make it happen: Dock icon, login item, shortcuts.
    Apply,
    /// Tell every window what is in effect now.
    Emit,
}

/// Validate, store, apply, emit: the store before the apply so nothing chosen is lost, the apply
/// before the emit so the event carries what is in effect.
pub fn apply_order() -> [Step; 4] {
    [Step::Validate, Step::Store, Step::Apply, Step::Emit]
}

/// `refreshMs` within [`MIN_REFRESH_MS`]..=[`MAX_REFRESH_MS`].
pub fn clamp_refresh_ms(ms: u32) -> u32 {
    ms.clamp(MIN_REFRESH_MS, MAX_REFRESH_MS)
}

/// The settings in a store's entries: every field that is present and well-formed, the default
/// for every other one. Keys that are not settings (`firstRunDone`) are ignored, a value of the
/// wrong shape costs only its own field, a shortcut the plugin would not take goes back to its
/// default, and `refreshMs` is clamped. Anything that is not an object is an empty store.
pub fn merge_defaults(stored: &Value) -> Settings {
    let defaults = Settings::default();
    let Some(stored) = stored.as_object() else {
        return defaults;
    };
    let mut merged = match serde_json::to_value(&defaults) {
        Ok(Value::Object(map)) => map,
        _ => return defaults,
    };
    for (key, value) in stored {
        if !merged.contains_key(key) {
            continue;
        }
        let mut candidate = merged.clone();
        candidate.insert(key.clone(), value.clone());
        if serde_json::from_value::<Settings>(Value::Object(candidate)).is_ok() {
            merged.insert(key.clone(), value.clone());
        }
    }
    let mut settings: Settings = serde_json::from_value(Value::Object(merged)).unwrap_or(defaults);
    settings.refresh_ms = clamp_refresh_ms(settings.refresh_ms);
    if shortcuts::validate_accelerator(&settings.quick_shortcut).is_err() {
        settings.quick_shortcut = shortcuts::DEFAULT_QUICK.into();
    }
    if shortcuts::validate_accelerator(&settings.window_shortcut).is_err() {
        settings.window_shortcut = shortcuts::DEFAULT_WINDOW.into();
    }
    settings
}

/// The store entries for `settings`: one camelCase key per field, the inverse of [`merge_defaults`].
pub fn to_entries(settings: &Settings) -> Map<String, Value> {
    match serde_json::to_value(settings) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// What [`update`] refuses before storing anything: a shortcut the plugin cannot parse, or the
/// same combo for both. The message starts with the field's name as the contract spells it.
pub fn validate(settings: &Settings) -> Result<(), String> {
    let quick = shortcuts::validate_accelerator(&settings.quick_shortcut)
        .map_err(|e| format!("{}: {e}", shortcuts::Action::Quick.field()))?;
    let window = shortcuts::validate_accelerator(&settings.window_shortcut)
        .map_err(|e| format!("{}: {e}", shortcuts::Action::Window.field()))?;
    if quick == window {
        return Err(format!(
            "{}: the same combo as {}; the two windows need different shortcuts",
            shortcuts::Action::Window.field(),
            shortcuts::Action::Quick.field()
        ));
    }
    Ok(())
}

/// Only a release build enables start at login, and only on its first run.
pub fn should_enable_autostart(first_run: bool, debug: bool) -> bool {
    first_run && !debug
}

/// The settings as stored; the defaults for a store that is missing or cannot be opened.
pub fn load(app: &AppHandle) -> Settings {
    let store = match app.store(STORE_FILE) {
        Ok(store) => store,
        Err(e) => {
            warn(format_args!("could not open {STORE_FILE}; using the default settings: {e}"));
            return Settings::default();
        }
    };
    let entries: Map<String, Value> = store.entries().into_iter().collect();
    merge_defaults(&Value::Object(entries))
}

/// Writes every field of `settings` to the store and saves it. Other keys (`firstRunDone`) stay.
pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| format!("could not open {STORE_FILE}: {e}"))?;
    for (key, value) in to_entries(settings) {
        store.set(key, value);
    }
    store.save().map_err(|e| format!("could not save {STORE_FILE}: {e}"))
}

/// What `get_settings` answers: the store, with start at login read live from the login item.
/// The stored value stands only when the plugin cannot answer.
pub fn current(app: &AppHandle) -> Settings {
    let mut settings = load(app);
    match app.autolaunch().is_enabled() {
        Ok(enabled) => settings.start_at_login = enabled,
        Err(e) => warn(format_args!("could not read the start-at-login state; reporting the stored value: {e}")),
    }
    settings
}

/// Stores `settings`, applies them, emits [`CHANGED_EVENT`] and returns what is in effect: the
/// one way a change comes in, from the UI's `set_settings` and from the tray's check item alike.
/// `Err` names the field that could not be applied (a shortcut); everything else in `settings`
/// stands, and the event still goes out with the effective state so every face agrees.
pub fn update(app: &AppHandle, settings: Settings) -> Result<Settings, String> {
    let mut settings = settings;
    settings.refresh_ms = clamp_refresh_ms(settings.refresh_ms);
    let before = load(app);
    let mut effective = settings.clone();
    let mut failure: Option<String> = None;
    for step in apply_order() {
        match step {
            Step::Validate => validate(&settings)?,
            Step::Store => {
                if let Err(e) = save(app, &settings) {
                    warn(format_args!("{e}; the settings apply to this session only"));
                }
            }
            Step::Apply => match apply(app, &settings) {
                Ok(applied) => {
                    effective = applied;
                    if before.dock_icon != settings.dock_icon {
                        refocus_main_window(app);
                    }
                }
                Err(e) => {
                    // The old accelerators are still the registered ones; the store follows
                    // them, so the next launch and the window agree with what is live.
                    let live = shortcuts::current(app);
                    let mut kept = settings.clone();
                    kept.quick_shortcut = live.quick;
                    kept.window_shortcut = live.window;
                    if let Err(e) = save(app, &kept) {
                        warn(format_args!("{e}; the settings apply to this session only"));
                    }
                    effective = current(app);
                    failure = Some(e);
                }
            },
            Step::Emit => {
                emit_changed(app, &effective);
                crate::tray::rebuild(app);
            }
        }
    }
    match failure {
        Some(e) => Err(e),
        None => Ok(effective),
    }
}

/// Makes `settings` happen now and returns what is in effect afterwards. The Dock icon and the
/// login item fail softly (a warning; the state stays valid); a shortcut that cannot be taken
/// is the `Err`, naming its field, with the old one still registered.
pub fn apply(app: &AppHandle, settings: &Settings) -> Result<Settings, String> {
    apply_dock_icon(app, settings.dock_icon);
    apply_start_at_login(app, settings.start_at_login);
    shortcuts::apply(app, settings)?;
    // refreshMs, notifications, defaultForce, onboardingDone: stored, and read by whoever needs
    // them (the tray on its next tick, the UI through get_settings).
    Ok(current(app))
}

/// `Show` is a regular app; `Hide` is an accessory: no Dock icon, no ⌘-Tab entry, menu bar only.
/// Takes effect at once; the main window still comes to the front through `show_window`.
pub fn apply_dock_icon(app: &AppHandle, dock_icon: DockIcon) {
    #[cfg(target_os = "macos")]
    {
        let policy = match dock_icon {
            DockIcon::Show => tauri::ActivationPolicy::Regular,
            DockIcon::Hide => tauri::ActivationPolicy::Accessory,
        };
        if let Err(e) = app.set_activation_policy(policy) {
            warn(format_args!("could not apply the Dock icon setting ({dock_icon:?}); it takes effect after a relaunch: {e}"));
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, dock_icon);
    }
}

/// Changing the activation policy can take the key status off the window the user is typing
/// in: a visible main window gets it back. A hidden one stays hidden.
fn refocus_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        if let Err(e) = window.set_focus() {
            warn(format_args!("could not focus the window after the Dock icon changed: {e}"));
        }
    }
}

/// Enables or disables the login item when the live state differs from `wanted`. A plugin that
/// cannot say what the live state is still gets the write: the user asked for it.
fn apply_start_at_login(app: &AppHandle, wanted: bool) {
    let autostart = app.autolaunch();
    match autostart.is_enabled() {
        Ok(live) if live == wanted => return,
        Ok(_) => {}
        Err(e) => warn(format_args!("could not read the start-at-login state; applying the setting anyway: {e}")),
    }
    let (result, state) = if wanted { (autostart.enable(), "on") } else { (autostart.disable(), "off") };
    match result {
        Ok(()) => info(format_args!("start at login is {state}")),
        Err(e) => warn(format_args!("could not turn start at login {state}: {e}")),
    }
}

/// Tells every window what is in effect now.
pub fn emit_changed(app: &AppHandle, settings: &Settings) {
    if let Err(e) = app.emit(CHANGED_EVENT, settings) {
        warn(format_args!("could not emit {CHANGED_EVENT}: {e}"));
    }
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
    use serde_json::json;

    #[test]
    fn only_a_release_build_on_its_first_run_enables_autostart() {
        assert!(should_enable_autostart(true, false));
        assert!(!should_enable_autostart(true, true), "a dev build would register the debug binary");
        assert!(!should_enable_autostart(false, false), "not the first run: the user's choice stands");
        assert!(!should_enable_autostart(false, true));
    }

    #[test]
    fn refresh_ms_is_clamped_to_its_bounds() {
        assert_eq!(clamp_refresh_ms(0), MIN_REFRESH_MS);
        assert_eq!(clamp_refresh_ms(999), MIN_REFRESH_MS);
        assert_eq!(clamp_refresh_ms(1_000), 1_000);
        assert_eq!(clamp_refresh_ms(2_000), 2_000);
        assert_eq!(clamp_refresh_ms(30_000), 30_000);
        assert_eq!(clamp_refresh_ms(30_001), MAX_REFRESH_MS);
        assert_eq!(clamp_refresh_ms(u32::MAX), MAX_REFRESH_MS);
        assert_eq!(clamp_refresh_ms(Settings::default().refresh_ms), Settings::default().refresh_ms);
    }

    #[test]
    fn a_store_from_0_2_1_loads_as_the_defaults() {
        assert_eq!(merge_defaults(&json!({ "firstRunDone": true })), Settings::default(), "the flag is not a setting");
        assert_eq!(merge_defaults(&json!({})), Settings::default());
        assert_eq!(merge_defaults(&Value::Null), Settings::default(), "no store at all");
        assert_eq!(merge_defaults(&json!([1, 2])), Settings::default(), "not even an object");
    }

    #[test]
    fn stored_fields_override_the_defaults_one_by_one() {
        let stored = json!({
            "firstRunDone": true,
            "dockIcon": "hide",
            "refreshMs": 500,
            "notifications": false,
            "quickShortcut": "Ctrl+Alt+K",
        });
        let settings = merge_defaults(&stored);
        assert_eq!(settings.dock_icon, DockIcon::Hide);
        assert_eq!(settings.refresh_ms, MIN_REFRESH_MS, "clamped on the way in");
        assert!(!settings.notifications);
        assert_eq!(settings.quick_shortcut, "Ctrl+Alt+K");
        let defaults = Settings::default();
        assert_eq!(settings.window_shortcut, defaults.window_shortcut);
        assert_eq!(settings.start_at_login, defaults.start_at_login);
        assert_eq!(settings.default_force, defaults.default_force);
        assert_eq!(settings.onboarding_done, defaults.onboarding_done);
    }

    #[test]
    fn a_malformed_field_costs_only_itself() {
        let stored = json!({
            "refreshMs": "fast",
            "dockIcon": "sideways",
            "quickShortcut": "Banana",
            "windowShortcut": 7,
            "onboardingDone": true,
        });
        let settings = merge_defaults(&stored);
        let defaults = Settings::default();
        assert_eq!(settings.refresh_ms, defaults.refresh_ms);
        assert_eq!(settings.dock_icon, defaults.dock_icon);
        assert_eq!(settings.quick_shortcut, defaults.quick_shortcut, "a shortcut the plugin cannot parse is dropped");
        assert_eq!(settings.window_shortcut, defaults.window_shortcut);
        assert!(settings.onboarding_done, "the well-formed field next to them survives");
    }

    #[test]
    fn settings_round_trip_through_the_store_entries_with_camel_case_keys() {
        let settings = Settings {
            dock_icon: DockIcon::Hide,
            start_at_login: false,
            quick_shortcut: "Ctrl+Alt+K".into(),
            window_shortcut: "Ctrl+Alt+P".into(),
            refresh_ms: 10_000,
            default_force: true,
            notifications: false,
            onboarding_done: true,
        };
        let entries = to_entries(&settings);
        assert_eq!(entries["dockIcon"], "hide");
        assert_eq!(entries["startAtLogin"], false);
        assert_eq!(entries["quickShortcut"], "Ctrl+Alt+K");
        assert_eq!(entries["refreshMs"], 10_000);
        assert_eq!(entries["defaultForce"], true);
        assert_eq!(entries["onboardingDone"], true);
        assert_eq!(entries.len(), 8, "one key per field, nothing else");
        assert!(!entries.contains_key(FIRST_RUN_DONE));
        assert_eq!(merge_defaults(&Value::Object(entries)), settings);
    }

    #[test]
    fn an_update_validates_stores_applies_then_emits() {
        assert_eq!(apply_order(), [Step::Validate, Step::Store, Step::Apply, Step::Emit]);
    }

    #[test]
    fn validation_names_the_field_and_refuses_one_combo_for_both() {
        assert_eq!(validate(&Settings::default()), Ok(()));
        let bad_quick = Settings { quick_shortcut: "Banana".into(), ..Settings::default() };
        let err = validate(&bad_quick).unwrap_err();
        assert!(err.starts_with("quickShortcut: "), "{err}");
        let bad_window = Settings { window_shortcut: "P".into(), ..Settings::default() };
        let err = validate(&bad_window).unwrap_err();
        assert!(err.starts_with("windowShortcut: "), "{err}");
        let same = Settings { quick_shortcut: "Command+Shift+K".into(), window_shortcut: "cmd+shift+k".into(), ..Settings::default() };
        let err = validate(&same).unwrap_err();
        assert!(err.starts_with("windowShortcut: "), "{err}");
        assert!(err.contains("same combo"), "{err}");
    }
}

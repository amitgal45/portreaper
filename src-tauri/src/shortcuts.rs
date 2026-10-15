//! The global shortcuts that work from anywhere.
//!
//! Owned by WP-4, extended by WP-8a and WP-17a. By default ⌘⇧P (Ctrl+Shift+P off macOS) toggles
//! the main window: visible and focused hides it, anything else shows and focuses it; ⌘⇧K
//! toggles the Quick window ("Free a port…"). Both accelerators are settings
//! (`Settings::window_shortcut`, `Settings::quick_shortcut`). The ones registered right now live
//! in the managed [`ShortcutState`], which the tray reads for its labels.
//!
//! A change goes through [`replace`]: the old accelerators are unregistered, the new ones
//! registered, and when one of them fails (another app owns it) everything is put back and the
//! failure names the field. At startup ([`register_all`]) a combo another app owns is a warning,
//! not an error: the rest of the app works without the shortcut. What makes an accelerator
//! acceptable at all is [`validate_accelerator`], pure and tested, backed by the plugin's own
//! parser.

use std::str::FromStr;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt as _, Modifiers, Shortcut, ShortcutState as KeyState};

use crate::model::Settings;
use crate::quick;
use crate::tray::{show_window, warn};

/// The default accelerators, in the global-shortcut plugin's syntax. `Settings::default()` in
/// `model.rs` spells the same strings; a test keeps them equal.
pub const DEFAULT_WINDOW: &str = "CmdOrCtrl+Shift+P";
pub const DEFAULT_QUICK: &str = "CmdOrCtrl+Shift+K";

/// The two shortcuts and what they run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Toggles the Quick window.
    Quick,
    /// Toggles the main window.
    Window,
}

impl Action {
    const ALL: [Action; 2] = [Action::Quick, Action::Window];

    /// The `Settings` field, spelled as the contract does: what an error names, so the UI can
    /// show it next to the right recorder.
    pub fn field(self) -> &'static str {
        match self {
            Action::Quick => "quickShortcut",
            Action::Window => "windowShortcut",
        }
    }

    fn run(self) -> fn(&AppHandle) {
        match self {
            Action::Quick => quick::toggle_quick,
            Action::Window => toggle_window,
        }
    }
}

/// The accelerators of both actions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Accelerators {
    pub quick: String,
    pub window: String,
}

impl Accelerators {
    pub fn defaults() -> Self {
        Self { quick: DEFAULT_QUICK.into(), window: DEFAULT_WINDOW.into() }
    }

    pub fn from_settings(settings: &Settings) -> Self {
        Self { quick: settings.quick_shortcut.clone(), window: settings.window_shortcut.clone() }
    }

    pub fn get(&self, action: Action) -> &str {
        match action {
            Action::Quick => &self.quick,
            Action::Window => &self.window,
        }
    }

    /// The actions whose accelerator differs between `self` and `other`, in a fixed order.
    pub fn changes(&self, other: &Accelerators) -> Vec<Action> {
        Action::ALL.into_iter().filter(|a| self.get(*a) != other.get(*a)).collect()
    }
}

/// Managed state: the accelerators registered right now. The tray's labels read it.
pub struct ShortcutState(Mutex<Accelerators>);

/// The accelerators registered right now; the defaults before [`register_all`] ran.
pub fn current(app: &AppHandle) -> Accelerators {
    match app.try_state::<ShortcutState>() {
        Some(state) => state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone(),
        None => Accelerators::defaults(),
    }
}

/// Whether the plugin would accept `accelerator`, and whether it is sane as a global shortcut:
/// one main key behind at least one of ⌘, ⌃ or ⌥. Shift alone is refused with the bare key:
/// a global `K` or `Shift+K` would swallow that letter in every app. The parsed shortcut comes
/// back so two spellings of one combo can be compared.
pub fn validate_accelerator(accelerator: &str) -> Result<Shortcut, String> {
    let shortcut = Shortcut::from_str(accelerator.trim()).map_err(|e| e.to_string())?;
    let real_modifier = Modifiers::SUPER | Modifiers::CONTROL | Modifiers::ALT;
    if !shortcut.mods.intersects(real_modifier) {
        return Err(format!("\"{accelerator}\" needs ⌘, ⌃ or ⌥: a global shortcut without one would swallow that key everywhere"));
    }
    Ok(shortcut)
}

/// Called once from `setup`, before the tray is built: registers both shortcuts from `settings`
/// and manages the state the tray reads. A combo another app owns is a warning; the state still
/// records what the settings ask for, so the tray shows the combo the user chose.
pub fn register_all(app: &AppHandle, settings: &Settings) {
    let accelerators = Accelerators::from_settings(settings);
    for action in Action::ALL {
        if let Err(e) = register(app, accelerators.get(action), action) {
            warn(format_args!("could not register {} ({}): {e}", action.field(), accelerators.get(action)));
        }
    }
    app.manage(ShortcutState(Mutex::new(accelerators)));
}

/// Registers what changed in `settings` against the live state and records it. `Err` names the
/// field whose accelerator could not be taken; the old ones stay registered and recorded.
pub fn apply(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let old = current(app);
    let new = Accelerators::from_settings(settings);
    replace(app, &old, &new)?;
    if let Some(state) = app.try_state::<ShortcutState>() {
        *state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = new;
    }
    Ok(())
}

/// Moves the registrations from `old` to `new`: the changed accelerators are unregistered first
/// (so swapping the two does not collide with itself), then the new ones registered. One that
/// cannot be registered (unparsable, or another app owns it) undoes the rest and puts `old`
/// back; the `Err` names the field. Unchanged accelerators are left alone.
pub fn replace(app: &AppHandle, old: &Accelerators, new: &Accelerators) -> Result<(), String> {
    let changes = old.changes(new);
    if changes.is_empty() {
        return Ok(());
    }
    for action in &changes {
        validate_accelerator(new.get(*action)).map_err(|e| format!("{}: {e}", action.field()))?;
    }
    for action in &changes {
        unregister(app, old.get(*action), *action);
    }
    let mut registered: Vec<Action> = Vec::new();
    for action in &changes {
        if let Err(e) = register(app, new.get(*action), *action) {
            for done in &registered {
                unregister(app, new.get(*done), *done);
            }
            for action in &changes {
                if let Err(e) = register(app, old.get(*action), *action) {
                    warn(format_args!("could not put {} ({}) back: {e}", action.field(), old.get(*action)));
                }
            }
            return Err(format!("{}: {e}", action.field()));
        }
        registered.push(*action);
    }
    Ok(())
}

/// Registers `accelerator` to run `action` on key down.
fn register(app: &AppHandle, accelerator: &str, action: Action) -> Result<(), String> {
    let run = action.run();
    app.global_shortcut()
        .on_shortcut(accelerator, move |app, _shortcut, event| {
            if event.state == KeyState::Pressed {
                run(app);
            }
        })
        .map_err(|e| e.to_string())
}

/// A failure here is a warning: an accelerator that was never registered has nothing to undo.
fn unregister(app: &AppHandle, accelerator: &str, action: Action) {
    if let Err(e) = app.global_shortcut().unregister(accelerator) {
        warn(format_args!("could not unregister {} ({accelerator}): {e}", action.field()));
    }
}

/// Visible and focused hides; anything else shows and focuses.
fn toggle_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        warn("the main window is gone; the window shortcut does nothing");
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);
    if visible && focused {
        if let Err(e) = window.hide() {
            warn(format_args!("could not hide the window: {e}"));
        }
    } else {
        show_window(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_defaults_are_the_contracts_defaults() {
        let settings = Settings::default();
        assert_eq!(settings.quick_shortcut, DEFAULT_QUICK);
        assert_eq!(settings.window_shortcut, DEFAULT_WINDOW);
        assert_eq!(Accelerators::from_settings(&settings), Accelerators::defaults());
    }

    #[test]
    fn accelerators_the_plugin_parses_with_a_real_modifier_pass() {
        for ok in ["CmdOrCtrl+Shift+K", "Ctrl+Alt+K", "Command+Shift+P", "Option+F5", "Super+1", " Ctrl+Space "] {
            assert!(validate_accelerator(ok).is_ok(), "{ok}");
        }
    }

    #[test]
    fn accelerators_the_plugin_cannot_parse_are_rejected() {
        for bad in ["", "Banana", "Ctrl+", "Ctrl+Shift", "Ctrl+K+L", "Ctrl+Banana"] {
            assert!(validate_accelerator(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_bare_key_or_shift_alone_is_rejected() {
        for bad in ["K", "Shift+K", "F5"] {
            let err = validate_accelerator(bad).unwrap_err();
            assert!(err.contains("needs ⌘, ⌃ or ⌥"), "{bad}: {err}");
        }
    }

    #[test]
    fn two_spellings_of_one_combo_parse_equal() {
        assert_eq!(validate_accelerator("Command+Shift+K").unwrap(), validate_accelerator("cmd+shift+k").unwrap());
        assert_ne!(validate_accelerator("Ctrl+Shift+K").unwrap(), validate_accelerator("Ctrl+Shift+L").unwrap());
    }

    #[test]
    fn changes_lists_only_the_actions_that_differ() {
        let old = Accelerators::defaults();
        assert!(old.changes(&old).is_empty());
        let quick_only = Accelerators { quick: "Ctrl+Alt+K".into(), ..old.clone() };
        assert_eq!(old.changes(&quick_only), [Action::Quick]);
        let swapped = Accelerators { quick: old.window.clone(), window: old.quick.clone() };
        assert_eq!(old.changes(&swapped), [Action::Quick, Action::Window], "a swap changes both");
    }

    #[test]
    fn an_error_names_the_field_as_the_contract_spells_it() {
        assert_eq!(Action::Quick.field(), "quickShortcut");
        assert_eq!(Action::Window.field(), "windowShortcut");
    }
}

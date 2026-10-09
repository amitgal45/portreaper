//! The global shortcuts that work from anywhere.
//!
//! Owned by WP-4, extended by WP-8a. ⌘⇧P (Ctrl+Shift+P off macOS) toggles the main window:
//! visible and focused hides it, anything else shows and focuses it. ⌘⇧K toggles the Quick
//! window ("Free a port…"). Another app may own a combo already; that is a warning, not an
//! error: the rest of the app works without the shortcut.

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt as _, ShortcutState};

use crate::quick;
use crate::tray::{show_window, warn};

/// The accelerators, in the global-shortcut plugin's syntax. The tray menu shows them as labels.
pub const TOGGLE_WINDOW: &str = "CmdOrCtrl+Shift+P";
pub const QUICK_WINDOW: &str = "CmdOrCtrl+Shift+K";

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    register(app, TOGGLE_WINDOW, "⌘⇧P", toggle_window);
    register(app, QUICK_WINDOW, "⌘⇧K", quick::toggle_quick);
    Ok(())
}

/// Registers `accelerator` to run `action` on key down. A taken combo is a warning.
fn register(app: &AppHandle, accelerator: &str, name: &str, action: fn(&AppHandle)) {
    let registered = app.global_shortcut().on_shortcut(accelerator, move |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            action(app);
        }
    });
    if let Err(e) = registered {
        warn(format_args!("could not register {name} ({accelerator}): {e}"));
    }
}

/// Visible and focused hides; anything else shows and focuses.
fn toggle_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        warn("the main window is gone; ⌘⇧P does nothing");
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

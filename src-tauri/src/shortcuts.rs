//! The global shortcut that brings the window up from anywhere.
//!
//! Owned by WP-4. ⌘⇧P (Ctrl+Shift+P off macOS) toggles the main window: visible and focused
//! hides it, anything else shows and focuses it. Another app may own the combo already; that is
//! a warning, not an error: the rest of the app works without the shortcut.

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt as _, ShortcutState};

use crate::tray::{show_window, warn};

/// The accelerator, in the global-shortcut plugin's syntax.
pub const TOGGLE_WINDOW: &str = "CmdOrCtrl+Shift+P";

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let registered = app.global_shortcut().on_shortcut(TOGGLE_WINDOW, |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            toggle_window(app);
        }
    });
    if let Err(e) = registered {
        warn(format_args!("could not register ⌘⇧P ({TOGGLE_WINDOW}): {e}"));
    }
    Ok(())
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

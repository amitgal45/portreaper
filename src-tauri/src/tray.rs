//! The menu-bar icon, its menu, and what happens when the window is closed.
//!
//! Owned by WP-4. The app lives in the Dock like a normal app; the tray is the fast path:
//! a count of open ports, "Free port N" items, and show/quit.

use tauri::{AppHandle, Window, WindowEvent};

pub fn setup(_app: &AppHandle) -> tauri::Result<()> {
    // WP-4 replaces this stub.
    Ok(())
}

/// Called for every window event. WP-4 turns a close into a hide so the tray keeps working.
pub fn on_window_event(_window: &Window, _event: &WindowEvent) {}

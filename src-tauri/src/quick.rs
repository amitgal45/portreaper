//! The Quick window: the host for "Free a port…" (`quick.html`, built by WP-8b).
//!
//! Owned by WP-8a. A small always-on-top strip, 480×320, no decorations, near the top of the
//! monitor the cursor is on, like Spotlight. ⌘⇧K and the tray's "Free a port…" show it; it
//! hides when it loses focus (routed here from `tray::on_window_event`), and the page hides it
//! itself after a kill or on Esc. It is created on first use, so an app that never needs it
//! pays nothing at startup. Nothing here may panic: every failure is a warning, and the main
//! window still works.

use tauri::{AppHandle, LogicalPosition, Manager, Monitor, PhysicalPosition, WebviewUrl};
use tauri::{WebviewWindow, WebviewWindowBuilder};

use crate::tray::warn;

/// The window's label. `capabilities/default.json` lists it, so the page may hide the window,
/// invoke the commands and write the clipboard.
pub const QUICK_WINDOW: &str = "quick";
/// The page, relative to the frontend root: `quick.html` beside `index.html`.
const PAGE: &str = "quick.html";
/// The window's logical size.
pub const WIDTH: f64 = 480.0;
pub const HEIGHT: f64 = 320.0;
/// Where the top edge sits, as a fraction of the work area's height: Spotlight's neighbourhood.
pub const TOP_FRACTION: f64 = 0.18;

/// A rectangle in logical pixels with a top-left origin: the area a window may use.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The top-left corner of a `width`×`height` window inside `area`: centred horizontally, its
/// top edge [`TOP_FRACTION`] of the way down, and never past the area's edges when the area is
/// smaller than the window would like. Pure.
pub fn place(area: Area, width: f64, height: f64) -> (f64, f64) {
    let x = area.x + (area.width - width) / 2.0;
    let y = area.y + area.height * TOP_FRACTION;
    let x = x.min(area.x + area.width - width).max(area.x);
    let y = y.min(area.y + area.height - height).max(area.y);
    (x.round(), y.round())
}

/// Shows the Quick window, creating it on first use, placed on the monitor under the cursor (or
/// the primary one), and focuses it so the page can put the caret in its input.
pub fn show_quick(app: &AppHandle) {
    let window = match app.get_webview_window(QUICK_WINDOW) {
        Some(window) => window,
        None => match create(app) {
            Ok(window) => window,
            Err(e) => {
                warn(format_args!("could not create the quick window: {e}"));
                return;
            }
        },
    };
    if let Some(area) = target_area(app) {
        let (x, y) = place(area, WIDTH, HEIGHT);
        if let Err(e) = window.set_position(LogicalPosition::new(x, y)) {
            warn(format_args!("could not place the quick window: {e}"));
        }
    }
    if let Err(e) = window.show() {
        warn(format_args!("could not show the quick window: {e}"));
    }
    if let Err(e) = window.set_focus() {
        warn(format_args!("could not focus the quick window: {e}"));
    }
}

/// Builds the window hidden at startup, so the first ⌘⇧K pays no page load: `show_quick` then
/// only places, shows and focuses. Failure is logged and the window is created on first use instead.
pub fn precreate(app: &AppHandle) {
    if app.get_webview_window(QUICK_WINDOW).is_none() {
        if let Err(e) = create(app) {
            warn(format_args!("could not pre-create the quick window: {e}"));
        }
    }
}

/// Hides the Quick window if it exists; there is nothing to do before its first use.
pub fn hide_quick(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(QUICK_WINDOW) {
        if let Err(e) = window.hide() {
            warn(format_args!("could not hide the quick window: {e}"));
        }
    }
}

/// Visible hides; anything else shows and focuses.
pub fn toggle_quick(app: &AppHandle) {
    let visible = app.get_webview_window(QUICK_WINDOW).is_some_and(|w| w.is_visible().unwrap_or(false));
    if visible {
        hide_quick(app);
    } else {
        show_quick(app);
    }
}

/// Builds the window hidden; [`show_quick`] places and shows it the same way every time.
fn create(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, QUICK_WINDOW, WebviewUrl::App(PAGE.into()))
        .title("Free a port")
        .inner_size(WIDTH, HEIGHT)
        .decorations(false)
        .always_on_top(true)
        .resizable(false)
        .skip_taskbar(true)
        .visible(false)
        .build()
}

/// The work area of the monitor under the cursor, else the primary monitor's, in logical
/// pixels. `None`, after a warning, when the system reports no monitor at all; the window then
/// opens wherever the system puts it.
fn target_area(app: &AppHandle) -> Option<Area> {
    let primary = primary_monitor(app);
    let monitor = monitor_under_cursor(app, primary.as_ref()).or(primary)?;
    Some(work_area(&monitor))
}

fn monitor_under_cursor(app: &AppHandle, primary: Option<&Monitor>) -> Option<Monitor> {
    let cursor = match app.cursor_position() {
        Ok(cursor) => cursor,
        Err(e) => {
            warn(format_args!("could not read the cursor position: {e}"));
            return None;
        }
    };
    let (x, y) = lookup_point(cursor, primary);
    match app.monitor_from_point(x, y) {
        Ok(monitor) => monitor,
        Err(e) => {
            warn(format_args!("could not find the monitor under the cursor: {e}"));
            None
        }
    }
}

/// The point `monitor_from_point` wants for a cursor position. On macOS tao reports the cursor
/// in the primary monitor's physical pixels but looks monitors up in logical global points, so
/// the point is scaled back; elsewhere both are physical.
fn lookup_point(cursor: PhysicalPosition<f64>, primary: Option<&Monitor>) -> (f64, f64) {
    let scale = if cfg!(target_os = "macos") { primary.map_or(1.0, Monitor::scale_factor) } else { 1.0 };
    (cursor.x / scale, cursor.y / scale)
}

fn primary_monitor(app: &AppHandle) -> Option<Monitor> {
    match app.primary_monitor() {
        Ok(Some(monitor)) => Some(monitor),
        Ok(None) => {
            warn("no primary monitor; the quick window opens where the system puts it");
            None
        }
        Err(e) => {
            warn(format_args!("could not read the primary monitor: {e}"));
            None
        }
    }
}

/// The monitor's work area (no menu bar, no Dock) in logical pixels, or the whole monitor when
/// the runtime reports an empty work area.
fn work_area(monitor: &Monitor) -> Area {
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let (position, size) = if work.size.width == 0 || work.size.height == 0 {
        (*monitor.position(), *monitor.size())
    } else {
        (work.position, work.size)
    };
    Area {
        x: f64::from(position.x) / scale,
        y: f64::from(position.y) / scale,
        width: f64::from(size.width) / scale,
        height: f64::from(size.height) / scale,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 14" MacBook Pro at the default scaling: 1512×982 points, a 25-point menu bar, no Dock.
    const BUILT_IN: Area = Area { x: 0.0, y: 25.0, width: 1512.0, height: 957.0 };

    #[test]
    fn centred_horizontally_and_a_fifth_of_the_way_down() {
        let (x, y) = place(BUILT_IN, WIDTH, HEIGHT);
        assert_eq!(x, 516.0, "(1512 - 480) / 2");
        assert_eq!(y, 197.0, "25 + 0.18 * 957, rounded");
    }

    #[test]
    fn follows_the_monitor_it_is_given() {
        let external = Area { x: 1512.0, y: -300.0, width: 2560.0, height: 1415.0 };
        let (x, y) = place(external, WIDTH, HEIGHT);
        assert_eq!(x, 2552.0, "1512 + (2560 - 480) / 2");
        assert_eq!(y, -45.0, "-300 + 0.18 * 1415, rounded");
    }

    #[test]
    fn stays_inside_a_small_area() {
        let short = Area { x: 0.0, y: 0.0, width: 1000.0, height: 350.0 };
        assert_eq!(place(short, WIDTH, HEIGHT), (260.0, 30.0), "pulled up so the bottom edge fits");
        let tiny = Area { x: 10.0, y: 20.0, width: 400.0, height: 300.0 };
        assert_eq!(place(tiny, WIDTH, HEIGHT), (10.0, 20.0), "smaller than the window: pinned to the corner");
    }

    #[test]
    fn the_lookup_point_is_logical_on_macos_and_physical_elsewhere() {
        let cursor = PhysicalPosition::new(3024.0, 400.0);
        let (x, y) = lookup_point(cursor, None);
        assert_eq!((x, y), (3024.0, 400.0), "no primary monitor known: nothing to scale by");
    }
}

//! PortReaper: see every listening port, which project it belongs to, and kill it in one click.
//!
//! Module ownership (one work package each, so they can be built in parallel):
//! - `model`     the contract with the UI (mirrored in `src/types.ts`)
//! - `ports`     listing sockets and the processes behind them      (WP-1)
//! - `kill`      graceful then forceful termination                  (WP-1)
//! - `project`   cwd -> project name, kind, branch, tool             (WP-2)
//! - `tray`      menu-bar icon, menu, close-to-hide                  (WP-4, WP-8a)
//! - `shortcuts` the global shortcuts                                (WP-4, WP-8a)
//! - `quick`     the Quick window that hosts "Free a port…"          (WP-8a)
//! - `commands`  the thin `#[tauri::command]` layer
//!
//! Every plugin is registered here and allowed in `capabilities/default.json`. Add new ones in
//! both places in the same commit.

mod commands;
mod kill;
mod model;
mod ports;
mod project;
mod quick;
mod shortcuts;
mod tray;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            tray::setup(app.handle())?;
            shortcuts::setup(app.handle())?;
            Ok(())
        })
        .on_window_event(tray::on_window_event)
        .invoke_handler(tauri::generate_handler![
            commands::list_ports,
            commands::kill_process,
            commands::free_port,
            commands::app_version
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(tray::on_run_event);
}

//! PortReaper: see every listening port, which project it belongs to, and kill it in one click.
//!
//! Module ownership (one work package each, so they can be built in parallel):
//! - `model`     the contract with the UI (mirrored in `src/types.ts`)
//! - `ports`     listing sockets and the processes behind them      (WP-1, WP-10)
//! - `kill`      graceful then forceful termination                  (WP-1)
//! - `project`   cwd -> project name, kind, branch, tool             (WP-2)
//! - `classify`  the port taxonomy: category and framework           (WP-10)
//! - `taskline`  the session log every kill lands in                 (WP-10)
//! - `relaunch`  a killed process started again from its record      (WP-10)
//! - `tray`      menu-bar icon, menu, close-to-hide                  (WP-4, WP-8a)
//! - `shortcuts` the global shortcuts                                (WP-4, WP-8a)
//! - `quick`     the Quick window that hosts "Free a port…"          (WP-8a)
//! - `settings`  settings on disk; start at login on first run       (WP-8a)
//! - `update`    auto-update from GitHub Releases                    (WP-16)
//! - `commands`  the thin `#[tauri::command]` layer
//!
//! Every plugin is registered here and allowed in `capabilities/default.json`. Add new ones in
//! both places in the same commit.

mod classify;
mod commands;
mod docker;
mod kill;
mod model;
mod ports;
mod project;
mod quick;
mod relaunch;
mod settings;
mod shortcuts;
mod taskline;
mod tray;
mod update;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init());
    // The updater and the dialog that offers its finds exist on desktop only.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build()).plugin(tauri_plugin_dialog::init());
    builder
        // One Taskline for the session: every surface records into it, every window reads it.
        .manage(taskline::Taskline::default())
        // The update the last check found, for the banner's Update and Retry.
        .manage(update::UpdateState::default())
        .setup(|app| {
            tray::setup(app.handle())?;
            shortcuts::setup(app.handle())?;
            settings::enable_autostart_on_first_run(app.handle());
            quick::precreate(app.handle());
            update::setup(app.handle());
            Ok(())
        })
        .on_window_event(tray::on_window_event)
        .invoke_handler(tauri::generate_handler![
            commands::list_ports,
            commands::kill_process,
            commands::free_port,
            commands::app_version,
            commands::reap_zombies,
            commands::process_tree,
            commands::taskline_events,
            commands::clear_taskline,
            commands::relaunch,
            commands::check_for_updates,
            commands::install_update,
            commands::get_settings,
            commands::set_settings,
            commands::watched_ports,
            commands::watch_port,
            commands::unwatch_port
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(tray::on_run_event);
}

//! The commands the UI can invoke. Thin: each one delegates to a module and converts errors
//! into something serialisable. Business rules live in the modules, not here.

use crate::model::{KillOutcome, KillRequest, PortEntry};

#[tauri::command]
pub fn list_ports() -> Result<Vec<PortEntry>, String> {
    crate::ports::list().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn kill_process(request: KillRequest) -> KillOutcome {
    crate::kill::kill(&request)
}

/// Kills every process listening on `port`. One outcome per distinct pid.
#[tauri::command]
pub fn free_port(port: u16, force: bool) -> Result<Vec<KillOutcome>, String> {
    let entries = crate::ports::list().map_err(|e| e.to_string())?;
    let mut pids: Vec<u32> = entries.iter().filter(|e| e.port == port).map(|e| e.pid).collect();
    pids.sort_unstable();
    pids.dedup();
    Ok(pids.into_iter().map(|pid| crate::kill::kill(&KillRequest { pid, force })).collect())
}

#[tauri::command]
pub fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

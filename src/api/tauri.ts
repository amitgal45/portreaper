import { invoke } from "@tauri-apps/api/core";
import type { KillOutcome, KillRequest, PortApi, PortEntry } from "../types";

/** The real core. Command names and argument keys match `src-tauri/src/commands.rs`. */
export const tauriApi: PortApi = {
  listPorts: () => invoke<PortEntry[]>("list_ports"),
  killProcess: (request: KillRequest) => invoke<KillOutcome>("kill_process", { request }),
  freePort: (port: number, force: boolean) => invoke<KillOutcome[]>("free_port", { port, force }),
  appVersion: () => invoke<string>("app_version"),
};

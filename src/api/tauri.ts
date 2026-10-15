import { invoke } from "@tauri-apps/api/core";
import type {
  KillOutcome,
  KillRequest,
  PortApi,
  PortEntry,
  ProcessNode,
  RelaunchOutcome,
  TasklineEvent,
} from "../types";

/** The real core. Command names and argument keys match `src-tauri/src/commands.rs`. */
export const tauriApi: PortApi = {
  listPorts: () => invoke<PortEntry[]>("list_ports"),
  killProcess: (request: KillRequest) => invoke<KillOutcome>("kill_process", { request }),
  freePort: (port: number, force: boolean) => invoke<KillOutcome[]>("free_port", { port, force }),
  appVersion: () => invoke<string>("app_version"),
  processTree: (pid: number) => invoke<ProcessNode[]>("process_tree", { pid }),
  tasklineEvents: () => invoke<TasklineEvent[]>("taskline_events"),
  clearTaskline: () => invoke<void>("clear_taskline"),
  relaunch: (eventId: number) => invoke<RelaunchOutcome>("relaunch", { eventId }),
  reapZombies: () => invoke<KillOutcome[]>("reap_zombies"),
  checkForUpdates: () => invoke<void>("check_for_updates"),
  installUpdate: () => invoke<void>("install_update"),
};

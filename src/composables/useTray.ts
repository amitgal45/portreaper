import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "../api";
import type { Protocol } from "../types";
import type { KillFlow } from "./useKillFlow";
import { groupKeyOf, type PortsStore } from "./usePorts";

/** Emitted by the Rust tray (WP-4) when the user picks a protected port from the menu. */
export const TRAY_SELECT_PORT = "tray:select-port";

export interface TraySelectPayload {
  port: number;
  protocol: Protocol;
}

export function isTraySelectPayload(value: unknown): value is TraySelectPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.port === "number" && (v.protocol === "tcp" || v.protocol === "udp");
}

/**
 * The tray picked a port: clear the search, show the row, and ask before killing. The dialog
 * opens whether or not the row is marked protected; the tray only sends protected ports, and if
 * that ever changes, asking is the safe default.
 */
export async function selectFromTray(
  ports: PortsStore,
  flow: KillFlow,
  payload: TraySelectPayload,
): Promise<boolean> {
  const find = () =>
    ports.entries.value.find((e) => e.port === payload.port && e.protocol === payload.protocol) ?? null;
  let entry = find();
  if (!entry) {
    // The tray's list may be fresher than ours.
    await ports.refresh();
    entry = find();
  }
  if (!entry) return false;
  ports.clearSearch();
  const key = groupKeyOf(entry);
  if (ports.collapsed.has(key)) ports.toggleGroup(key);
  ports.select(entry);
  flow.ask({ kind: "entry", entry, force: false });
  return true;
}

/** Listens for `tray:select-port` inside Tauri; a no-op in a browser tab and in tests. */
export function useTrayListener(onSelect: (payload: TraySelectPayload) => void) {
  let unlisten: UnlistenFn | null = null;
  let active = false;

  async function start(): Promise<void> {
    if (active || !isTauri()) return;
    active = true;
    try {
      const off = await listen<unknown>(TRAY_SELECT_PORT, (event) => {
        if (isTraySelectPayload(event.payload)) onSelect(event.payload);
        else console.error("tray:select-port with an unexpected payload", event.payload);
      });
      if (active) unlisten = off;
      else off();
    } catch (err) {
      active = false;
      console.error("could not listen for tray:select-port", err);
    }
  }

  function stop(): void {
    active = false;
    unlisten?.();
    unlisten = null;
  }

  return { start, stop };
}

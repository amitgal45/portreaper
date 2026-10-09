import type { PortApi } from "../types";
import { mockApi } from "./mock";
import { tauriApi } from "./tauri";

/** True inside the Tauri window, false in a plain browser tab (`pnpm dev`) and in tests. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** The one object the UI talks to. Real core inside the app, a believable mock everywhere else. */
export const api: PortApi = isTauri() ? tauriApi : mockApi;

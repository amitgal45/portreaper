import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "./index";

/**
 * The one window call the Quick page makes: hide itself after a kill or on Esc. Inside Tauri it
 * needs `core:window:allow-hide` (granted in `capabilities/default.json`); in a plain browser
 * tab it is a no-op that resolves `false`, which leaves the strip on screen for `pnpm dev` and
 * the Playwright tests.
 */
export async function hideCurrentWindow(): Promise<boolean> {
  if (!isTauri()) return false;
  await getCurrentWindow().hide();
  return true;
}

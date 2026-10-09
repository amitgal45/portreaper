import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { isTauri } from "./index";

/**
 * Row actions that leave the webview: the browser, the clipboard, Finder. Each resolves `true`
 * when it did the thing and `false` when it cannot here (a plain browser tab), so the caller can
 * say "Not available in the browser" instead of failing silently.
 */

export async function openInBrowser(port: number): Promise<boolean> {
  if (!isTauri()) return false;
  await openUrl(`http://localhost:${port}`);
  return true;
}

export async function copyText(text: string): Promise<boolean> {
  if (isTauri()) {
    await writeText(text);
    return true;
  }
  // A browser tab can still copy, which makes `pnpm dev` usable; a test environment cannot.
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  return false;
}

/**
 * Shows the folder in Finder. `revealItemInDir`, not `openPath`: the capability file grants
 * `opener:default`, which covers reveal and URLs but not opening arbitrary paths.
 */
export async function revealFolder(path: string): Promise<boolean> {
  if (!isTauri() || !path) return false;
  await revealItemInDir(path);
  return true;
}

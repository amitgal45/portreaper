import { ref } from "vue";
import { isTauri } from "../api";
import { onUpdateAvailable, onUpdateError, onUpdateProgress } from "../api/events";
import { MOCK_UPDATE } from "../api/mock";
import { formatBytes } from "../lib/format";
import type { PortApi, UpdateFailure, UpdateInfo, UpdateProgress } from "../types";

/**
 * What the sidebar banner shows (WP-16). `idle` is no banner. The other three are the spec's:
 * ready ("PortReaper 0.3.0 is ready · Update"), downloading (the bytes so far; `installed` once
 * the core finished and is relaunching), and failed, where Retry installs again. The core
 * announces (`update:available`) before it downloads, so progress and errors never arrive idle.
 */
export type UpdateState =
  | { phase: "idle" }
  | { phase: "available"; info: UpdateInfo }
  | { phase: "downloading"; info: UpdateInfo; downloaded: number; total: number | null; installed: boolean }
  | { phase: "error"; info: UpdateInfo; message: string };

export interface UseUpdateOptions {
  /** A found update to start from: the browser demo (`demoUpdate`) and tests. */
  seed?: UpdateInfo | null;
}

/**
 * The browser-only seam for the banner: `?update=1` in the URL starts with `MOCK_UPDATE` ready,
 * so `pnpm dev` and the e2e can see the banner without a release. Inside Tauri it does nothing:
 * there the core's `update:available` is the only source.
 */
export function demoUpdate(search: string): UpdateInfo | null {
  if (isTauri()) return null;
  return new URLSearchParams(search).get("update") === "1" ? MOCK_UPDATE : null;
}

/** `42` for 42 % of a known total, capped at 100; null while the size is unknown. */
export function percentOf(downloaded: number, total: number | null): number | null {
  if (total === null || total <= 0) return null;
  return Math.min(100, Math.floor((downloaded / total) * 100));
}

/**
 * The banner's one line per state: `PortReaper 0.3.0 is ready`, `Downloading… 42%` (or
 * `Downloading… 3.2 MB` while the size is unknown), `Restarting…`, or the failure's message.
 * Null when there is no banner.
 */
export function bannerText(state: UpdateState): string | null {
  switch (state.phase) {
    case "idle":
      return null;
    case "available":
      return `PortReaper ${state.info.version} is ready`;
    case "downloading": {
      if (state.installed) return "Restarting…";
      const percent = percentOf(state.downloaded, state.total);
      return percent === null ? `Downloading… ${formatBytes(state.downloaded)}` : `Downloading… ${percent}%`;
    }
    case "error":
      return state.message;
  }
}

/**
 * The banner's state, fed by the core's three update events (no-ops in a browser tab) and by
 * `install()`, which runs the core's download + install + relaunch. `available`, `progress` and
 * `failed` are the event handlers, public so tests can deliver a payload by hand.
 */
export function useUpdate(api: PortApi, options: UseUpdateOptions = {}) {
  const state = ref<UpdateState>(
    options.seed ? { phase: "available", info: options.seed } : { phase: "idle" },
  );
  const offs: Array<() => void> = [];

  function available(info: UpdateInfo): void {
    // The six-hour check announces the same release again; a download in progress is left alone.
    if (state.value.phase === "downloading") return;
    state.value = { phase: "available", info };
  }

  function progress({ downloaded, total }: UpdateProgress): void {
    if (state.value.phase === "idle") return;
    state.value = { phase: "downloading", info: state.value.info, downloaded, total, installed: false };
  }

  function failed({ message }: UpdateFailure): void {
    if (state.value.phase === "idle") return;
    state.value = { phase: "error", info: state.value.info, message };
  }

  /** Update and Retry. Resolves when the core finished (the mock) or failed; the real core relaunches first. */
  async function install(): Promise<void> {
    if (state.value.phase === "idle" || state.value.phase === "downloading") return;
    const info = state.value.info;
    state.value = { phase: "downloading", info, downloaded: 0, total: null, installed: false };
    try {
      await api.installUpdate();
      if (state.value.phase === "downloading") state.value = { ...state.value, installed: true };
    } catch (err) {
      failed({ message: err instanceof Error ? err.message : String(err) });
    }
  }

  function start(): void {
    if (offs.length > 0) return;
    offs.push(onUpdateAvailable(available), onUpdateProgress(progress), onUpdateError(failed));
  }

  function stop(): void {
    for (const off of offs.splice(0)) off();
  }

  return { state, available, progress, failed, install, start, stop };
}

export type UpdateStore = ReturnType<typeof useUpdate>;

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Settings,
  TasklineEvent,
  UpdateFailure,
  UpdateInfo,
  UpdateProgress,
  WatchedPort,
} from "../types";
import { isTauri } from "./index";

/** Emitted by the core every time it records something in the Taskline. Payload: `TasklineEvent`. */
export const TASKLINE_EVENT = "taskline:event";
/** Emitted by the core when a check found a newer release (WP-16). Payload: `UpdateInfo`. */
export const UPDATE_AVAILABLE_EVENT = "update:available";
/** Emitted by the core while the update downloads. Payload: `UpdateProgress`. */
export const UPDATE_PROGRESS_EVENT = "update:progress";
/** Emitted by the core when the download or the install failed. Payload: `UpdateFailure`. */
export const UPDATE_ERROR_EVENT = "update:error";
/** Emitted by the core after a settings change was applied (WP-17a). Payload: `Settings`. */
export const SETTINGS_CHANGED_EVENT = "settings:changed";
/** Emitted by the tray's "Preferences…" item (WP-17a): the UI shows the view. No payload. */
export const OPEN_PREFERENCES_EVENT = "tray:open-preferences";
/** Emitted by the core when a watched port changes state (WP-18). Payload: `WatchedPort`. */
export const WATCH_CHANGED_EVENT = "watch:changed";

const KINDS = new Set([
  "portFreed",
  "forceKilled",
  "zombieReaped",
  "collisionResolved",
  "relaunched",
  "refused",
  "failed",
]);

/** The payload has the shape the contract promises; anything else is logged and dropped. */
export function isTasklineEvent(value: unknown): value is TasklineEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "number" &&
    typeof v.atMs === "number" &&
    typeof v.kind === "string" &&
    KINDS.has(v.kind) &&
    typeof v.port === "number" &&
    typeof v.pid === "number" &&
    typeof v.processName === "string" &&
    typeof v.message === "string" &&
    typeof v.relaunchable === "boolean"
  );
}

export function isUpdateInfo(value: unknown): value is UpdateInfo {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.version === "string" &&
    (v.notes === null || typeof v.notes === "string") &&
    (v.date === null || typeof v.date === "string")
  );
}

export function isUpdateProgress(value: unknown): value is UpdateProgress {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.downloaded === "number" && (v.total === null || typeof v.total === "number");
}

export function isUpdateFailure(value: unknown): value is UpdateFailure {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.message === "string";
}

export function isSettings(value: unknown): value is Settings {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.dockIcon === "show" || v.dockIcon === "hide") &&
    typeof v.startAtLogin === "boolean" &&
    typeof v.quickShortcut === "string" &&
    typeof v.windowShortcut === "string" &&
    typeof v.refreshMs === "number" &&
    typeof v.defaultForce === "boolean" &&
    typeof v.notifications === "boolean" &&
    typeof v.onboardingDone === "boolean"
  );
}

export function isWatchedPort(value: unknown): value is WatchedPort {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.port === "number" &&
    (v.protocol === "tcp" || v.protocol === "udp") &&
    (v.state === "listening" || v.state === "free") &&
    (v.pid === null || typeof v.pid === "number") &&
    (v.processName === null || typeof v.processName === "string") &&
    (v.project === null || typeof v.project === "string") &&
    typeof v.sinceMs === "number"
  );
}

function isAnything(_value: unknown): _value is unknown {
  return true;
}

/**
 * Calls `handler` for every `name` event the core emits whose payload `isValid` accepts. Inside
 * Tauri it subscribes through the event plugin; in a plain browser tab and in tests it does
 * nothing. Returns the unsubscribe. Safe to call it before the subscription resolved: the late
 * listener is dropped at once.
 */
function subscribe<T>(
  name: string,
  isValid: (value: unknown) => value is T,
  handler: (payload: T) => void,
): () => void {
  if (!isTauri()) return () => {};
  let active = true;
  let unlisten: UnlistenFn | null = null;
  listen<unknown>(name, (event) => {
    if (!active) return;
    if (isValid(event.payload)) handler(event.payload);
    else console.error(`${name} with an unexpected payload`, event.payload);
  })
    .then((off) => {
      if (active) unlisten = off;
      else off();
    })
    .catch((err) => {
      console.error(`could not listen for ${name}`, err);
    });
  return () => {
    active = false;
    unlisten?.();
    unlisten = null;
  };
}

/** `taskline:event`: polling covers the feed in a browser tab, so the no-op there loses nothing. */
export function onTasklineEvent(handler: (event: TasklineEvent) => void): () => void {
  return subscribe(TASKLINE_EVENT, isTasklineEvent, handler);
}

/** `update:available`: a check found a newer release; the sidebar banner offers it. */
export function onUpdateAvailable(handler: (info: UpdateInfo) => void): () => void {
  return subscribe(UPDATE_AVAILABLE_EVENT, isUpdateInfo, handler);
}

/** `update:progress`: bytes so far while the update downloads. */
export function onUpdateProgress(handler: (progress: UpdateProgress) => void): () => void {
  return subscribe(UPDATE_PROGRESS_EVENT, isUpdateProgress, handler);
}

/** `update:error`: the download or the install failed; the banner offers Retry. */
export function onUpdateError(handler: (failure: UpdateFailure) => void): () => void {
  return subscribe(UPDATE_ERROR_EVENT, isUpdateFailure, handler);
}

/** `settings:changed`: the core applied a change (from the view or the tray); the UI follows. */
export function onSettingsChanged(handler: (settings: Settings) => void): () => void {
  return subscribe(SETTINGS_CHANGED_EVENT, isSettings, handler);
}

/** `tray:open-preferences`: the tray asked for the Preferences view. */
export function onOpenPreferences(handler: () => void): () => void {
  return subscribe(OPEN_PREFERENCES_EVENT, isAnything, () => handler());
}

/** `watch:changed`: a watched port is now free, or taken. */
export function onWatchChanged(handler: (watch: WatchedPort) => void): () => void {
  return subscribe(WATCH_CHANGED_EVENT, isWatchedPort, handler);
}

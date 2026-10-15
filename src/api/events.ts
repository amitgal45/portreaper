import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { TasklineEvent, UpdateFailure, UpdateInfo, UpdateProgress } from "../types";
import { isTauri } from "./index";

/** Emitted by the core every time it records something in the Taskline. Payload: `TasklineEvent`. */
export const TASKLINE_EVENT = "taskline:event";
/** Emitted by the core when a check found a newer release (WP-16). Payload: `UpdateInfo`. */
export const UPDATE_AVAILABLE_EVENT = "update:available";
/** Emitted by the core while the update downloads. Payload: `UpdateProgress`. */
export const UPDATE_PROGRESS_EVENT = "update:progress";
/** Emitted by the core when the download or the install failed. Payload: `UpdateFailure`. */
export const UPDATE_ERROR_EVENT = "update:error";

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

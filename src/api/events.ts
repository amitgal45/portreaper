import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { TasklineEvent } from "../types";
import { isTauri } from "./index";

/** Emitted by the core every time it records something in the Taskline. Payload: `TasklineEvent`. */
export const TASKLINE_EVENT = "taskline:event";

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

/**
 * Calls `handler` for every `taskline:event` the core emits. Inside Tauri it subscribes through
 * the event plugin; in a plain browser tab and in tests it does nothing (polling covers the feed).
 * Returns the unsubscribe. Safe to call it before the subscription resolved: the late listener is
 * dropped at once.
 */
export function onTasklineEvent(handler: (event: TasklineEvent) => void): () => void {
  if (!isTauri()) return () => {};
  let active = true;
  let unlisten: UnlistenFn | null = null;
  listen<unknown>(TASKLINE_EVENT, (event) => {
    if (!active) return;
    if (isTasklineEvent(event.payload)) handler(event.payload);
    else console.error("taskline:event with an unexpected payload", event.payload);
  })
    .then((off) => {
      if (active) unlisten = off;
      else off();
    })
    .catch((err) => {
      console.error("could not listen for taskline:event", err);
    });
  return () => {
    active = false;
    unlisten?.();
    unlisten = null;
  };
}

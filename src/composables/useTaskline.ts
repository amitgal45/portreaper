import { computed, getCurrentScope, onScopeDispose, reactive, ref } from "vue";
import { onTasklineEvent } from "../api/events";
import type { PortApi, RelaunchOutcome, TasklineEvent } from "../types";
import type { Toasts } from "./useToasts";

export interface UseTasklineOptions {
  /** Poll interval while visible. */
  intervalMs?: number;
  /** Polls only while this is true. Defaults to `document.visibilityState === "visible"`. */
  isVisible?: () => boolean;
  /** How long a `collisionResolved` port stays amber in the list. */
  collisionWindowMs?: number;
  /** The event bridge. Defaults to `onTasklineEvent` (Tauri inside the app, a no-op elsewhere). */
  subscribe?: typeof onTasklineEvent;
  /** The clock, for tests. */
  now?: () => number;
}

/** A relaunch outcome, or the transport failing before the core could answer. */
export type RelaunchResult = RelaunchOutcome | { status: "transport"; eventId: number; error: string };

/** The sentence a toast carries for one relaunch outcome. */
export function relaunchMessage(
  event: TasklineEvent | null,
  outcome: RelaunchResult,
): { message: string; kind: "info" | "error" } {
  const who = event ? `${event.processName} on port ${event.port}` : "the process";
  switch (outcome.status) {
    case "started":
      return { message: `Relaunched ${who} (new pid ${outcome.pid}).`, kind: "info" };
    case "notFound":
      return { message: `Nothing to relaunch for ${who}: the core forgot it.`, kind: "error" };
    case "failed":
      return { message: `Could not relaunch ${who}: ${outcome.error}.`, kind: "error" };
    case "transport":
      return { message: "Could not reach the core.", kind: "error" };
  }
}

/**
 * The session's feed: what the core did, newest first. Loaded on `start()` and every tick while
 * visible, and pushed by the core's `taskline:event` inside Tauri. `relaunch()` brings a killed
 * process back and says how it went. `recentCollisions` names the ports a `collisionResolved`
 * event touched in the last minute, for the amber port numbers in the list.
 */
export function useTaskline(api: PortApi, toasts: Toasts, options: UseTasklineOptions = {}) {
  const intervalMs = options.intervalMs ?? 2000;
  const collisionWindowMs = options.collisionWindowMs ?? 60_000;
  const subscribe = options.subscribe ?? onTasklineEvent;
  const now = options.now ?? (() => Date.now());
  const isVisible =
    options.isVisible ??
    (() => (typeof document === "undefined" ? true : document.visibilityState === "visible"));

  const events = ref<TasklineEvent[]>([]);
  const loaded = ref(false);
  const error = ref<string | null>(null);
  /** Event ids with a relaunch in flight: the button shows a spinner. */
  const relaunching = reactive(new Set<number>());
  /** Event ids relaunched this session: the button is gone, the process is back. */
  const relaunched = reactive(new Set<number>());
  /** Moves on every poll and every push; `recentCollisions` is measured against it. */
  const clock = ref(now());

  const count = computed(() => events.value.length);
  const recentCollisions = computed(() => {
    const since = clock.value - collisionWindowMs;
    const ports = new Set<number>();
    for (const e of events.value) if (e.kind === "collisionResolved" && e.atMs >= since) ports.add(e.port);
    return ports;
  });

  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let inFlight = false;
  let started = false;

  async function refresh(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      events.value = await api.tasklineEvents();
      error.value = null;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      console.error("tasklineEvents failed", err);
    } finally {
      inFlight = false;
      loaded.value = true;
      clock.value = now();
    }
  }

  /** An event the core pushed: in front, unless a poll already brought it. */
  function push(event: TasklineEvent) {
    clock.value = now();
    if (events.value.some((e) => e.id === event.id)) return;
    events.value = [event, ...events.value];
  }

  function startTimer() {
    if (timer !== null) return;
    timer = setInterval(() => {
      if (isVisible()) void refresh();
    }, intervalMs);
  }

  function stopTimer() {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  function onVisibility() {
    if (isVisible()) {
      void refresh();
      startTimer();
    } else {
      stopTimer();
    }
  }

  function start() {
    if (started) return;
    started = true;
    void refresh();
    unsubscribe = subscribe(push);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
    if (isVisible()) startTimer();
  }

  function stop() {
    if (!started) return;
    started = false;
    stopTimer();
    unsubscribe?.();
    unsubscribe = null;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
  }

  if (getCurrentScope()) onScopeDispose(stop);

  function canRelaunch(event: TasklineEvent): boolean {
    return event.relaunchable && !relaunched.has(event.id);
  }

  /** The newest event for a pid: what Restart relaunches right after its kill. */
  function latestFor(pid: number): TasklineEvent | null {
    return events.value.find((e) => e.pid === pid) ?? null;
  }

  /** Brings the process of `eventId` back. Every outcome becomes a toast; `started` hides the button. */
  async function relaunch(eventId: number): Promise<RelaunchResult> {
    const event = events.value.find((e) => e.id === eventId) ?? null;
    if (relaunching.has(eventId)) return { status: "failed", eventId, error: "already relaunching" };
    relaunching.add(eventId);
    let outcome: RelaunchResult;
    try {
      outcome = await api.relaunch(eventId);
    } catch (err) {
      console.error("relaunch failed", err);
      outcome = { status: "transport", eventId, error: err instanceof Error ? err.message : String(err) };
    } finally {
      relaunching.delete(eventId);
    }
    if (outcome.status === "started") relaunched.add(eventId);
    const { message, kind } = relaunchMessage(event, outcome);
    toasts.push(message, kind);
    // The core recorded `relaunched` (or nothing): show the feed as it is now.
    await refresh();
    return outcome;
  }

  async function clear(): Promise<void> {
    try {
      await api.clearTaskline();
      events.value = [];
    } catch (err) {
      console.error("clearTaskline failed", err);
      toasts.push("Could not clear the Taskline.", "error");
    }
  }

  return {
    events,
    count,
    loaded,
    error,
    relaunching,
    relaunched,
    recentCollisions,
    start,
    stop,
    refresh,
    push,
    canRelaunch,
    latestFor,
    relaunch,
    clear,
  };
}

export type Taskline = ReturnType<typeof useTaskline>;

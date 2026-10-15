import { computed, getCurrentScope, type InjectionKey, inject, onScopeDispose, provide, ref } from "vue";
import { onWatchChanged } from "../api/events";
import type { PortApi, WatchedPort } from "../types";
import { type WatchTarget, watchKey } from "./usePorts";
import type { Toasts } from "./useToasts";

export interface UseWatchOptions {
  /** The event bridge. Defaults to `onWatchChanged` (Tauri inside the app, a no-op elsewhere). */
  subscribe?: typeof onWatchChanged;
}

/** The toast for a transition: what the core's notification says, in one line. */
export function transitionMessage(watch: WatchedPort): string {
  if (watch.state === "free") return `Port ${watch.port} is free`;
  return watch.processName ? `Port ${watch.port} taken by ${watch.processName}` : `Port ${watch.port} taken`;
}

/**
 * The watched ports (WP-18): the set the core keeps, loaded on `start()`, changed through
 * `toggle()`, and kept current by the core's `watch:changed` inside Tauri, which also makes a
 * toast. Whether a port is free is not read from here: `usePorts` derives it from the live list,
 * so a kill frees a watched port at once, in a browser too.
 */
export function useWatch(api: PortApi, toasts: Toasts, options: UseWatchOptions = {}) {
  const subscribe = options.subscribe ?? onWatchChanged;

  const watches = ref<WatchedPort[]>([]);
  const loaded = ref(false);
  const keys = computed(() => new Set(watches.value.map(watchKey)));

  let unsubscribe: (() => void) | null = null;
  let started = false;

  function isWatched(target: WatchTarget): boolean {
    return keys.value.has(watchKey(target));
  }

  async function refresh(): Promise<void> {
    try {
      watches.value = await api.watchedPorts();
    } catch (err) {
      console.error("watchedPorts failed", err);
    } finally {
      loaded.value = true;
    }
  }

  /** Watches the port, or stops watching it. Resolves with whether it is watched afterwards. */
  async function toggle(target: WatchTarget): Promise<boolean> {
    const on = !isWatched(target);
    try {
      watches.value = on
        ? await api.watchPort(target.port, target.protocol)
        : await api.unwatchPort(target.port, target.protocol);
    } catch (err) {
      console.error(on ? "watchPort failed" : "unwatchPort failed", err);
      toasts.push(`Could not ${on ? "watch" : "stop watching"} port ${target.port}.`, "error");
    }
    return isWatched(target);
  }

  /** A transition the core pushed: the watch in its new state, in place, and one toast. */
  function changed(watch: WatchedPort) {
    const key = watchKey(watch);
    const known = watches.value.some((w) => watchKey(w) === key);
    watches.value = known
      ? watches.value.map((w) => (watchKey(w) === key ? watch : w))
      : [...watches.value, watch];
    toasts.push(transitionMessage(watch));
  }

  function start() {
    if (started) return;
    started = true;
    void refresh();
    unsubscribe = subscribe(changed);
  }

  function stop() {
    if (!started) return;
    started = false;
    unsubscribe?.();
    unsubscribe = null;
  }

  if (getCurrentScope()) onScopeDispose(stop);

  return { watches, loaded, keys, isWatched, toggle, refresh, changed, start, stop };
}

export type WatchStore = ReturnType<typeof useWatch>;

export const WATCHED_KEY: InjectionKey<(target: WatchTarget) => boolean> = Symbol("IsWatched");

const NOTHING_WATCHED = (_target: WatchTarget) => false;

/** `App.vue` hands the rows and the inspector `isWatched`: all they need is the question answered. */
export function provideWatched(isWatched: (target: WatchTarget) => boolean) {
  provide(WATCHED_KEY, isWatched);
}

/** Whether a port is watched. Without a provider (a plain test) nothing is. */
export function useWatched(): (target: WatchTarget) => boolean {
  return inject(WATCHED_KEY, NOTHING_WATCHED, false);
}

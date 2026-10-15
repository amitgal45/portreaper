import { type InjectionKey, inject, provide } from "vue";
import type { PortEntry } from "../types";
import type { PortGroup, WatchTarget } from "./usePorts";

/**
 * What a row, a group header or the drawer can ask for. `App.vue` provides the real thing; a
 * test provides spies. Components never reach the api or the store themselves.
 */
export interface UiActions {
  select(entry: PortEntry): void;
  /** Select the row and open the drawer on it. */
  inspect(entry: PortEntry): void;
  kill(entry: PortEntry, force: boolean): void;
  killGroup(group: PortGroup, force: boolean): void;
  /** Graceful kill, then relaunch (the drawer's Restart). */
  restart(entry: PortEntry): void;
  /** Kill every lost-terminal process (the filter strip's Reap). */
  reap(): void;
  toggleGroup(key: string): void;
  openInBrowser(entry: PortEntry): void;
  copyKill(entry: PortEntry): void;
  copyCommand(entry: PortEntry): void;
  revealFolder(entry: PortEntry): void;
  /** Watch the port, or stop watching it (the row menu, the inspector's eye, a free row's Stop watching). */
  watch(target: WatchTarget): void;
}

export const ACTIONS_KEY: InjectionKey<UiActions> = Symbol("UiActions");

export function provideActions(actions: UiActions) {
  provide(ACTIONS_KEY, actions);
}

export function useActions(): UiActions {
  const actions = inject(ACTIONS_KEY, null);
  if (!actions) throw new Error("useActions() needs provideActions() in an ancestor");
  return actions;
}

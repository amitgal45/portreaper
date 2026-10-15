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
  /**
   * The preference "Kill sends SIGKILL at once" (WP-17b). `kill(entry, alt)` already flips on it;
   * this is for the labels, so "Force kill ⌥↩" reads "Graceful kill ⌥↩" while the default is
   * already forceful. Optional: a test's spies leave it out and the labels assume the default.
   */
  defaultForce?(): boolean;
}

/** The two Kill labels, from the preference: the button's title and the menu's ⌥↩ item. */
export function killLabels(defaultForce: boolean): { title: string; alt: string } {
  return defaultForce
    ? { title: "Kill · SIGKILL at once · ⌥ for graceful", alt: "Graceful kill" }
    : { title: "Kill · ⌥ to force", alt: "Force kill" };
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

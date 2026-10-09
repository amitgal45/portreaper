import { type InjectionKey, inject, provide } from "vue";
import type { PortEntry } from "../types";
import type { PortGroup } from "./usePorts";

/**
 * What a row or a group header can ask for. `App.vue` provides the real thing; a test provides
 * spies. Rows never reach the api or the store themselves.
 */
export interface UiActions {
  select(entry: PortEntry): void;
  kill(entry: PortEntry, force: boolean): void;
  killGroup(group: PortGroup, force: boolean): void;
  toggleGroup(key: string): void;
  openInBrowser(entry: PortEntry): void;
  copyKill(entry: PortEntry): void;
  copyCommand(entry: PortEntry): void;
  revealFolder(entry: PortEntry): void;
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

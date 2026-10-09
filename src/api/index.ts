import { type InjectionKey, inject, provide } from "vue";
import type { PortApi } from "../types";
import { mockApi } from "./mock";
import { tauriApi } from "./tauri";

/** True inside the Tauri window, false in a plain browser tab (`pnpm dev`) and in tests. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** The one object the UI talks to. Real core inside the app, a believable mock everywhere else. */
export const api: PortApi = isTauri() ? tauriApi : mockApi;

export const API_KEY: InjectionKey<PortApi> = Symbol("PortApi");

/**
 * Makes a `PortApi` available to every descendant through `useApi()`. Called once by `App.vue`
 * with no argument: it takes an api a test provided from above (`global.provide`), else the
 * singleton. Components never import `api` directly, so tests can hand them `createMockApi()`.
 */
export function provideApi(impl?: PortApi): PortApi {
  const chosen = impl ?? inject(API_KEY, null) ?? api;
  provide(API_KEY, chosen);
  return chosen;
}

export function useApi(): PortApi {
  const injected = inject(API_KEY, null);
  if (!injected) throw new Error("useApi() needs provideApi() in an ancestor");
  return injected;
}

import { reactive, ref } from "vue";
import { isTauri } from "../api";
import { onSettingsChanged } from "../api/events";
import { DEFAULT_SETTINGS, type PortApi, type Settings } from "../types";

/** One field and its new value, typed together: `{ field: "dockIcon", value: "hide" }`. */
export type SettingsPatch = { [K in keyof Settings]: { field: K; value: Settings[K] } }[keyof Settings];

/** How long a row says "Saved" before it fades. */
export const SAVED_MS = 1200;

export interface UseSettingsOptions {
  /** Show the first-run card whatever the core says: the browser seam (`demoOnboarding`) and tests. */
  onboarding?: boolean;
}

/**
 * The browser-only seam for the first-run card: `?onboarding=1` in the URL shows it over the
 * mock's dismissed flag, so `pnpm dev` and the e2e can see the card. Inside Tauri it does
 * nothing: there the stored flag is the only source.
 */
export function demoOnboarding(search: string): boolean {
  if (isTauri()) return false;
  return new URLSearchParams(search).get("onboarding") === "1";
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The preferences (WP-17b): read once, patched one field at a time, and kept in step with the
 * core's `settings:changed` (a change from the tray shows up without a refresh). Every patch
 * saves at once with the merged object; a rejection lands in `error[field]` and that field
 * rolls back. `saved` names the fields that just saved, for the "Saved" fade. Call `start()` on
 * mount and `stop()` on unmount.
 */
export function useSettings(api: PortApi, options: UseSettingsOptions = {}) {
  // The card is dismissed until the core says otherwise: no flash of it on every launch.
  const settings = ref<Settings>({ ...DEFAULT_SETTINGS, onboardingDone: true });
  const loaded = ref(false);
  const loadError = ref<string | null>(null);
  /** Why the last patch of a field was refused, by field; absent when it went through. */
  const error = reactive<Partial<Record<keyof Settings, string>>>({});
  /** Fields that saved within the last `SAVED_MS`. */
  const saved = reactive(new Set<keyof Settings>());
  const savedTimers = new Map<keyof Settings, ReturnType<typeof setTimeout>>();
  let showOnboarding = options.onboarding ?? false;
  const offs: Array<() => void> = [];

  async function load(): Promise<void> {
    try {
      const fromCore = await api.getSettings();
      // The seam applies once: Got it stores the flag and the next load reads it back.
      settings.value = showOnboarding ? { ...fromCore, onboardingDone: false } : fromCore;
      showOnboarding = false;
      loadError.value = null;
    } catch (err) {
      loadError.value = message(err);
      console.error("getSettings failed", err);
    } finally {
      loaded.value = true;
    }
  }

  function markSaved(field: keyof Settings) {
    saved.add(field);
    const pending = savedTimers.get(field);
    if (pending !== undefined) clearTimeout(pending);
    savedTimers.set(
      field,
      setTimeout(() => {
        saved.delete(field);
        savedTimers.delete(field);
      }, SAVED_MS),
    );
  }

  /** Saves one field with the current values of the rest. Resolves true when the core took it. */
  async function patch({ field, value }: SettingsPatch): Promise<boolean> {
    const before = settings.value;
    const next: Settings = { ...before, [field]: value };
    settings.value = next;
    delete error[field];
    try {
      settings.value = await api.setSettings(next);
      markSaved(field);
      return true;
    } catch (err) {
      error[field] = message(err);
      settings.value = { ...settings.value, [field]: before[field] };
      return false;
    }
  }

  function start(): void {
    if (offs.length > 0) return;
    offs.push(
      onSettingsChanged((fromCore) => {
        settings.value = fromCore;
      }),
    );
  }

  function stop(): void {
    for (const off of offs.splice(0)) off();
    for (const timer of savedTimers.values()) clearTimeout(timer);
    savedTimers.clear();
    saved.clear();
  }

  return { settings, loaded, loadError, error, saved, load, patch, start, stop };
}

export type SettingsStore = ReturnType<typeof useSettings>;

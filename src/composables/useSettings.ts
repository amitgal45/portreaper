import { reactive, ref } from "vue";
import { isTauri } from "../api";
import { onSettingsChanged } from "../api/events";
import { DEFAULT_SETTINGS, MAX_HIDDEN_PORTS, type PortApi, type Settings } from "../types";

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

/** A port number that can be hidden: a whole number from 1 to 65535 (port 0 is a portless entry). */
export function isHideablePort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/**
 * `ports` with `port` added, sorted, once each. Always a new array: every copy of
 * `DEFAULT_SETTINGS` shares one `hiddenPorts`, so a push would change the defaults for the page.
 */
export function withHiddenPort(ports: readonly number[], port: number): number[] {
  return [...new Set([...ports, port])].sort((a, b) => a - b);
}

/** `ports` without `port`, as a new array for the same reason. */
export function withoutHiddenPort(ports: readonly number[], port: number): number[] {
  return ports.filter((p) => p !== port);
}

/**
 * The preferences (WP-17b): read once, patched one field at a time, and kept in step with the
 * core's `settings:changed` (a change from the tray shows up without a refresh). Every patch
 * saves at once with the merged object; a rejection lands in `error[field]` and that field
 * rolls back. `saved` names the fields that just saved, for the "Saved" fade. `hidePort` and
 * `unhidePort` are patches of `hiddenPorts` by one port (the row menu's Hide :PORT). Call
 * `start()` on mount and `stop()` on unmount.
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

  /**
   * Hides `port` wherever PortReaper lists ports. Resolves true when it is hidden afterwards; a
   * port already hidden is a no-op. Resolves false, without asking the core, for a port that
   * cannot be hidden (0, or not a port number) and when `MAX_HIDDEN_PORTS` are hidden already,
   * since the core would keep the lowest ones and could drop this one; and false when the core
   * refused the save, which rolls back like any patch.
   */
  async function hidePort(port: number): Promise<boolean> {
    const current = settings.value.hiddenPorts;
    if (!isHideablePort(port)) return false;
    if (current.includes(port)) return true;
    if (current.length >= MAX_HIDDEN_PORTS) return false;
    return patch({ field: "hiddenPorts", value: withHiddenPort(current, port) });
  }

  /** Shows `port` again. Resolves true when it is not hidden afterwards; false when the core refused. */
  async function unhidePort(port: number): Promise<boolean> {
    const current = settings.value.hiddenPorts;
    if (!current.includes(port)) return true;
    return patch({ field: "hiddenPorts", value: withoutHiddenPort(current, port) });
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

  return { settings, loaded, loadError, error, saved, load, patch, hidePort, unhidePort, start, stop };
}

export type SettingsStore = ReturnType<typeof useSettings>;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_CHANGED_EVENT } from "../api/events";
import { createMockApi } from "../api/mock";
import { DEFAULT_SETTINGS, MAX_HIDDEN_PORTS, type Settings } from "../types";
import {
  demoOnboarding,
  isHideablePort,
  SAVED_MS,
  useSettings,
  withHiddenPort,
  withoutHiddenPort,
} from "./useSettings";

const { listen } = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

const tauri = window as unknown as Record<string, unknown>;

describe("demoOnboarding", () => {
  afterEach(() => {
    delete tauri.__TAURI_INTERNALS__;
  });

  it("forces the card for ?onboarding=1 in a browser, and not otherwise", () => {
    expect(demoOnboarding("?onboarding=1")).toBe(true);
    expect(demoOnboarding("?update=1&onboarding=1")).toBe(true);
    expect(demoOnboarding("")).toBe(false);
    expect(demoOnboarding("?onboarding=0")).toBe(false);
  });

  it("does nothing inside Tauri, where the stored flag is the only source", () => {
    tauri.__TAURI_INTERNALS__ = {};
    expect(demoOnboarding("?onboarding=1")).toBe(false);
  });
});

describe("hidden port helpers", () => {
  it("take whole numbers from 1 to 65535; add once, sorted; remove; and always hand out a new array", () => {
    for (const port of [1, 5000, 65_535]) expect(isHideablePort(port)).toBe(true);
    for (const port of [0, -1, 65_536, 1.5, Number.NaN]) expect(isHideablePort(port)).toBe(false);

    const ports = [5000, 7000];
    expect(withHiddenPort(ports, 3000)).toEqual([3000, 5000, 7000]);
    expect(withHiddenPort(ports, 7000)).toEqual([5000, 7000]);
    expect(withHiddenPort(ports, 7000)).not.toBe(ports);
    expect(withoutHiddenPort(ports, 5000)).toEqual([7000]);
    expect(withoutHiddenPort(ports, 4000)).toEqual([5000, 7000]);
    expect(withoutHiddenPort(ports, 4000)).not.toBe(ports);
    expect(ports).toEqual([5000, 7000]);
  });
});

describe("useSettings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    listen.mockReset();
    delete tauri.__TAURI_INTERNALS__;
  });

  it("starts from the defaults with the card dismissed, then reads the core", async () => {
    const api = createMockApi();
    const store = useSettings(api);
    expect(store.loaded.value).toBe(false);
    expect(store.settings.value).toEqual({ ...DEFAULT_SETTINGS, onboardingDone: true });
    await store.load();
    expect(store.loaded.value).toBe(true);
    expect(store.settings.value).toEqual(await api.getSettings());
  });

  it("patch sends the merged object, keeps what the core answered and shows Saved for a moment", async () => {
    const api = createMockApi();
    const setSettings = vi.spyOn(api, "setSettings");
    const store = useSettings(api);
    await store.load();

    const done = store.patch({ field: "dockIcon", value: "hide" });
    // Optimistic: the toggle flips before the core answers.
    expect(store.settings.value.dockIcon).toBe("hide");
    expect(await done).toBe(true);
    expect(setSettings).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, onboardingDone: true, dockIcon: "hide" });
    expect(store.saved.has("dockIcon")).toBe(true);
    expect(store.saved.has("startAtLogin")).toBe(false);
    expect((await api.getSettings()).dockIcon).toBe("hide");

    await vi.advanceTimersByTimeAsync(SAVED_MS);
    expect(store.saved.has("dockIcon")).toBe(false);

    // The core may answer with an adjusted value: the mock clamps the interval.
    await store.patch({ field: "refreshMs", value: 100 });
    expect(store.settings.value.refreshMs).toBe(1000);
  });

  it("a rejected patch lands in error[field], the value rolls back and the rest stands", async () => {
    const api = createMockApi();
    await api.setSettings({ ...DEFAULT_SETTINGS, onboardingDone: true, notifications: false });
    vi.spyOn(api, "setSettings").mockRejectedValueOnce("⌃⌥K is taken by another app");
    const store = useSettings(api);
    await store.load();

    expect(await store.patch({ field: "quickShortcut", value: "Control+Alt+K" })).toBe(false);
    expect(store.error.quickShortcut).toBe("⌃⌥K is taken by another app");
    expect(store.settings.value.quickShortcut).toBe("CmdOrCtrl+Shift+K");
    expect(store.settings.value.notifications).toBe(false);
    expect(store.saved.has("quickShortcut")).toBe(false);

    // The next attempt on that field clears the error first; an Error's message reads the same way.
    vi.spyOn(api, "setSettings").mockRejectedValueOnce(new Error("still taken"));
    await store.patch({ field: "quickShortcut", value: "Control+Alt+K" });
    expect(store.error.quickShortcut).toBe("still taken");
    await store.patch({ field: "quickShortcut", value: "Control+Alt+P" });
    expect(store.error.quickShortcut).toBeUndefined();
    expect(store.settings.value.quickShortcut).toBe("Control+Alt+P");
  });

  it("follows settings:changed from the core while started", async () => {
    tauri.__TAURI_INTERNALS__ = {};
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    const store = useSettings(createMockApi());
    await store.load();
    store.start();
    store.start();
    await Promise.resolve();
    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen.mock.calls[0]?.[0]).toBe(SETTINGS_CHANGED_EVENT);

    const deliver = listen.mock.calls[0]?.[1] as (event: { payload: unknown }) => void;
    const fromTray: Settings = { ...DEFAULT_SETTINGS, onboardingDone: true, startAtLogin: false };
    deliver({ payload: fromTray });
    expect(store.settings.value).toEqual(fromTray);
    deliver({ payload: { startAtLogin: "no" } });
    expect(store.settings.value).toEqual(fromTray);

    store.stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("the onboarding seam shows the card once; Got it stores the flag and a reload keeps it", async () => {
    const api = createMockApi();
    const store = useSettings(api, { onboarding: true });
    await store.load();
    expect(store.settings.value.onboardingDone).toBe(false);
    // The core was not asked to forget the flag: the seam is in the UI only.
    expect((await api.getSettings()).onboardingDone).toBe(true);

    await store.patch({ field: "onboardingDone", value: true });
    expect(store.settings.value.onboardingDone).toBe(true);
    await store.load();
    expect(store.settings.value.onboardingDone).toBe(true);
  });

  it("hidePort adds one port, sorted and once; unhidePort takes it out; the defaults' array is never touched", async () => {
    const api = createMockApi();
    const setSettings = vi.spyOn(api, "setSettings");
    // Before the first load the store holds a copy of the defaults, which shares their array.
    const store = useSettings(api);

    expect(await store.hidePort(7000)).toBe(true);
    expect(await store.hidePort(5000)).toBe(true);
    expect(store.settings.value.hiddenPorts).toEqual([5000, 7000]);
    expect(store.saved.has("hiddenPorts")).toBe(true);
    expect(DEFAULT_SETTINGS.hiddenPorts).toEqual([]);
    expect((await api.getSettings()).hiddenPorts).toEqual([5000, 7000]);
    expect(setSettings).toHaveBeenCalledTimes(2);

    // Already hidden: true, and the core is not asked again.
    expect(await store.hidePort(5000)).toBe(true);
    // A portless entry and numbers that are not ports: refused before the core is asked.
    expect(await store.hidePort(0)).toBe(false);
    expect(await store.hidePort(70_000)).toBe(false);
    expect(await store.hidePort(1.5)).toBe(false);
    expect(setSettings).toHaveBeenCalledTimes(2);
    expect(store.error.hiddenPorts).toBeUndefined();

    expect(await store.unhidePort(5000)).toBe(true);
    expect(store.settings.value.hiddenPorts).toEqual([7000]);
    // Not hidden: nothing to do.
    expect(await store.unhidePort(5000)).toBe(true);
    expect(setSettings).toHaveBeenCalledTimes(3);
    expect((await api.getSettings()).hiddenPorts).toEqual([7000]);
    expect(DEFAULT_SETTINGS.hiddenPorts).toEqual([]);
  });

  it("hidePort refuses past MAX_HIDDEN_PORTS without asking the core; one shown again makes room", async () => {
    const api = createMockApi();
    const full = Array.from({ length: MAX_HIDDEN_PORTS }, (_, i) => 1000 + i);
    await api.setSettings({ ...(await api.getSettings()), hiddenPorts: full });
    const store = useSettings(api);
    await store.load();
    const setSettings = vi.spyOn(api, "setSettings");

    expect(await store.hidePort(5000)).toBe(false);
    expect(setSettings).not.toHaveBeenCalled();
    expect(store.settings.value.hiddenPorts).toEqual(full);

    expect(await store.unhidePort(1000)).toBe(true);
    expect(await store.hidePort(5000)).toBe(true);
    expect(store.settings.value.hiddenPorts).toHaveLength(MAX_HIDDEN_PORTS);
    expect(store.settings.value.hiddenPorts[0]).toBe(1001);
    expect(store.settings.value.hiddenPorts[MAX_HIDDEN_PORTS - 1]).toBe(5000);
  });

  it("a refused hidePort or unhidePort rolls back and says why under the row", async () => {
    const api = createMockApi();
    await api.setSettings({ ...(await api.getSettings()), hiddenPorts: [7000] });
    const store = useSettings(api);
    await store.load();

    vi.spyOn(api, "setSettings").mockRejectedValueOnce(new Error("the store is read-only"));
    const done = store.hidePort(5000);
    // Optimistic, like every patch.
    expect(store.settings.value.hiddenPorts).toEqual([5000, 7000]);
    expect(await done).toBe(false);
    expect(store.settings.value.hiddenPorts).toEqual([7000]);
    expect(store.error.hiddenPorts).toBe("the store is read-only");
    expect(store.saved.has("hiddenPorts")).toBe(false);
    expect((await api.getSettings()).hiddenPorts).toEqual([7000]);

    vi.spyOn(api, "setSettings").mockRejectedValueOnce(new Error("still read-only"));
    expect(await store.unhidePort(7000)).toBe(false);
    expect(store.settings.value.hiddenPorts).toEqual([7000]);
    expect(store.error.hiddenPorts).toBe("still read-only");

    // The next save goes through and clears the complaint.
    expect(await store.unhidePort(7000)).toBe(true);
    expect(store.settings.value.hiddenPorts).toEqual([]);
    expect(store.error.hiddenPorts).toBeUndefined();
  });

  it("a failed load keeps the defaults and says so", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getSettings").mockRejectedValueOnce(new Error("no core"));
    const store = useSettings(api);
    await store.load();
    expect(store.loaded.value).toBe(true);
    expect(store.loadError.value).toBe("no core");
    expect(store.settings.value).toEqual({ ...DEFAULT_SETTINGS, onboardingDone: true });
  });
});

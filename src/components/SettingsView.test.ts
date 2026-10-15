import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { API_KEY } from "../api";
import { createMockApi } from "../api/mock";
import { DEFAULT_SETTINGS, type Settings } from "../types";
import SettingsView from "./SettingsView.vue";

function mountView(
  overrides: Partial<Settings> = {},
  extra: { error?: Partial<Record<keyof Settings, string>>; saved?: Set<keyof Settings> } = {},
  api = createMockApi(),
) {
  const settings: Settings = { ...DEFAULT_SETTINGS, onboardingDone: true, ...overrides };
  const wrapper = mount(SettingsView, {
    props: {
      settings,
      error: extra.error ?? {},
      saved: extra.saved ?? new Set<keyof Settings>(),
      version: "0.3.0",
    },
    global: { provide: { [API_KEY as symbol]: api } },
    attachTo: document.body,
  });
  return { wrapper, api };
}

const pref = (wrapper: ReturnType<typeof mountView>["wrapper"], field: string) =>
  wrapper.get(`[data-pref='${field}']`);

describe("SettingsView", () => {
  it("has the four groups and one control per field, named by its row", () => {
    const { wrapper } = mountView();
    expect(wrapper.get("[data-view='settings']").attributes("aria-label")).toBe("Preferences");
    expect(wrapper.findAll("h2").map((h) => h.text())).toEqual(["General", "Shortcuts", "Killing", "About"]);
    for (const field of ["dockIcon", "startAtLogin", "defaultForce", "notifications"]) {
      const control = pref(wrapper, field);
      expect(control.attributes("role")).toBe("switch");
      expect(control.attributes("aria-labelledby")).toBe(`pref-${field}`);
      expect(wrapper.get(`#pref-${field}`).text()).not.toBe("");
    }
    expect(pref(wrapper, "dockIcon").attributes("aria-checked")).toBe("true");
    expect(pref(wrapper, "startAtLogin").attributes("aria-checked")).toBe("true");
    expect(pref(wrapper, "defaultForce").attributes("aria-checked")).toBe("false");
    expect(pref(wrapper, "notifications").attributes("aria-checked")).toBe("true");
    expect(pref(wrapper, "refreshMs").attributes("role")).toBe("radiogroup");
    expect(pref(wrapper, "quickShortcut").get("[data-recorder]").text()).toBe("⌘⇧K");
    expect(pref(wrapper, "windowShortcut").get("[data-recorder]").text()).toBe("⌘⇧P");
    expect(wrapper.get("[data-version]").text()).toBe("PortReaper 0.3.0");
    // The Dock row's help names the current Quick chord.
    expect(wrapper.get("[data-row='dockIcon']").text()).toContain("on ⌘⇧K.");
    // The strip carries the drag region, like every top strip of the UI.
    expect(wrapper.get("header").attributes("data-tauri-drag-region")).toBeDefined();
    wrapper.unmount();
  });

  it("a toggle emits the field's patch; Show in Dock maps to the dock value", async () => {
    const { wrapper } = mountView({ dockIcon: "hide" });
    expect(pref(wrapper, "dockIcon").attributes("aria-checked")).toBe("false");
    await pref(wrapper, "dockIcon").trigger("click");
    await pref(wrapper, "defaultForce").trigger("click");
    await pref(wrapper, "notifications").trigger("click");
    expect(wrapper.emitted("patch")).toEqual([
      [{ field: "dockIcon", value: "show" }],
      [{ field: "defaultForce", value: true }],
      [{ field: "notifications", value: false }],
    ]);
    wrapper.unmount();
  });

  it("the segmented control marks the interval and emits a new one in ms", async () => {
    const { wrapper } = mountView({ refreshMs: 5000 });
    const radios = pref(wrapper, "refreshMs").findAll("[role='radio']");
    expect(radios.map((r) => r.text())).toEqual(["1 s", "2 s", "5 s", "10 s"]);
    expect(radios.map((r) => r.attributes("aria-checked"))).toEqual(["false", "false", "true", "false"]);
    await radios[3]?.trigger("click");
    expect(wrapper.emitted("patch")).toEqual([[{ field: "refreshMs", value: 10_000 }]]);
    wrapper.unmount();
  });

  it("a recorded chord becomes the shortcut's patch; Reset shows while it differs", async () => {
    const { wrapper } = mountView({ quickShortcut: "Control+Alt+K" });
    const quick = pref(wrapper, "quickShortcut");
    expect(quick.get("[data-recorder]").text()).toBe("⌃⌥K");
    await quick.get("[data-action='reset']").trigger("click");
    expect(wrapper.emitted("patch")).toEqual([[{ field: "quickShortcut", value: "CmdOrCtrl+Shift+K" }]]);

    const win = pref(wrapper, "windowShortcut");
    expect(win.find("[data-action='reset']").exists()).toBe(false);
    const recorder = win.get("[data-recorder]");
    await recorder.trigger("click");
    const chord = { key: "p", code: "KeyP", metaKey: true, altKey: true, bubbles: true, cancelable: true };
    recorder.element.dispatchEvent(new KeyboardEvent("keydown", chord));
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("patch")?.[1]).toEqual([{ field: "windowShortcut", value: "CmdOrCtrl+Alt+P" }]);
    wrapper.unmount();
  });

  it("says Saved on the row that saved, and the core's refusal in red under its row", () => {
    const { wrapper } = mountView(
      {},
      { saved: new Set(["startAtLogin"]), error: { quickShortcut: "⌃⌥K is taken by another app" } },
    );
    const savedOn = (field: string) => wrapper.get(`[data-row='${field}']`).text().includes("Saved");
    // The mark is always in the row for the fade; its opacity says whether it shows.
    const mark = (field: string) => wrapper.get(`[data-row='${field}'] .transition-opacity`).classes();
    expect(savedOn("startAtLogin")).toBe(true);
    expect(mark("startAtLogin")).toContain("opacity-100");
    expect(mark("dockIcon")).toContain("opacity-0");

    const alert = wrapper.get("[data-row='quickShortcut'] [role='alert']");
    expect(alert.text()).toBe("⌃⌥K is taken by another app");
    expect(alert.classes()).toContain("text-red-ink");
    expect(wrapper.find("[data-row='windowShortcut'] [role='alert']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("Check for Updates… asks the core; in a browser it says so", async () => {
    const api = createMockApi();
    const check = vi.spyOn(api, "checkForUpdates");
    const { wrapper } = mountView({}, {}, api);
    await wrapper.get("[data-action='check-updates']").trigger("click");
    await flushPromises();
    expect(check).toHaveBeenCalledTimes(1);
    expect(wrapper.get("[data-update-note]").text()).toBe("Not available in the browser");

    check.mockRejectedValueOnce(new Error("no network"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await wrapper.get("[data-action='check-updates']").trigger("click");
    await flushPromises();
    expect(wrapper.get("[data-update-note]").text()).toBe("no network");
    wrapper.unmount();
  });
});

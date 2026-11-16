import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { API_KEY } from "../api";
import { createMockApi } from "../api/mock";
import { DEFAULT_SETTINGS, MAX_HIDDEN_PORTS, type Settings } from "../types";
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

  it("Hidden ports: Enter or Hide hides the typed port, sorted; a chip's × shows it again", async () => {
    const { wrapper } = mountView({ hiddenPorts: [7000] });
    const row = wrapper.get("[data-row='hiddenPorts']");
    expect(wrapper.get("#pref-hiddenPorts").text()).toBe("Hidden ports");
    expect(row.text()).toContain(
      "Left out of the list, the menu bar, ⌘⇧K and the bulk kills. macOS's AirPlay Receiver holds 5000 and 7000.",
    );
    const chips = () => wrapper.findAll("[data-hidden-port]").map((c) => c.text());
    expect(chips()).toEqual([":7000"]);
    const input = pref(wrapper, "hiddenPorts").get("input");
    expect(input.attributes("aria-label")).toBe("Port to hide");
    const hide = pref(wrapper, "hiddenPorts").get("[data-action='hide-port']");
    expect(hide.text()).toBe("Hide");
    expect(hide.attributes("disabled")).toBeUndefined();

    await input.setValue("5000");
    await input.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("patch")).toEqual([[{ field: "hiddenPorts", value: [5000, 7000] }]]);
    // The field empties for the next one.
    expect((input.element as HTMLInputElement).value).toBe("");

    // The parent saved it: two chips, in order. Hide takes the next one like Enter does.
    const both: Settings = { ...DEFAULT_SETTINGS, onboardingDone: true, hiddenPorts: [5000, 7000] };
    await wrapper.setProps({ settings: both });
    expect(chips()).toEqual([":5000", ":7000"]);
    await input.setValue("3000");
    await hide.trigger("click");
    expect(wrapper.emitted("patch")?.[1]).toEqual([{ field: "hiddenPorts", value: [3000, 5000, 7000] }]);

    const remove = wrapper.get("button[aria-label='Show port 5000 again']");
    expect(remove.attributes("title")).toBe("Show port 5000 again");
    await remove.trigger("click");
    expect(wrapper.emitted("patch")?.[2]).toEqual([{ field: "hiddenPorts", value: [7000] }]);
    // Its × is going away: the focus waits in the field.
    expect(document.activeElement).toBe(input.element);
    expect(row.find("[role='alert']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("Hidden ports: 0, 70000 and a port already hidden are refused in red under the row, and nothing is sent", async () => {
    const { wrapper } = mountView({ hiddenPorts: [5000] });
    const input = pref(wrapper, "hiddenPorts").get("input");
    const alert = () => wrapper.find("[data-row='hiddenPorts'] [role='alert']");
    for (const typed of ["0", "70000"]) {
      await input.setValue(typed);
      await input.trigger("keydown", { key: "Enter" });
      expect(alert().text()).toBe("Enter a port from 1 to 65535.");
      expect(alert().classes()).toContain("text-red-ink");
      expect(input.attributes("aria-invalid")).toBe("true");
    }
    // The next key takes the complaint away.
    await input.setValue("5000");
    expect(alert().exists()).toBe(false);
    expect(input.attributes("aria-invalid")).toBeUndefined();
    await pref(wrapper, "hiddenPorts").get("[data-action='hide-port']").trigger("click");
    expect(alert().text()).toBe("Port 5000 is already hidden.");
    expect(wrapper.emitted("patch")).toBeUndefined();
    wrapper.unmount();

    // The core's refusal shows in the same place.
    const { wrapper: refused } = mountView({}, { error: { hiddenPorts: "the store is read-only" } });
    expect(refused.get("[data-row='hiddenPorts'] [role='alert']").text()).toBe("the store is read-only");
    refused.unmount();
  });

  it("Hidden ports: at MAX_HIDDEN_PORTS Hide is off and the hint says why; the row says Saved", async () => {
    const full = Array.from({ length: MAX_HIDDEN_PORTS }, (_, i) => 1000 + i);
    const { wrapper } = mountView({ hiddenPorts: full }, { saved: new Set(["hiddenPorts"]) });
    const row = wrapper.get("[data-row='hiddenPorts']");
    expect(row.findAll("[data-hidden-port]")).toHaveLength(MAX_HIDDEN_PORTS);
    const hide = pref(wrapper, "hiddenPorts").get("[data-action='hide-port']");
    expect(hide.attributes("disabled")).toBeDefined();
    expect(row.text()).toContain(`${MAX_HIDDEN_PORTS} is the most: show one again to hide another.`);
    expect(row.get(".transition-opacity").classes()).toContain("opacity-100");

    // Enter does nothing either: the hint already says why.
    const input = pref(wrapper, "hiddenPorts").get("input");
    await input.setValue("5000");
    await input.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("patch")).toBeUndefined();
    expect(row.find("[role='alert']").exists()).toBe(false);
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

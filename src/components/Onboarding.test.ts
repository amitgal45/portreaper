import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import Onboarding from "./Onboarding.vue";

describe("Onboarding", () => {
  it("names the menu bar, the chord and the login state; the toggle and Got it emit", async () => {
    const wrapper = mount(Onboarding, { props: { startAtLogin: true, quickShortcut: "CmdOrCtrl+Shift+K" } });
    const card = wrapper.get("[data-onboarding]");
    expect(card.attributes("aria-label")).toBe("Welcome");
    expect(card.text()).toContain("PortReaper is in your menu bar");
    expect(card.get("kbd").text()).toBe("⌘⇧K");
    expect(card.text()).toContain("frees a port from anywhere");
    expect(card.text()).toContain("Quit lives there");
    expect(card.text()).toContain("Start at login is on");

    const toggle = card.get("[data-pref='startAtLogin']");
    expect(toggle.attributes("role")).toBe("switch");
    expect(toggle.attributes("aria-checked")).toBe("true");
    await toggle.trigger("click");
    expect(wrapper.emitted("update:startAtLogin")).toEqual([[false]]);

    await wrapper.setProps({ startAtLogin: false, quickShortcut: "Control+Alt+K" });
    expect(card.text()).toContain("Start at login is off");
    expect(card.get("kbd").text()).toBe("⌃⌥K");

    await card.get("[data-action='got-it']").trigger("click");
    expect(wrapper.emitted("done")).toEqual([[]]);
  });
});

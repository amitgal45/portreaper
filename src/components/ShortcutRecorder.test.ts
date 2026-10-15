import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ShortcutRecorder from "./ShortcutRecorder.vue";

function mountRecorder(modelValue = "CmdOrCtrl+Shift+K") {
  const wrapper = mount(ShortcutRecorder, {
    props: { modelValue, defaultValue: "CmdOrCtrl+Shift+K", labelId: "label-quick" },
    attachTo: document.body,
  });
  const button = wrapper.get("[data-recorder]");
  const press = (init: KeyboardEventInit) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    button.element.dispatchEvent(event);
    return event;
  };
  return { wrapper, button, press };
}

describe("ShortcutRecorder", () => {
  it("shows the chord as glyphs, named by the row's label", () => {
    const { wrapper, button } = mountRecorder();
    expect(button.text()).toBe("⌘⇧K");
    expect(button.attributes("aria-labelledby")).toBe("label-quick");
    expect(wrapper.find("[data-action='reset']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("a click records; the modifiers show as they are held; ⌃⌥K saves Control+Alt+K", async () => {
    const { wrapper, button, press } = mountRecorder();
    await button.trigger("click");
    expect(button.text()).toBe("Press keys…");
    expect(button.attributes("data-recording")).toBe("true");

    // The window-level keys must stay quiet: every key is taken while recording.
    const shift = press({ key: "Shift", code: "ShiftLeft", shiftKey: true });
    expect(shift.defaultPrevented).toBe(true);
    await wrapper.vm.$nextTick();
    expect(button.text()).toBe("⇧…");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();

    press({ key: "˚", code: "KeyK", ctrlKey: true, altKey: true });
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("update:modelValue")).toEqual([["Control+Alt+K"]]);
    expect(button.attributes("data-recording")).toBeUndefined();
    // The parent owns the value: until it answers, the old chord shows.
    expect(button.text()).toBe("⌘⇧K");

    await wrapper.setProps({ modelValue: "Control+Alt+K" });
    expect(button.text()).toBe("⌃⌥K");
    expect(wrapper.get("[data-action='reset']").attributes("title")).toBe("Back to ⌘⇧K");
    await wrapper.get("[data-action='reset']").trigger("click");
    expect(wrapper.emitted("update:modelValue")).toEqual([["Control+Alt+K"], ["CmdOrCtrl+Shift+K"]]);
    wrapper.unmount();
  });

  it("Esc, a second click and leaving cancel; the same chord again saves nothing", async () => {
    const { wrapper, button, press } = mountRecorder();
    await button.trigger("click");
    const esc = press({ key: "Escape", code: "Escape" });
    expect(esc.defaultPrevented).toBe(true);
    await wrapper.vm.$nextTick();
    expect(button.text()).toBe("⌘⇧K");

    await button.trigger("click");
    await button.trigger("click");
    expect(button.text()).toBe("⌘⇧K");

    await button.trigger("click");
    await button.trigger("blur");
    expect(button.text()).toBe("⌘⇧K");

    await button.trigger("click");
    press({ key: "k", code: "KeyK", metaKey: true, shiftKey: true });
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    expect(button.text()).toBe("⌘⇧K");
    wrapper.unmount();
  });

  it("refuses a bare letter and ⌘W inline and keeps recording", async () => {
    const { wrapper, button, press } = mountRecorder();
    await button.trigger("click");
    press({ key: "k", code: "KeyK" });
    await wrapper.vm.$nextTick();
    expect(wrapper.get("[data-refused]").text()).toBe("Add ⌘, ⌃ or ⌥.");
    expect(button.attributes("data-recording")).toBe("true");

    press({ key: "w", code: "KeyW", metaKey: true });
    await wrapper.vm.$nextTick();
    expect(wrapper.get("[data-refused]").text()).toBe("⌘W belongs to macOS.");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();

    press({ key: "w", code: "KeyW", metaKey: true, shiftKey: true });
    await wrapper.vm.$nextTick();
    expect(wrapper.find("[data-refused]").exists()).toBe(false);
    expect(wrapper.emitted("update:modelValue")).toEqual([["CmdOrCtrl+Shift+W"]]);
    wrapper.unmount();
  });

  it("outside recording a key is not ours", async () => {
    const { wrapper, press } = mountRecorder();
    const k = press({ key: "k", code: "KeyK", metaKey: true });
    expect(k.defaultPrevented).toBe(false);
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    wrapper.unmount();
  });
});

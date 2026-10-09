import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_KEY } from "../api";
import { createMockApi } from "../api/mock";
import QuickApp from "./QuickApp.vue";

vi.mock("../api/window", () => ({ hideCurrentWindow: vi.fn(async () => false) }));

/** The strip mounted on the mock, loaded once. */
async function mountQuick() {
  const api = createMockApi();
  const freePort = vi.spyOn(api, "freePort");
  const wrapper = mount(QuickApp, {
    attachTo: document.body,
    global: { provide: { [API_KEY as symbol]: api } },
  });
  await flushPromises();
  return { wrapper, api, freePort };
}

const key = (k: string, init: KeyboardEventInit = {}) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key: k, cancelable: true, ...init }));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("QuickApp", () => {
  it("shows the recents with the first selected, the hint, and the footer", async () => {
    const { wrapper } = await mountQuick();
    const options = wrapper.findAll("[role='option']");
    expect(options.map((o) => o.attributes("data-port"))).toEqual(["5173", "3000", "8080", "5174", "9335"]);
    expect(options[0]?.attributes("aria-selected")).toBe("true");
    expect(options[0]?.text()).toContain("↩ free");
    expect(options[2]?.text()).toContain("exposed");
    expect(wrapper.find("footer").text()).toBe("↑↓ choose · ↩ free · ⌥↩ force · esc close");
    expect(document.activeElement).toBe(wrapper.find("input").element);
    wrapper.unmount();
  });

  it("type 30, Enter: the row becomes the result, then the strip clears", async () => {
    vi.useFakeTimers();
    try {
      const { wrapper, freePort } = await mountQuick();
      const input = wrapper.find("input");
      await input.setValue("30");
      expect(input.classes()).toContain("font-mono");
      expect(wrapper.findAll("[role='option']").map((o) => o.attributes("data-port"))).toEqual(["3000"]);

      key("Enter");
      await vi.advanceTimersByTimeAsync(0);
      expect(freePort).toHaveBeenCalledWith(3000, false);
      expect(wrapper.find("[role='option']").text()).toContain("Freed :3000 · node (48213)");

      await vi.advanceTimersByTimeAsync(1200);
      expect((input.element as HTMLInputElement).value).toBe("");
      expect(wrapper.findAll("[role='option']").map((o) => o.attributes("data-port"))).toEqual([
        "5173",
        "8080",
        "5174",
        "9335",
      ]);
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a protected row asks again before Enter kills it; a bad query says so", async () => {
    const { wrapper, freePort } = await mountQuick();
    const input = wrapper.find("input");
    await input.setValue("5432");
    key("Enter");
    await flushPromises();
    expect(freePort).not.toHaveBeenCalled();
    expect(wrapper.find("[role='option']").text()).toContain(
      "This is Docker (com.docker.backend). Press Enter again to kill it.",
    );
    key("Escape");
    await flushPromises();
    expect(wrapper.find("[role='option']").text()).not.toContain("Press Enter again");

    await input.setValue("99");
    expect(wrapper.find("[role='listbox']").text()).toBe("Nothing on :99");
    wrapper.unmount();
  });
});

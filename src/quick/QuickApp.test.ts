import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_KEY } from "../api";
import { createMockApi, MOCK_ENTRIES } from "../api/mock";
import { OLLAMA } from "./fixtures";
import QuickApp from "./QuickApp.vue";

vi.mock("../api/window", () => ({ hideCurrentWindow: vi.fn(async () => false) }));

/** Mounted strips; `afterEach` unmounts them so a failed test's window listener cannot leak into the next. */
const mounted: VueWrapper[] = [];

/** The strip mounted on the mock, loaded once. */
async function mountQuick(api = createMockApi()) {
  const freePort = vi.spyOn(api, "freePort");
  const wrapper = mount(QuickApp, {
    attachTo: document.body,
    global: { provide: { [API_KEY as symbol]: api } },
  });
  mounted.push(wrapper);
  await flushPromises();
  return { wrapper, api, freePort };
}

const key = (k: string, init: KeyboardEventInit = {}) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key: k, cancelable: true, ...init }));

beforeEach(() => {
  sessionStorage.clear();
});
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  document.body.innerHTML = "";
});

describe("QuickApp", () => {
  it("shows the pre-selection with the zombie first and selected, the hint, the header and the footer", async () => {
    const { wrapper } = await mountQuick();
    const options = wrapper.findAll("[role='option']");
    expect(options.map((o) => o.attributes("data-port"))).toEqual(["5174", "5173", "3000", "8080", "9335"]);
    expect(options[0]?.attributes("aria-selected")).toBe("true");
    expect(options[0]?.text()).toContain("↩ free");
    expect(options[0]?.classes()).toContain("ring-coral");
    expect(options[1]?.classes()).not.toContain("ring-coral");
    expect(options[3]?.text()).toContain("exposed");
    expect(wrapper.find("header").text()).toBe("PortReaper · 9 ports · ⌘⇧K");
    expect(wrapper.find("footer").text()).toBe("↑↓ choose · ↩ free · ⌥↩ force · esc close");
    expect(document.activeElement).toBe(wrapper.find("input").element);
  });

  it("marks a lost-terminal row with ⚡ and gives every categorised row its chip", async () => {
    const { wrapper } = await mountQuick();
    const option = (port: number) => wrapper.find(`[role='option'][data-port='${port}']`);
    const chip = (port: number) => option(port).find("[data-chip]");
    expect(option(5174).find("[aria-label='lost terminal']").text()).toBe("⚡");
    expect(option(5173).find("[aria-label='lost terminal']").exists()).toBe(false);
    expect(chip(5174).text()).toBe("web");
    expect(chip(3000).text()).toBe("web");
    expect(chip(8080).text()).toBe("api");
    expect(chip(9335).exists()).toBe(false);

    await wrapper.find("input").setValue("5432");
    expect(chip(5432).text()).toBe("db");
    expect(chip(5432).classes()).toContain("text-azure");
    expect(option(5432).find("[aria-label='protected']").exists()).toBe(true);
  });

  it("an ai row's chip carries its memory", async () => {
    const { wrapper } = await mountQuick(createMockApi([...MOCK_ENTRIES, OLLAMA]));
    const ollama = wrapper.find("[role='option'][data-port='11434']");
    expect(ollama.attributes("data-category")).toBe("ai");
    expect(ollama.text()).toContain("ollama");
    expect(ollama.find("[data-chip]").text()).toBe("AI · 4.9 GB");
    expect(ollama.find("[data-chip]").classes()).toContain("text-violet");
    expect(wrapper.find("header").text()).toBe("PortReaper · 10 ports · ⌘⇧K");
  });

  it("a refusal shows in the row and stays; the row is whole again afterwards", async () => {
    vi.useFakeTimers();
    try {
      const api = createMockApi();
      vi.spyOn(api, "freePort").mockResolvedValue([
        { status: "refused", pid: 48213, reason: "permission denied" },
      ]);
      const { wrapper } = await mountQuick(api);
      const input = wrapper.find("input");
      await input.setValue("3000");
      key("Enter");
      await vi.advanceTimersByTimeAsync(0);
      const row = wrapper.find("[role='option'][data-port='3000']");
      expect(row.text()).toBe("Did not kill node (48213): permission denied");
      expect(row.find(".text-coral").exists()).toBe(true);
      await vi.advanceTimersByTimeAsync(1999);
      expect(row.text()).toContain("Did not kill");
      await vi.advanceTimersByTimeAsync(1);
      expect(row.text()).toContain("↩ free");
      expect((input.element as HTMLInputElement).value).toBe("3000");
    } finally {
      vi.useRealTimers();
    }
  });

  it("type 30, Enter: the row becomes the result, then the strip clears after 180 ms", async () => {
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

      await vi.advanceTimersByTimeAsync(179);
      expect(wrapper.find("[role='option']").text()).toContain("Freed :3000");
      await vi.advanceTimersByTimeAsync(1);
      expect((input.element as HTMLInputElement).value).toBe("");
      expect(wrapper.findAll("[role='option']").map((o) => o.attributes("data-port"))).toEqual([
        "5174",
        "5173",
        "8080",
        "9335",
      ]);
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
  });
});

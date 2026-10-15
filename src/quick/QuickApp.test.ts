import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_KEY } from "../api";
import { createMockApi } from "../api/mock";
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
  it("shows the pre-selection with the zombies first, the newer selected, the hint, the header and the footer", async () => {
    const { wrapper } = await mountQuick();
    const options = wrapper.findAll("[role='option']");
    // Two lost-terminal servers newest first, then the dev servers newest first; six rows at most,
    // so the 12-day-old Ollama is left out until a query asks for it.
    expect(options.map((o) => o.attributes("data-port"))).toEqual([
      "5174",
      "4000",
      "5173",
      "3000",
      "8080",
      "9335",
    ]);
    expect(options[0]?.attributes("aria-selected")).toBe("true");
    expect(options[0]?.text()).toContain("↩ free");
    // The selected row: the selection tint and the 3 px brand bar; no other row has either.
    expect(options[0]?.classes()).toContain("bg-sel");
    expect(options[0]?.classes()).toContain("shadow-[inset_3px_0_0_var(--brand)]");
    expect(options[1]?.classes()).not.toContain("bg-sel");
    expect(options[1]?.classes()).not.toContain("shadow-[inset_3px_0_0_var(--brand)]");
    expect(options[4]?.find("[data-status]").text()).toBe("Public");
    expect(wrapper.find("header").text()).toBe("PortReaper · 12 ports · ⌘⇧K");
    expect(wrapper.find("footer").text()).toBe("↑↓ choose · ↩ free · ⌥↩ force · esc close");
    expect(document.activeElement).toBe(wrapper.find("input").element);
  });

  it("marks a lost-terminal row with ⚡ and a Zombie pill; Public, Protected and plain rows get theirs", async () => {
    const { wrapper } = await mountQuick();
    const option = (port: number) => wrapper.find(`[role='option'][data-port='${port}']`);
    const status = (port: number) => option(port).find("[data-status]");
    expect(option(5174).find("[aria-label='lost terminal']").text()).toBe("⚡");
    expect(option(4000).find("[aria-label='lost terminal']").text()).toBe("⚡");
    expect(option(5173).find("[aria-label='lost terminal']").exists()).toBe(false);
    expect(status(5174).text()).toBe("Zombie");
    expect(status(5174).attributes("data-status")).toBe("zombie");
    expect(status(5174).classes()).toContain("bg-orange");
    expect(status(4000).text()).toBe("Zombie");
    // A plain running dev server has no pill; the one bound to 0.0.0.0 is Public.
    expect(status(3000).exists()).toBe(false);
    expect(status(5173).exists()).toBe(false);
    expect(status(8080).text()).toBe("Public");
    expect(status(8080).classes()).toContain("bg-red");
    expect(status(9335).exists()).toBe(false);

    await wrapper.find("input").setValue("5432");
    expect(status(5432).text()).toBe("Protected");
    expect(status(5432).attributes("data-status")).toBe("protected");
    expect(status(5432).classes()).toContain("bg-blue");
  });

  it("shows a brand mark for a known stack, a soft text pill for a named unknown one, nothing otherwise", async () => {
    const { wrapper } = await mountQuick();
    const option = (port: number) => wrapper.find(`[role='option'][data-port='${port}']`);
    const icon = (port: number) => option(port).find("[data-testid='framework-icon']");
    expect(icon(5174).attributes("data-brand")).toBe("Vite");
    expect(icon(5174).attributes("title")).toBe("Vite");
    expect(icon(3000).attributes("data-brand")).toBe("Next.js");
    expect(icon(4000).attributes("data-brand")).toBe("Jekyll");
    expect(icon(8080).attributes("data-brand")).toBe("NestJS");
    // chrome-helper: no framework, no known process, so neither a mark nor a pill.
    expect(icon(9335).exists()).toBe(false);
    expect(option(9335).find("[data-framework]").exists()).toBe(false);

    // AirPlay has a name but no brand mark: the soft pill carries the name.
    await wrapper.find("input").setValue("7000");
    expect(icon(7000).exists()).toBe(false);
    expect(option(7000).find("[data-framework]").text()).toBe("AirPlay");
    expect(option(7000).find("[data-framework]").classes()).toContain("bg-canvas");
  });

  it("an ai row's pill carries its memory", async () => {
    const { wrapper } = await mountQuick();
    await wrapper.find("input").setValue("ollama");
    const ollama = wrapper.find("[role='option'][data-port='11434']");
    expect(ollama.attributes("data-category")).toBe("ai");
    expect(ollama.text()).toContain("ollama");
    expect(ollama.find("[data-status]").text()).toBe("AI · 4.9 GB");
    expect(ollama.find("[data-status]").attributes("data-status")).toBe("ai");
    expect(ollama.find("[data-status]").classes()).toContain("bg-purple");
    expect(ollama.find("[data-testid='framework-icon']").attributes("data-brand")).toBe("Ollama");
    expect(wrapper.find("header").text()).toBe("PortReaper · 12 ports · ⌘⇧K");
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
      expect(row.classes()).toContain("bg-red-tint");
      expect(row.find(".text-red-ink").exists()).toBe(true);
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
      expect(wrapper.find("[role='option']").classes()).toContain("bg-green-tint");
      expect(wrapper.find("[role='option']").find(".text-green-ink").exists()).toBe(true);

      await vi.advanceTimersByTimeAsync(179);
      expect(wrapper.find("[role='option']").text()).toContain("Freed :3000");
      await vi.advanceTimersByTimeAsync(1);
      expect((input.element as HTMLInputElement).value).toBe("");
      // With :3000 gone the six remaining unprotected rows fit the strip, Ollama last.
      expect(wrapper.findAll("[role='option']").map((o) => o.attributes("data-port"))).toEqual([
        "5174",
        "4000",
        "5173",
        "8080",
        "9335",
        "11434",
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
    expect(wrapper.find("[role='option']").classes()).toContain("bg-orange-tint");
    expect(wrapper.find("[role='option']").classes()).not.toContain("bg-sel");
    key("Escape");
    await flushPromises();
    expect(wrapper.find("[role='option']").text()).not.toContain("Press Enter again");
    expect(wrapper.find("[role='option']").classes()).toContain("bg-sel");

    await input.setValue("99");
    expect(wrapper.find("[role='listbox']").text()).toBe("Nothing on :99");
  });
});

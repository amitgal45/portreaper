import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { createMockApi } from "../api/mock";
import { usePorts } from "../composables/usePorts";
import StatsBar from "./StatsBar.vue";

/** The tiles fed from the store over the mock, the way App.vue feeds them. */
async function mountFromMock(category: "all" | "zombie" | "public" = "all") {
  const store = usePorts(createMockApi(), { storage: null });
  await store.refresh();
  const wrapper = mount(StatsBar, {
    props: {
      total: store.total.value,
      projects: store.projectCount.value,
      devMemoryBytes: store.devMemoryBytes.value,
      zombies: store.counts.value.zombie,
      zombieMemoryBytes: store.zombieMemoryBytes.value,
      publicCount: store.counts.value.public,
      category,
    },
  });
  return { store, wrapper };
}

describe("StatsBar", () => {
  it("shows the mock's numbers", async () => {
    const { wrapper } = await mountFromMock();
    const tile = (name: string) => wrapper.get(`[data-tile='${name}']`).text().replace(/\s+/g, " ");
    expect(tile("ports")).toContain("11");
    expect(tile("ports")).toContain("ports · 7 projects");
    // web + api + ai once per pid: 1842 MB + 4.85 GB.
    expect(tile("memory")).toContain("6.6 GB");
    expect(tile("zombies")).toContain("1");
    expect(tile("zombies")).toContain("220 MB reclaimable");
    expect(tile("public")).toContain("3");
    expect(tile("public")).toContain("reachable from your network");
  });

  it("the zombie and public tiles are buttons that set the pill and read as pressed", async () => {
    const { wrapper } = await mountFromMock("zombie");
    const zombies = wrapper.get("button[data-tile='zombies']");
    const exposed = wrapper.get("button[data-tile='public']");
    expect(zombies.attributes("aria-pressed")).toBe("true");
    expect(exposed.attributes("aria-pressed")).toBe("false");
    await zombies.trigger("click");
    await exposed.trigger("click");
    expect(wrapper.emitted("filter")).toEqual([["zombie"], ["public"]]);
    // The counting tiles are not interactive.
    expect(wrapper.get("[data-tile='ports']").element.tagName).toBe("DIV");
    expect(wrapper.get("[data-tile='memory']").element.tagName).toBe("DIV");
  });

  it("goes quiet at zero", () => {
    const wrapper = mount(StatsBar, {
      props: {
        total: 1,
        projects: 1,
        devMemoryBytes: 0,
        zombies: 0,
        zombieMemoryBytes: 0,
        publicCount: 0,
        category: "all",
      },
    });
    expect(wrapper.get("[data-tile='ports']").text()).toContain("port · 1 project");
    expect(wrapper.get("[data-tile='zombies']").text()).toContain("lost terminals");
    expect(wrapper.get("[data-tile='zombies']").classes().join(" ")).not.toContain("amber");
    expect(wrapper.get("[data-tile='public']").text()).toContain("none exposed");
    expect(wrapper.get("[data-tile='public']").classes().join(" ")).not.toContain("coral");
  });
});

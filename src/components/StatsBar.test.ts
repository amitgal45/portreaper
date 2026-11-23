import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { createMockApi } from "../api/mock";
import { usePorts } from "../composables/usePorts";
import StatsBar from "./StatsBar.vue";

/** The summary line fed from the store over the mock, the way App.vue feeds it. */
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
    const card = (name: string) => wrapper.get(`[data-tile='${name}']`).text().replace(/\s+/g, " ");
    expect(card("ports")).toContain("12");
    expect(card("ports")).toContain("ports · 7 projects");
    // web + api + ai once per pid: 1842 MB + 4.85 GB.
    expect(card("memory")).toContain("6.6 GB");
    expect(card("memory")).toContain("dev servers");
    expect(card("zombies")).toContain("2");
    expect(card("zombies")).toContain("zombies · 640 MB");
    expect(card("public")).toContain("3");
    expect(card("public")).toContain("public on your Wi-Fi");
  });

  it("is one line of four items in order, a dot, a number and a label each, with no card (B v3, spec item 3)", async () => {
    const { wrapper } = await mountFromMock();
    const line = wrapper.get("[data-summary]");
    // One line that wraps: flex, not the four-column grid, and nothing that clips.
    expect(line.classes()).toEqual(expect.arrayContaining(["flex", "flex-wrap", "bg-surface"]));
    expect(line.classes().filter((c) => /(^|:)grid(-cols|$)/.test(c))).toEqual([]);
    const items = line.findAll("[data-tile]");
    expect(items.map((i) => i.attributes("data-tile"))).toEqual(["ports", "memory", "zombies", "public"]);
    for (const item of items) {
      const name = item.attributes("data-tile");
      expect(item.element.parentElement, `${name} sits on the line`).toBe(line.element);
      // No card: no background, no border, no radius beyond the pressed ring's, no fixed 36 px box.
      expect(
        item.classes().filter((c) => /^(bg-|border|rounded-lg|h-9$|overflow-hidden$|truncate$)/.test(c)),
        `${name} has card classes`,
      ).toEqual([]);
      const [dot, number, label, ...rest] = item.findAll("span");
      expect(rest, `${name} has three parts`).toEqual([]);
      expect(dot?.classes(), `${name} dot`).toEqual(expect.arrayContaining(["h-2", "w-2", "rounded-full"]));
      expect(dot?.attributes("aria-hidden")).toBe("true");
      expect(number?.classes(), `${name} number`).toEqual(
        expect.arrayContaining(["text-[13px]", "font-semibold", "tabular-nums"]),
      );
      expect(label?.classes(), `${name} label`).toEqual(
        expect.arrayContaining(["text-[12px]", "text-ink-2"]),
      );
      // The line wraps; an item never clips.
      for (const part of [item, dot, number, label]) {
        expect(part?.classes(), `${name} clips`).not.toEqual(expect.arrayContaining(["truncate"]));
      }
    }
  });

  it("the zombie and public items are buttons that set the filter; pressed reads as a ring in its ink, not a tint", async () => {
    const { wrapper } = await mountFromMock("zombie");
    const zombies = wrapper.get("button[data-tile='zombies']");
    const exposed = wrapper.get("button[data-tile='public']");
    expect(zombies.attributes("aria-pressed")).toBe("true");
    expect(exposed.attributes("aria-pressed")).toBe("false");
    expect(zombies.attributes("title")).toBe("Dev servers whose terminal is gone. Click to list them.");
    expect(exposed.attributes("title")).toBe(
      "Bound to every interface: anyone on your network can reach them. Click to list them.",
    );
    expect(zombies.classes()).toEqual(expect.arrayContaining(["inset-ring-1", "inset-ring-orange-ink"]));
    expect(exposed.classes().filter((c) => /^ring-/.test(c))).toEqual([]);
    expect(exposed.classes().filter((c) => /^inset-ring-/.test(c))).toEqual([]);
    for (const item of [zombies, exposed]) {
      expect(item.classes().filter((c) => /(^|:)bg-[a-z]+-tint$/.test(c))).toEqual([]);
    }
    // The alarm numbers keep their ink while there is something to show.
    expect(zombies.findAll("span")[1]?.classes()).toContain("text-orange-ink");
    expect(exposed.findAll("span")[1]?.classes()).toContain("text-red-ink");
    await zombies.trigger("click");
    await exposed.trigger("click");
    expect(wrapper.emitted("filter")).toEqual([["zombie"], ["public"]]);
    // The counting items are not interactive.
    expect(wrapper.get("[data-tile='ports']").element.tagName).toBe("DIV");
    expect(wrapper.get("[data-tile='memory']").element.tagName).toBe("DIV");

    const { wrapper: onPublic } = await mountFromMock("public");
    expect(onPublic.get("[data-tile='public']").classes()).toEqual(
      expect.arrayContaining(["inset-ring-1", "inset-ring-red-ink"]),
    );
    expect(onPublic.get("[data-tile='zombies']").attributes("aria-pressed")).toBe("false");
  });

  it("goes quiet at zero: the numbers in ink; a pressed filter at zero keeps a grey ring", () => {
    const props = {
      total: 1,
      projects: 1,
      devMemoryBytes: 0,
      zombieMemoryBytes: 0,
      zombies: 0,
      publicCount: 0,
      category: "all" as const,
    };
    const wrapper = mount(StatsBar, { props });
    expect(wrapper.get("[data-tile='ports']").text()).toContain("port · 1 project");
    expect(wrapper.get("[data-tile='zombies']").text()).toMatch(/^0\s*zombies$/);
    for (const name of ["zombies", "public"]) {
      const item = wrapper.get(`[data-tile='${name}']`);
      expect(item.classes().filter((c) => /(^|:)bg-[a-z]+-tint$/.test(c))).toEqual([]);
      const number = item.findAll("span")[1];
      expect(number?.classes(), name).toContain("text-ink");
      expect(number?.classes(), name).not.toEqual(expect.arrayContaining(["text-orange-ink"]));
      expect(number?.classes(), name).not.toEqual(expect.arrayContaining(["text-red-ink"]));
    }
    const pressed = mount(StatsBar, { props: { ...props, category: "zombie" } });
    const zombies = pressed.get("[data-tile='zombies']");
    expect(zombies.attributes("aria-pressed")).toBe("true");
    expect(zombies.classes()).toEqual(expect.arrayContaining(["inset-ring-1", "inset-ring-ink-2"]));
  });

  it("a pressed item that has the focus shows both rings: the pressed one is inset-ring, the focus one ring, never the same property", async () => {
    const cases = [
      { category: "zombie", tile: "zombies", zombies: 2, publicCount: 3, ink: "inset-ring-orange-ink" },
      { category: "public", tile: "public", zombies: 2, publicCount: 3, ink: "inset-ring-red-ink" },
      { category: "zombie", tile: "zombies", zombies: 0, publicCount: 0, ink: "inset-ring-ink-2" },
    ] as const;
    for (const c of cases) {
      const what = `${c.tile} at ${c.tile === "zombies" ? c.zombies : c.publicCount}`;
      const wrapper = mount(StatsBar, {
        props: {
          total: 1,
          projects: 1,
          devMemoryBytes: 0,
          zombieMemoryBytes: 0,
          zombies: c.zombies,
          publicCount: c.publicCount,
          category: c.category,
        },
        attachTo: document.body,
      });
      const item = wrapper.get(`button[data-tile='${c.tile}']`);
      (item.element as HTMLButtonElement).focus();
      expect(document.activeElement, `${what} has the focus`).toBe(item.element);
      expect(item.attributes("aria-pressed"), what).toBe("true");
      const classes = item.classes();
      expect(classes, what).toEqual(
        expect.arrayContaining([
          "inset-ring-1",
          c.ink,
          "focus-visible:ring-2",
          "focus-visible:ring-brand-ink",
        ]),
      );
      // Pressed writes --tw-inset-ring-*: only inset-ring utilities, no plain ring (--tw-ring-*).
      const pressed = classes.filter((k) => !k.includes(":") && /ring/.test(k));
      expect(pressed.length, what).toBeGreaterThan(0);
      for (const k of pressed) expect(k, `${what}: pressed class`).toMatch(/^inset-ring-/);
      // Focus writes --tw-ring-*: only ring utilities, no inset-ring and no ring-inset.
      const focus = classes.filter((k) => k.startsWith("focus-visible:") && /ring/.test(k));
      expect(focus.length, what).toBeGreaterThan(0);
      for (const k of focus) {
        expect(k, `${what}: focus class`).toMatch(/^focus-visible:ring-/);
        expect(k, `${what}: focus class`).not.toMatch(/inset/);
      }
      wrapper.unmount();
    }
  });
});

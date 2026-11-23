import { mount, type VueWrapper } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import type { Component } from "vue";
import { createMockApi, MOCK_UPDATE } from "../api/mock";
import type { CategoryFilter } from "../composables/usePorts";
import { usePorts } from "../composables/usePorts";
import { type UpdateState, useUpdate } from "../composables/useUpdate";
import {
  ClockIcon,
  DbIcon,
  EyeIcon,
  GearIcon,
  GlobeIcon,
  GridIcon,
  ReapIcon,
  SparkIcon,
  TermIcon,
  ZapIcon,
} from "./icons";
import Sidebar, { type View } from "./Sidebar.vue";

/** The sidebar over the mock, the way App.vue feeds it, with the banner in the given state. */
async function mountSidebar(
  update: UpdateState,
  state: { view?: View; category?: CategoryFilter; tasklineCount?: number } = {},
) {
  const store = usePorts(createMockApi(), { storage: null });
  await store.refresh();
  return mount(Sidebar, {
    props: {
      view: state.view ?? "studio",
      category: state.category ?? "all",
      counts: store.counts.value,
      tasklineCount: state.tasklineCount ?? 0,
      update,
    },
  });
}

const IDLE: UpdateState = { phase: "idle" };
const navKeys = (wrapper: VueWrapper) => wrapper.findAll("[data-nav]").map((b) => b.attributes("data-nav"));
/** The count at the end of an item: a plain number. */
const countOf = (wrapper: VueWrapper, key: string) => wrapper.get(`[data-nav='${key}'] > [data-count]`);
const iconOf = (wrapper: VueWrapper, key: string) => wrapper.get(`[data-nav='${key}'] > svg`);

describe("Sidebar items (B v3, spec item 2)", () => {
  it("lists the seven filters, the Taskline and Settings, and no Left behind item (decisions 2026-11-23)", async () => {
    const wrapper = await mountSidebar(IDLE, { tasklineCount: 3 });
    expect(navKeys(wrapper)).toEqual([
      "all",
      "dev",
      "ai",
      "db",
      "zombie",
      "public",
      "watching",
      "taskline",
      "settings",
    ]);
    expect(wrapper.text()).not.toMatch(/left behind/i);
  });

  it("draws each item with its own icon from src/components/icons, and no lucide icon", async () => {
    const wrapper = await mountSidebar(IDLE);
    const expected: [string, Component][] = [
      ["all", GridIcon],
      ["dev", TermIcon],
      ["ai", SparkIcon],
      ["db", DbIcon],
      ["zombie", ZapIcon],
      ["public", GlobeIcon],
      ["watching", EyeIcon],
      ["taskline", ClockIcon],
      ["settings", GearIcon],
    ];
    const all = [
      GridIcon,
      TermIcon,
      SparkIcon,
      DbIcon,
      ZapIcon,
      GlobeIcon,
      EyeIcon,
      ClockIcon,
      GearIcon,
      ReapIcon,
    ];
    for (const [key, icon] of expected) {
      const item = wrapper.get(`[data-nav='${key}']`);
      expect(item.findComponent(icon).exists(), `${key} draws its icon`).toBe(true);
      const others = all.filter((other) => other !== icon && item.findComponent(other).exists());
      expect(others, `${key} draws only its icon`).toEqual([]);
      expect(item.findAll("svg"), `${key} has one icon`).toHaveLength(1);
    }
    expect(wrapper.findAll("svg.lucide")).toHaveLength(0);
  });

  it("shows ⌘1–⌘4 on All ports, Dev servers, Local AI and Databases only, between the label and the count", async () => {
    const wrapper = await mountSidebar(IDLE, { tasklineCount: 3 });
    const hints = wrapper.findAll("[data-shortcut]");
    expect(hints.map((h) => h.text())).toEqual(["⌘1", "⌘2", "⌘3", "⌘4"]);
    for (const [i, key] of (["all", "dev", "ai", "db"] as const).entries()) {
      const item = wrapper.get(`[data-nav='${key}']`);
      // The icon, the label, the hint, the count: in that order, the count still the last span.
      const parts = [...item.element.children].map((el) => {
        if (el.tagName.toLowerCase() === "svg") return "icon";
        if (el.hasAttribute("data-shortcut")) return "hint";
        if (el.hasAttribute("data-count")) return "count";
        return "label";
      });
      expect(parts, key).toEqual(["icon", "label", "hint", "count"]);
      expect(item.get("[data-shortcut]").text()).toBe(`⌘${i + 1}`);
      // Decoration for the eye; the button carries the shortcut for assistive tech.
      expect(item.get("[data-shortcut]").attributes("aria-hidden")).toBe("true");
      expect(item.attributes("aria-keyshortcuts")).toBe(`Meta+${i + 1}`);
    }
    for (const key of ["zombie", "public", "watching", "taskline", "settings"]) {
      const item = wrapper.get(`[data-nav='${key}']`);
      expect(item.find("[data-shortcut]").exists(), `${key} has no hint`).toBe(false);
      expect(item.attributes("aria-keyshortcuts")).toBeUndefined();
    }
  });

  it("counts are plain grey numbers in the sans font: no badge fill, no pill, no mono, tabular", async () => {
    const wrapper = await mountSidebar(IDLE, { tasklineCount: 3 });
    const counted = ["all", "dev", "ai", "db", "zombie", "public", "watching", "taskline"];
    for (const key of counted) {
      const count = countOf(wrapper, key);
      expect(count.text(), `${key} count`).toMatch(/^\d+$/);
      const classes = count.classes();
      expect(
        classes.filter((c) => /^bg-|^rounded|^px-|^py-|^font-mono$/.test(c)),
        `${key} count has badge classes`,
      ).toEqual([]);
      expect(classes, `${key} count`).toContain("tabular-nums");
    }
    // The Taskline's count keeps the hook the e2e uses (`tasklineBadge`).
    expect(wrapper.get("[data-badge='taskline-count']").text()).toBe("3");
    // Off: the tertiary grey, the alarms included (their colour stays on the icon).
    for (const key of ["dev", "zombie", "public", "watching", "taskline"]) {
      expect(countOf(wrapper, key).classes(), `${key} count`).toContain("text-ink-3");
    }
  });

  it("the selected item: the neutral fill, a coral icon, ink text, and the secondary grey on its hint and count", async () => {
    const wrapper = await mountSidebar(IDLE, { category: "dev" });
    const on = wrapper.get("[data-nav='dev']");
    expect(on.attributes("aria-current")).toBe("true");
    expect(on.classes()).toEqual(expect.arrayContaining(["bg-sel-neutral", "text-ink"]));
    // One colour and one hover per state: two utilities for a property leave the winner to the CSS order.
    expect(on.classes()).not.toContain("text-ink-2");
    expect(on.classes()).not.toContain("hover:bg-sidebar-hover");
    expect(on.classes().filter((c) => /brand/.test(c) && !c.startsWith("focus-visible:"))).toEqual([]);
    expect(iconOf(wrapper, "dev").classes()).toContain("text-brand");
    expect(countOf(wrapper, "dev").classes()).toContain("text-ink-2");
    expect(on.get("[data-shortcut]").classes()).toContain("text-ink-2");

    // Off: no fill, the secondary label, a quiet icon; the alarms keep their colour on the icon.
    for (const key of ["all", "ai", "db", "zombie", "public", "watching", "taskline", "settings"]) {
      const off = wrapper.get(`[data-nav='${key}']`);
      expect(off.attributes("aria-current"), key).toBeUndefined();
      expect(off.classes(), key).not.toContain("bg-sel-neutral");
      expect(off.classes(), key).toContain("text-ink-2");
      expect(off.classes(), key).not.toContain("text-ink");
      expect(off.classes(), key).toContain("hover:bg-sidebar-hover");
    }
    expect(wrapper.get("[data-nav='all'] [data-shortcut]").classes()).toContain("text-ink-3");
    expect(iconOf(wrapper, "all").classes()).toContain("text-ink-3");
    expect(iconOf(wrapper, "zombie").classes()).toContain("text-orange");
    expect(iconOf(wrapper, "public").classes()).toContain("text-red");
    expect(countOf(wrapper, "zombie").classes()).not.toEqual(expect.arrayContaining(["text-orange-ink"]));
    expect(countOf(wrapper, "public").classes()).not.toEqual(expect.arrayContaining(["text-red-ink"]));
  });

  it("an alarm that is on takes the coral icon like any item; the Taskline and Settings select the same way", async () => {
    const zombie = await mountSidebar(IDLE, { category: "zombie" });
    expect(iconOf(zombie, "zombie").classes()).toContain("text-brand");
    expect(iconOf(zombie, "zombie").classes()).not.toContain("text-orange");
    expect(countOf(zombie, "zombie").classes()).toContain("text-ink-2");

    for (const view of ["taskline", "settings"] as const) {
      const wrapper = await mountSidebar(IDLE, { view, tasklineCount: 2 });
      const on = wrapper.get(`[data-nav='${view}']`);
      expect(on.attributes("aria-current")).toBe("true");
      expect(on.classes()).toEqual(expect.arrayContaining(["bg-sel-neutral", "text-ink"]));
      expect(on.classes()).not.toContain("text-ink-2");
      expect(iconOf(wrapper, view).classes()).toContain("text-brand");
      // No category is on outside the Studio.
      expect(wrapper.findAll("[aria-current='true']")).toHaveLength(1);
    }
    const taskline = await mountSidebar(IDLE, { view: "taskline", tasklineCount: 2 });
    expect(taskline.get("[data-badge='taskline-count']").classes()).toContain("text-ink-2");
  });

  it("section headings are in sentence case", async () => {
    const wrapper = await mountSidebar(IDLE);
    for (const text of ["Ports", "Needs attention"]) {
      const heading = wrapper.findAll("nav > div").find((d) => d.text() === text);
      expect(heading, text).toBeDefined();
      expect(heading?.classes(), text).not.toContain("uppercase");
      expect(heading?.classes(), text).toContain("text-ink-3");
    }
  });

  it("a click on a category from the Taskline picks it and goes back to the Studio", async () => {
    const wrapper = await mountSidebar(IDLE, { view: "taskline" });
    await wrapper.get("[data-nav='db']").trigger("click");
    expect(wrapper.emitted("update:category")).toEqual([["db"]]);
    expect(wrapper.emitted("update:view")).toEqual([["studio"]]);
  });
});

const banner = (wrapper: VueWrapper) => wrapper.find("[data-update]");

describe("Sidebar update banner", () => {
  it("shows nothing while no update is known", async () => {
    const wrapper = await mountSidebar({ phase: "idle" });
    expect(banner(wrapper).exists()).toBe(false);
    expect(wrapper.get("[data-nav='taskline']").text()).toContain("Taskline");
    // Needs attention: the two alarms and, since WP-18, the watched ports that are free.
    const watching = wrapper.get("[data-nav='watching']");
    expect(watching.text()).toContain("Watching");
    expect(watching.get("span:last-child").text()).toBe("0");
  });

  it("ready: names the version on the brand tint, and Update asks to install", async () => {
    // The mock seam: the state `?update=1` starts from in a browser.
    const update = useUpdate(createMockApi(), { seed: MOCK_UPDATE });
    const wrapper = await mountSidebar(update.state.value);
    const ready = banner(wrapper);
    expect(ready.attributes("data-phase")).toBe("available");
    expect(ready.text()).toContain("PortReaper 0.3.0 is ready");
    expect(ready.classes()).toEqual(expect.arrayContaining(["bg-brand-tint", "text-brand-ink"]));
    const button = ready.get("button");
    expect(button.text()).toBe("Update");
    expect(button.attributes("data-action")).toBe("update");
    expect(button.classes()).toEqual(expect.arrayContaining(["bg-brand-ink", "text-surface"]));
    await button.trigger("click");
    expect(wrapper.emitted("install")).toEqual([[]]);
  });

  it("downloading: no button, the percent follows the core's progress, then Restarting…", async () => {
    const api = createMockApi();
    let finish: () => void = () => {};
    vi.spyOn(api, "installUpdate").mockImplementation(() => new Promise<void>((r) => (finish = r)));
    const update = useUpdate(api, { seed: MOCK_UPDATE });
    const wrapper = await mountSidebar(update.state.value);

    const installing = update.install();
    await wrapper.setProps({ update: update.state.value });
    expect(banner(wrapper).attributes("data-phase")).toBe("downloading");
    expect(banner(wrapper).text()).toContain("Downloading… 0 B");
    expect(banner(wrapper).find("button").exists()).toBe(false);

    update.progress({ downloaded: 42, total: 100 });
    await wrapper.setProps({ update: update.state.value });
    expect(banner(wrapper).text()).toContain("Downloading… 42%");
    expect(banner(wrapper).get(".bg-brand.h-full").attributes("style")).toContain("width: 42%");

    finish();
    await installing;
    await wrapper.setProps({ update: update.state.value });
    expect(banner(wrapper).text()).toContain("Restarting…");
    expect(banner(wrapper).get(".bg-brand.h-full").attributes("style")).toContain("width: 100%");
  });

  it("failed: the message and Retry, which installs again", async () => {
    const api = createMockApi();
    const installUpdate = vi
      .spyOn(api, "installUpdate")
      .mockRejectedValueOnce(new Error("Couldn't reach the update server"))
      .mockResolvedValueOnce(undefined);
    const update = useUpdate(api, { seed: MOCK_UPDATE });
    const wrapper = await mountSidebar(update.state.value);

    await update.install();
    await wrapper.setProps({ update: update.state.value });
    const failed = banner(wrapper);
    expect(failed.attributes("data-phase")).toBe("error");
    expect(failed.text()).toContain("Couldn't reach the update server");
    const retry = failed.get("button");
    expect(retry.text()).toBe("Retry");
    expect(retry.attributes("data-action")).toBe("retry");
    await retry.trigger("click");
    expect(wrapper.emitted("install")).toEqual([[]]);

    await update.install();
    expect(installUpdate).toHaveBeenCalledTimes(2);
    await wrapper.setProps({ update: update.state.value });
    expect(banner(wrapper).text()).toContain("Restarting…");
  });
});

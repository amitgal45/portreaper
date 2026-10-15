import { mount } from "@vue/test-utils";
import { TooltipProvider } from "reka-ui";
import { describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { createMockApi, MOCK_ENTRIES } from "../api/mock";
import { ACTIONS_KEY, type UiActions } from "../composables/useActions";
import { useKillFlow } from "../composables/useKillFlow";
import { usePorts } from "../composables/usePorts";
import { useToasts } from "../composables/useToasts";
import type { PortEntry } from "../types";
import PortRow from "./PortRow.vue";

const byPort = (port: number): PortEntry => {
  const e = MOCK_ENTRIES.find((x) => x.port === port);
  if (!e) throw new Error(`no mock entry on ${port}`);
  return e;
};

function spies(): UiActions {
  return {
    select: vi.fn(),
    inspect: vi.fn(),
    kill: vi.fn(),
    killGroup: vi.fn(),
    restart: vi.fn(),
    reap: vi.fn(),
    toggleGroup: vi.fn(),
    openInBrowser: vi.fn(),
    copyKill: vi.fn(),
    copyCommand: vi.fn(),
    revealFolder: vi.fn(),
  };
}

function mountRow(
  entry: PortEntry,
  actions: UiActions,
  extra: Partial<InstanceType<typeof PortRow>["$props"]> = {},
) {
  const Wrapper = defineComponent({
    setup: () => () =>
      h(TooltipProvider, null, {
        default: () =>
          h(PortRow, {
            entry,
            selected: false,
            pending: false,
            reason: entry.protected ? "Docker" : null,
            collision: false,
            ...extra,
          }),
      }),
  });
  return mount(Wrapper, {
    global: { provide: { [ACTIONS_KEY as symbol]: actions } },
    attachTo: document.body,
  });
}

/** The status pills of a row, in order. */
const pillsOf = (wrapper: ReturnType<typeof mountRow>) =>
  wrapper.findAll("[data-badge]").map((b) => [b.attributes("data-badge"), b.text()]);

describe("PortRow", () => {
  it("kills an unprotected row on click, and forces on ⌥-click", async () => {
    const actions = spies();
    const wrapper = mountRow(byPort(3000), actions);
    const kill = wrapper.get("button[aria-label='Kill']");
    await kill.trigger("click");
    expect(actions.kill).toHaveBeenLastCalledWith(byPort(3000), false);
    await kill.trigger("click", { altKey: true });
    expect(actions.kill).toHaveBeenLastCalledWith(byPort(3000), true);
    expect(actions.inspect).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("opens the inspector on a plain click of the row; the row menu's trigger does not", async () => {
    const actions = spies();
    const wrapper = mountRow(byPort(3000), actions);
    await wrapper.get("[role='row']").trigger("click");
    expect(actions.inspect).toHaveBeenCalledWith(byPort(3000));
    await wrapper.get("button[aria-label='More']").trigger("click");
    expect(actions.inspect).toHaveBeenCalledTimes(1);
    expect(actions.kill).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("opens the confirm instead of killing a protected row", async () => {
    const api = createMockApi();
    const killProcess = vi.spyOn(api, "killProcess");
    const ports = usePorts(api, { storage: null });
    await ports.refresh();
    const flow = useKillFlow(ports, useToasts());
    const actions: UiActions = {
      ...spies(),
      kill: (entry, force) => void flow.request({ kind: "entry", entry, force }),
    };

    const wrapper = mountRow(byPort(5432), actions);
    await wrapper.get("button[aria-label='Kill']").trigger("click");
    expect(killProcess).not.toHaveBeenCalled();
    expect(flow.confirm.value).toMatchObject({ kind: "entry", force: false });
    expect(flow.confirm.value?.kind === "entry" && flow.confirm.value.entry.pid).toBe(11710);
    wrapper.unmount();
  });

  it("shows one pill per state, worst first, and Running when nothing applies", () => {
    const actions = spies();
    const running = mountRow(byPort(3000), actions);
    expect(pillsOf(running)).toEqual([["running", "Running"]]);
    expect(running.text()).toContain("3000");
    expect(running.text()).toContain("412 MB");
    expect(running.text()).toContain("2 h");
    running.unmount();

    const zombie = mountRow(byPort(5174), actions);
    expect(pillsOf(zombie)).toEqual([["zombie", "Zombie"]]);
    zombie.unmount();

    const exposed = mountRow(byPort(8080), actions);
    expect(pillsOf(exposed)).toEqual([["public", "Public"]]);
    exposed.unmount();

    // Docker, bound to every interface: both, the alarm first.
    const docker = mountRow(byPort(5432), actions);
    expect(pillsOf(docker)).toEqual([
      ["public", "Public"],
      ["protected", "Protected"],
    ]);
    expect(docker.get("[role='row']").attributes("data-category")).toBe("db");
    docker.unmount();

    // A system daemon on every interface is not "public" (the filter agrees): protected only.
    const mdns = mountRow(byPort(53), actions);
    expect(pillsOf(mdns)).toEqual([["protected", "Protected"]]);
    expect(mdns.text()).toContain("udp");
    mdns.unmount();

    const ai = mountRow(byPort(11434), actions);
    expect(pillsOf(ai)).toEqual([["ai", "AI · 4.9 GB"]]);
    ai.unmount();

    // An orphan that is protected shows both: its terminal is gone, and Reap will leave it alone.
    const guarded = mountRow({ ...byPort(4000), protected: true }, actions);
    expect(pillsOf(guarded)).toEqual([
      ["zombie", "Zombie"],
      ["protected", "Protected"],
    ]);
    guarded.unmount();
  });

  it("draws the brand mark for a known stack, a text pill for an unknown one, nothing otherwise", () => {
    const actions = spies();
    const next = mountRow(byPort(3000), actions);
    expect(next.get("[data-testid='framework-icon']").attributes("data-brand")).toBe("Next.js");
    expect(next.get("[data-testid='framework-icon']").attributes("title")).toBe("Next.js");
    expect(next.find("[data-badge='framework']").exists()).toBe(false);
    next.unmount();

    // The framework names the stack; the process name alone would say Docker.
    const postgres = mountRow(byPort(5432), actions);
    expect(postgres.get("[data-testid='framework-icon']").attributes("data-brand")).toBe("PostgreSQL");
    postgres.unmount();

    const airplay = mountRow({ ...byPort(7000), framework: "AirPlay" }, actions);
    expect(airplay.find("[data-testid='framework-icon']").exists()).toBe(false);
    expect(airplay.get("[data-badge='framework']").text()).toBe("AirPlay");
    airplay.unmount();

    // "mDNSResponder" on an mDNSResponder row would repeat the name: nothing.
    const mdns = mountRow(byPort(53), actions);
    expect(mdns.find("[data-testid='framework-icon']").exists()).toBe(false);
    expect(mdns.find("[data-badge='framework']").exists()).toBe(false);
    expect(mdns.text().match(/mDNSResponder/g)).toHaveLength(1);
    mdns.unmount();

    const helper = mountRow(byPort(9335), actions);
    expect(helper.find("[data-testid='framework-icon']").exists()).toBe(false);
    expect(helper.find("[data-badge='framework']").exists()).toBe(false);
    helper.unmount();
  });

  it("keeps the command line out of the row: it lives in the inspector", () => {
    const wrapper = mountRow(byPort(3000), spies());
    expect(wrapper.text()).not.toContain("next dev");
    expect(wrapper.text()).not.toContain("feature/cart");
    wrapper.unmount();
  });

  it("turns the port orange after a collision", () => {
    const quiet = mountRow(byPort(3000), spies());
    expect(quiet.get("[role='row'] > span").classes()).toContain("text-ink");
    quiet.unmount();
    const hot = mountRow(byPort(3000), spies(), { collision: true });
    expect(hot.get("[role='row'] > span").classes()).toContain("text-orange-ink");
    hot.unmount();
  });

  it("fills the Kill button on the selected row", () => {
    const plain = mountRow(byPort(3000), spies());
    expect(plain.get("button[aria-label='Kill']").classes()).toContain("text-red-ink");
    plain.unmount();
    const selected = mountRow(byPort(3000), spies(), { selected: true });
    expect(selected.get("button[aria-label='Kill']").classes()).toEqual(
      expect.arrayContaining(["bg-red-ink", "text-surface"]),
    );
    expect(selected.get("[role='row']").attributes("aria-selected")).toBe("true");
    expect(selected.get("[role='row']").classes()).toContain("bg-sel");
    selected.unmount();
  });

  it("shows a spinner and no buttons while pending", () => {
    const wrapper = mountRow(byPort(3000), spies(), { pending: true });
    expect(wrapper.find("button[aria-label='Kill']").exists()).toBe(false);
    expect(wrapper.find("button[aria-label='More']").exists()).toBe(false);
    expect(wrapper.find("[aria-label='killing']").exists()).toBe(true);
    wrapper.unmount();
  });
});

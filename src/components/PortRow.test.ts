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
    kill: vi.fn(),
    killGroup: vi.fn(),
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
            showBranch: true,
            showTool: true,
            reason: entry.protected ? "Docker" : null,
            ...extra,
          }),
      }),
  });
  return mount(Wrapper, {
    global: { provide: { [ACTIONS_KEY as symbol]: actions } },
    attachTo: document.body,
  });
}

describe("PortRow", () => {
  it("kills an unprotected row on click, and forces on ⌥-click", async () => {
    const actions = spies();
    const wrapper = mountRow(byPort(3000), actions);
    const kill = wrapper.get("button[aria-label='Kill']");
    await kill.trigger("click");
    expect(actions.kill).toHaveBeenLastCalledWith(byPort(3000), false);
    await kill.trigger("click", { altKey: true });
    expect(actions.kill).toHaveBeenLastCalledWith(byPort(3000), true);
    expect(actions.select).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("selects on a plain click of the row", async () => {
    const actions = spies();
    const wrapper = mountRow(byPort(3000), actions);
    await wrapper.get("[role='row']").trigger("click");
    expect(actions.select).toHaveBeenCalledWith(byPort(3000));
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

  it("renders the badges from the data", () => {
    const actions = spies();
    const orphan = mountRow(byPort(5174), actions);
    expect(orphan.text()).toContain("lost its terminal");
    expect(orphan.text()).toContain("local");
    expect(orphan.text()).toContain("amit/TR-120-hero");
    expect(orphan.text()).toContain("vite");
    orphan.unmount();

    const exposed = mountRow(byPort(8080), actions);
    expect(exposed.text()).toContain("exposed");
    expect(exposed.text()).not.toContain("lost its terminal");
    expect(exposed.text()).toContain("610 MB");
    expect(exposed.text()).toContain("5 h");
    exposed.unmount();

    const udp = mountRow(byPort(53), actions);
    expect(udp.text()).toContain("udp");
    udp.unmount();
  });

  it("does not repeat the name as the command; shows where the executable lives instead", () => {
    const actions = spies();
    // The command is only the executable's path: the basename would repeat the name.
    const docker = mountRow(byPort(5432), actions);
    expect(docker.text().match(/com\.docker\.backend/g)).toHaveLength(1);
    expect(docker.find("[data-cell='command']").exists()).toBe(false);
    const where = docker.get("[data-cell='location']");
    expect(where.text()).toBe("/Applications/Docker.app/Contents/MacOS");
    expect(where.attributes("title")).toBe("/Applications/Docker.app/Contents/MacOS/com.docker.backend");
    docker.unmount();

    // The exe the core reports wins over the command line.
    const mdns = mountRow(
      { ...byPort(53), exe: "/usr/sbin/mDNSResponder", command: "mDNSResponder" },
      actions,
    );
    expect(mdns.get("[data-cell='location']").text()).toBe("/usr/sbin");
    expect(mdns.get("[data-cell='location']").attributes("title")).toBe("/usr/sbin/mDNSResponder");
    mdns.unmount();

    // Nothing known beyond the name: nothing shown, nothing repeated.
    const bare = mountRow({ ...byPort(53), exe: null, command: "" }, actions);
    expect(bare.text().match(/mDNSResponder/g)).toHaveLength(1);
    expect(bare.find("[data-cell='location']").exists()).toBe(false);
    expect(bare.find("[data-cell='command']").exists()).toBe(false);
    bare.unmount();

    // A real command line still shows, with the full line as its tooltip.
    const next = mountRow(byPort(3000), actions);
    const command = next.get("[data-cell='command']");
    expect(command.text()).toBe("node next dev");
    expect(command.attributes("title")).toBe("node /Users/amit/work/shop-api/node_modules/.bin/next dev");
    expect(next.find("[data-cell='location']").exists()).toBe(false);
    next.unmount();
  });

  it("hides the branch and tool when the group header shows them", () => {
    const wrapper = mountRow(byPort(3000), spies(), { showBranch: false, showTool: false });
    expect(wrapper.find("[data-badge='branch']").exists()).toBe(false);
    expect(wrapper.find("[data-badge='tool']").exists()).toBe(false);
    const shown = mountRow(byPort(3000), spies());
    expect(shown.get("[data-badge='branch']").text()).toBe("feature/cart");
    expect(shown.get("[data-badge='tool']").text()).toBe("next");
    shown.unmount();
    wrapper.unmount();
  });

  it("shows a spinner and no buttons while pending", () => {
    const wrapper = mountRow(byPort(3000), spies(), { pending: true });
    expect(wrapper.find("button[aria-label='Kill']").exists()).toBe(false);
    expect(wrapper.find("[aria-label='killing']").exists()).toBe(true);
    wrapper.unmount();
  });
});

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
            showBranch: true,
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

  it("opens the drawer on a plain click of the row, and on the eye", async () => {
    const actions = spies();
    const wrapper = mountRow(byPort(3000), actions);
    await wrapper.get("[role='row']").trigger("click");
    expect(actions.inspect).toHaveBeenCalledWith(byPort(3000));
    await wrapper.get("button[aria-label='Inspect']").trigger("click");
    expect(actions.inspect).toHaveBeenCalledTimes(2);
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

  it("renders the badges from the data: scope, zombie, framework, branch", () => {
    const actions = spies();
    const orphan = mountRow(byPort(5174), actions);
    expect(orphan.get("[data-badge='zombie']").text()).toBe("zombie");
    expect(orphan.text()).toContain("local");
    expect(orphan.get("[data-badge='branch']").text()).toBe("amit/TR-120-hero");
    expect(orphan.get("[data-badge='framework']").text()).toBe("Vite");
    expect(orphan.text()).toContain(":5174");
    orphan.unmount();

    const exposed = mountRow(byPort(8080), actions);
    expect(exposed.text()).toContain("public");
    expect(exposed.find("[data-badge='zombie']").exists()).toBe(false);
    expect(exposed.text()).toContain("610 MB");
    expect(exposed.text()).toContain("5 h");
    expect(exposed.get("[data-badge='framework']").text()).toBe("NestJS");
    exposed.unmount();

    const udp = mountRow(byPort(53), actions);
    expect(udp.text()).toContain("udp");
    udp.unmount();
  });

  it("renders the badges per category: protected azure, AI with its memory", () => {
    const actions = spies();
    const db = mountRow(byPort(5432), actions);
    expect(db.get("[data-badge='protected']").text()).toBe("protected");
    expect(db.get("[role='row']").attributes("data-category")).toBe("db");
    expect(db.find("[data-badge='ai']").exists()).toBe(false);
    db.unmount();

    const ai = mountRow(byPort(11434), actions);
    expect(ai.get("[data-badge='ai']").text()).toBe("AI · 4.9 GB");
    // "Ollama" on an "ollama" row would repeat the name: no framework chip.
    expect(ai.find("[data-badge='framework']").exists()).toBe(false);
    expect(ai.find("[data-badge='zombie']").exists()).toBe(false);
    ai.unmount();

    // An orphan that is protected shows both: its terminal is gone, and Reap will leave it alone.
    const guarded = mountRow(byPort(4000), actions);
    expect(guarded.find("[data-badge='zombie']").exists()).toBe(true);
    expect(guarded.find("[data-badge='protected']").exists()).toBe(true);
    guarded.unmount();
  });

  it("turns the port amber after a collision", () => {
    const quiet = mountRow(byPort(3000), spies());
    expect(quiet.get("[role='row'] > span").classes()).toContain("text-ink");
    quiet.unmount();
    const hot = mountRow(byPort(3000), spies(), { collision: true });
    expect(hot.get("[role='row'] > span").classes()).toContain("text-amber-neon");
    hot.unmount();
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
    // The framework chip would repeat it too: the mock classifies :53 as "mDNSResponder".
    const bare = mountRow({ ...byPort(53), exe: null, command: "" }, actions);
    expect(bare.text().match(/mDNSResponder/g)).toHaveLength(1);
    expect(bare.find("[data-badge='framework']").exists()).toBe(false);
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

  it("hides the branch when the group header shows it; the framework chip stays", () => {
    const wrapper = mountRow(byPort(3000), spies(), { showBranch: false });
    expect(wrapper.find("[data-badge='branch']").exists()).toBe(false);
    expect(wrapper.get("[data-badge='framework']").text()).toBe("Next.js");
    const shown = mountRow(byPort(3000), spies());
    expect(shown.get("[data-badge='branch']").text()).toBe("feature/cart");
    shown.unmount();
    wrapper.unmount();
  });

  it("shows a spinner and no buttons while pending", () => {
    const wrapper = mountRow(byPort(3000), spies(), { pending: true });
    expect(wrapper.find("button[aria-label='Kill']").exists()).toBe(false);
    expect(wrapper.find("button[aria-label='Inspect']").exists()).toBe(false);
    expect(wrapper.find("[aria-label='killing']").exists()).toBe(true);
    wrapper.unmount();
  });
});

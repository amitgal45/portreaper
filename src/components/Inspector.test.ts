import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_KEY } from "../api";
import { createMockApi, MOCK_ENTRIES } from "../api/mock";
import { ACTIONS_KEY, type UiActions } from "../composables/useActions";
import type { RestartState } from "../composables/useKillFlow";
import type { PortApi, PortEntry } from "../types";
import Inspector from "./Inspector.vue";

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

let mounted: VueWrapper | null = null;

async function mountInspector(
  entry: PortEntry,
  {
    api = createMockApi(),
    actions = spies(),
    restart = null as RestartState | null,
    reason = null as string | null,
  } = {},
) {
  const wrapper = mount(Inspector, {
    props: { entry, reason, restart },
    global: { provide: { [API_KEY as symbol]: api, [ACTIONS_KEY as symbol]: actions } },
    attachTo: document.body,
  });
  mounted = wrapper;
  await flushPromises();
  return { wrapper, api, actions };
}

const text = () => mounted?.text().replace(/\s+/g, " ") ?? "";
const button = (name: RegExp) => mounted?.findAll("button").find((b) => name.test(b.text())) ?? null;

describe("Inspector", () => {
  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
  });

  it("renders the header, network, resources, project, the tree and the command", async () => {
    await mountInspector(byPort(3000));
    const t = text();
    expect(t).toContain(":3000");
    expect(t).toContain("node");
    expect(t).toContain("Next.js");
    expect(mounted?.get("[data-testid='framework-icon']").attributes("data-brand")).toBe("Next.js");
    expect(t).toContain("PID 48213 · up 2 h");
    expect(t).toContain("127.0.0.1");
    expect(t).toContain("isolated to this machine");
    expect(t).toContain("412 MB");
    expect(t).toContain("running 2 h");
    expect(t).toContain("shop-api");
    expect(t).toContain("feature/cart");
    expect(t).toContain("cwd /Users/amit/work/shop-api");
    expect(t).toContain("PID 1 (launchd)");
    expect(t).toContain("└─ PID 948 (iTerm2)");
    expect(t).toContain("└─ PID 900 (zsh)");
    expect(t).toContain("└─ PID 48213 (node) [LISTENING ON :3000]");
    expect(t).toContain("node /Users/amit/work/shop-api/node_modules/.bin/next dev");
    const items = mounted?.findAll("[data-section='tree'] li") ?? [];
    expect(items[items.length - 1]?.classes()).toContain("text-brand-ink");
    expect(mounted?.get("[data-inspector]").element.tagName).toBe("ASIDE");
  });

  it("says when the core does not know the ancestry, the project or the command", async () => {
    const api: PortApi = { ...createMockApi(), processTree: async () => [] };
    await mountInspector({ ...byPort(9335), command: "" }, { api });
    const t = text();
    expect(t).toContain("Ancestry unknown");
    expect(t).toContain("No project detected");
    expect(t).toContain("cwd unknown");
    expect(mounted?.get("[data-section='command'] p").text()).toBe("unknown");
    expect(button(/^Copy$/)?.attributes("disabled")).toBeDefined();
    expect(button(/Reveal folder/)?.attributes("disabled")).toBeDefined();
  });

  it("marks a public bind and a protected process, and blocks Restart there", async () => {
    await mountInspector(byPort(5432), { reason: "Docker" });
    const t = text();
    expect(t).toContain("*");
    expect(t).toContain("reachable from your network");
    expect(t).toContain("com.docker.backend");
    expect(t).toContain("PostgreSQL 16");
    const restart = button(/Restart/);
    expect(restart?.attributes("disabled")).toBeDefined();
    expect(restart?.attributes("title")).toContain("Docker");
  });

  it("asks for the actions through the injected verbs", async () => {
    const { actions } = await mountInspector(byPort(3000));
    await button(/Restart/)?.trigger("click");
    expect(actions.restart).toHaveBeenCalledWith(byPort(3000));
    await button(/^\s*Kill/)?.trigger("click");
    expect(actions.kill).toHaveBeenCalledWith(byPort(3000), false);
    await button(/Open localhost:3000/)?.trigger("click");
    expect(actions.openInBrowser).toHaveBeenCalledWith(byPort(3000));
    await button(/Copy kill -9 48213/)?.trigger("click");
    expect(actions.copyKill).toHaveBeenCalledWith(byPort(3000));
    await button(/^Copy$/)?.trigger("click");
    expect(actions.copyCommand).toHaveBeenCalledWith(byPort(3000));
    await button(/Reveal folder/)?.trigger("click");
    expect(actions.revealFolder).toHaveBeenCalledWith(byPort(3000));
  });

  it("asks to close on the ✕", async () => {
    const { wrapper } = await mountInspector(byPort(3000));
    await wrapper.get("button[aria-label='Close']").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("tells the Restart's story: busy, the new pid, or the failure", async () => {
    const { wrapper } = await mountInspector(byPort(3000), { restart: { phase: "killing", pid: 48213 } });
    const status = () => wrapper.find("[data-restart-status]");
    expect(status().text()).toBe("Stopping node (48213)…");
    expect(button(/Restart/)?.attributes("disabled")).toBeDefined();

    await wrapper.setProps({ restart: { phase: "started", pid: 48213, newPid: 60000 } });
    expect(status().text()).toBe("Back on :3000 as pid 60000.");
    expect(button(/Restart/)?.attributes("disabled")).toBeUndefined();

    await wrapper.setProps({ restart: { phase: "failed", pid: 48213, error: "ENOENT" } });
    expect(status().text()).toBe("Restart failed: ENOENT");

    await wrapper.setProps({ restart: null });
    expect(status().exists()).toBe(false);
  });

  it("reloads the tree when the row changes pid", async () => {
    const api = createMockApi();
    const processTree = vi.spyOn(api, "processTree");
    const { wrapper } = await mountInspector(byPort(3000), { api });
    expect(processTree).toHaveBeenCalledWith(48213);
    await wrapper.setProps({ entry: byPort(5173) });
    await flushPromises();
    expect(processTree).toHaveBeenCalledWith(51022);
    expect(text()).toContain("[LISTENING ON :5173]");
  });
});

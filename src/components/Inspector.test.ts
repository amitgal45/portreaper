import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_KEY } from "../api";
import { createMockApi, MOCK_ENTRIES } from "../api/mock";
import { ACTIONS_KEY, type UiActions } from "../composables/useActions";
import type { RestartState } from "../composables/useKillFlow";
import { WATCHED_KEY } from "../composables/useWatch";
import type { LaunchdJob, PortApi, PortEntry } from "../types";
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
    copyStopCommand: vi.fn(),
    revealFolder: vi.fn(),
    watch: vi.fn(),
    hide: vi.fn(),
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
    watched = false,
  } = {},
) {
  const wrapper = mount(Inspector, {
    props: { entry, reason, restart },
    global: {
      provide: {
        [API_KEY as symbol]: api,
        [ACTIONS_KEY as symbol]: actions,
        [WATCHED_KEY as symbol]: () => watched,
      },
    },
    attachTo: document.body,
  });
  mounted = wrapper;
  await flushPromises();
  return { wrapper, api, actions };
}

const CONTROL_CENTER_EXE = "/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter";

/** ControlCenter on :5000 (AirPlay Receiver) as the core sends it: Apple's job, a system one. */
const controlCenter: PortEntry = {
  ...byPort(7000),
  port: 5000,
  pid: 635,
  processName: "ControlCenter",
  command: CONTROL_CENTER_EXE,
  exe: CONTROL_CENTER_EXE,
  parentPid: 1,
  protected: true,
  launchd: { label: "com.apple.controlcenter", restarts: null, brew: null, stopCommand: null, system: true },
};

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

  it("shows the launchd job: its label, what a kill does, and copies the command that stops it", async () => {
    const ollama = byPort(11434);
    const { wrapper, actions } = await mountInspector(ollama);
    const card = wrapper.get("[data-section='launchd']");
    expect(card.text()).toContain("launchd");
    expect(card.text()).toContain("homebrew.mxcl.ollama");
    expect(card.text()).toContain("a kill is undone within seconds");
    const copy = button(/^Copy brew services stop ollama$/);
    expect(copy).not.toBeNull();
    await copy?.trigger("click");
    expect(actions.copyStopCommand).toHaveBeenCalledWith(ollama);
    expect(actions.copyCommand).not.toHaveBeenCalled();
    expect(actions.copyKill).not.toHaveBeenCalled();
    wrapper.unmount();

    // A job that stays down, with no command the core would put in a shell: the text, no button.
    const agent = {
      ...ollama,
      launchd: { label: "com.example.agent", restarts: false, brew: null, stopCommand: null, system: false },
    };
    const { wrapper: stays } = await mountInspector(agent);
    expect(stays.get("[data-section='launchd']").text()).toContain("com.example.agent");
    expect(stays.get("[data-section='launchd']").text()).toContain("a kill lasts until the next login");
    expect(stays.get("[data-section='launchd']").find("button").exists()).toBe(false);
    stays.unmount();

    const vagueJob = { ...agent.launchd, restarts: null };
    const { wrapper: vague } = await mountInspector({ ...agent, launchd: vagueJob });
    expect(vague.get("[data-section='launchd']").text()).toContain("launchd may start it again");
    vague.unmount();

    // Every other process, and an entry from a core that did not send `launchd` yet: no card.
    const { wrapper: plain } = await mountInspector(byPort(3000));
    expect(plain.find("[data-section='launchd']").exists()).toBe(false);
    plain.unmount();
    const older = { ...byPort(3000), launchd: undefined } as unknown as PortEntry;
    const { wrapper: cached } = await mountInspector(older);
    expect(cached.find("[data-section='launchd']").exists()).toBe(false);
  });

  it("ControlCenter on :5000, Apple's job, a system process: the launchd card shows its label and has nothing to copy", async () => {
    const api = createMockApi(MOCK_ENTRIES.map((e) => (e.port === 7000 ? controlCenter : e)));
    const { wrapper } = await mountInspector(controlCenter, { api, reason: "a system process" });
    const card = wrapper.get("[data-section='launchd']");
    expect(card.text()).toContain("com.apple.controlcenter");
    expect(card.find("button").exists()).toBe(false);
    // No button mentions launchctl; the only copy verbs left are the process's own: its command line and kill -9.
    expect(button(/launchctl/)).toBeNull();
    const copies = wrapper.findAll("button").filter((b) => b.text().includes("Copy"));
    expect(copies.map((b) => b.text().trim())).toEqual(["Copy", "Copy kill -9 635"]);
    // Restart is blocked with the same reason the dialog gives.
    expect(button(/Restart/)?.attributes("title")).toContain("ControlCenter is a system process");
    wrapper.unmount();

    // Whatever launchd does to it: still nothing that would stop it for good.
    const apple = controlCenter.launchd as LaunchdJob;
    const { wrapper: restarting } = await mountInspector({
      ...controlCenter,
      launchd: { ...apple, restarts: true },
    });
    expect(restarting.get("[data-section='launchd']").text()).toContain("com.apple.controlcenter");
    expect(button(/launchctl/)).toBeNull();
  });

  it("asks to close on the ✕", async () => {
    const { wrapper } = await mountInspector(byPort(3000));
    await wrapper.get("button[aria-label='Close']").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("the eye toggles the watch, and a watched port says so under Network (WP-18)", async () => {
    const { wrapper, actions } = await mountInspector(byPort(3000));
    const eye = wrapper.get("button[aria-label='Watch']");
    expect(eye.attributes("aria-pressed")).toBe("false");
    expect(eye.attributes("data-action")).toBe("watch");
    expect(wrapper.find("[data-watching]").exists()).toBe(false);
    await eye.trigger("click");
    expect(actions.watch).toHaveBeenCalledWith(byPort(3000));
    wrapper.unmount();

    const { wrapper: on } = await mountInspector(byPort(3000), { watched: true });
    expect(on.get("button[aria-label='Watch']").attributes("aria-pressed")).toBe("true");
    expect(on.get("button[aria-label='Watch']").classes()).toContain("text-blue-ink");
    expect(on.get("[data-section='bind'] [data-watching]").text()).toBe("Watching · will notify when free");
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

  it("renders a portless (port: 0 / stdio) orphan with stdio badge, disables Watch and Open in browser", async () => {
    const mcp: PortEntry = {
      ...byPort(5174),
      port: 0,
      pid: 61204,
      address: "stdio",
      processName: "mcp-server-filesystem",
      category: "ai",
      framework: "MCP",
    };
    const { wrapper } = await mountInspector(mcp, { api: createMockApi([...MOCK_ENTRIES, mcp]) });
    const t = text();
    expect(t).toContain("stdio");
    expect(t).not.toContain(":0");
    expect(t).toContain("no listening socket (stdio or background worker)");
    expect(t).toContain("[STDIO / NO PORT]");
    expect(wrapper.get("button[aria-label='Watch']").attributes("disabled")).toBeDefined();
    expect(button(/Open in browser/)?.attributes("disabled")).toBeDefined();
  });
});

import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App.vue";
import { API_KEY } from "./api";
import { createMockApi, MOCK_ENTRIES } from "./api/mock";

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
}

const N = MOCK_ENTRIES.length;

let mounted: VueWrapper | null = null;

/** happy-dom's window is 1024 px wide: the inspector is the third column here. */
async function mountApp(api = createMockApi()) {
  const killProcess = vi.spyOn(api, "killProcess");
  const wrapper = mount(App, { global: { provide: { [API_KEY as symbol]: api } }, attachTo: document.body });
  mounted = wrapper;
  await flushPromises();
  return { api, killProcess, wrapper };
}

const rowsOf = (wrapper: VueWrapper) => wrapper.findAll("[role='row']");
const portsOf = (wrapper: VueWrapper) => rowsOf(wrapper).map((r) => Number(r.attributes("data-port")));
const inspector = () => document.body.querySelector<HTMLElement>("[data-inspector]");
const inspectorButton = (name: RegExp) =>
  [...(inspector()?.querySelectorAll("button") ?? [])].find((b) => name.test(b.textContent ?? "")) ?? null;
const dialog = () => document.body.querySelector("[role='alertdialog']");
const nav = (wrapper: VueWrapper, key: string) => wrapper.get(`[data-nav='${key}']`);

describe("App", () => {
  // Unmount here, not in the test: a failed assertion must not leave a zombie App listening.
  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
  });

  it("lists the machine grouped by project, with the counts in the sidebar, the cards and the status line", async () => {
    const { wrapper } = await mountApp();
    expect(rowsOf(wrapper)).toHaveLength(N);
    expect(wrapper.text()).toContain("shop-api");
    expect(nav(wrapper, "all").text()).toContain(`${N}`);
    expect(nav(wrapper, "all").attributes("aria-current")).toBe("true");
    expect(nav(wrapper, "dev").text()).toContain("5");
    expect(nav(wrapper, "zombie").text()).toContain("2");
    expect(nav(wrapper, "public").text()).toContain("3");
    expect(wrapper.get("footer").text()).toContain(`${N} ports · 7 projects`);
    expect(wrapper.get("footer").text()).toMatch(/scan \d+ ms/);
    expect(wrapper.text()).toContain("v0.2.0-mock");
    expect(wrapper.get("[data-tile='zombies']").text()).toContain("zombies · 640 MB");
    expect(wrapper.get("[data-tile='public']").text()).toContain("3");
    // Nothing selected: no inspector column.
    expect(inspector()).toBeNull();
  });

  it("type 3000, Enter: kills shop-api's next dev and frees the port", async () => {
    const { wrapper, killProcess } = await mountApp();
    const input = wrapper.get("input[aria-label='Search ports']");
    await input.setValue("3000");
    expect(rowsOf(wrapper)).toHaveLength(1);
    expect(wrapper.get("[role='row']").attributes("aria-selected")).toBe("true");
    press("Enter", {}, input.element);
    await flushPromises();
    expect(killProcess).toHaveBeenCalledWith({ pid: 48213, force: false });
    expect(rowsOf(wrapper)).toHaveLength(0);
    expect(wrapper.text()).toContain("Killed node (48213). Port 3000 is free.");
    // The Taskline item counts it.
    expect(wrapper.get("[data-badge='taskline-count']").text()).toBe("1");
  });

  it("asks before killing a protected row and kills on Kill anyway", async () => {
    const { wrapper, killProcess } = await mountApp();
    const docker = wrapper.get("[role='row'][data-port='5432']");
    await docker.get("button[aria-label='Kill']").trigger("click");
    await flushPromises();
    expect(killProcess).not.toHaveBeenCalled();
    expect(dialog()?.textContent).toContain("Kill com.docker.backend (11710)?");
    expect(dialog()?.textContent).toContain("is Docker");
    expect(dialog()?.textContent).toContain("ports 5432 and 6379");

    // Enter while the dialog is open must not reach the list.
    press("Enter");
    expect(killProcess).not.toHaveBeenCalled();

    const action = [...(dialog()?.querySelectorAll("button") ?? [])].find((b) =>
      b.textContent?.includes("Kill anyway"),
    );
    action?.click();
    await flushPromises();
    expect(killProcess).toHaveBeenCalledWith({ pid: 11710, force: false });
    expect(wrapper.find("[role='row'][data-port='6379']").exists()).toBe(false);
    expect(wrapper.text()).toContain("Ports 5432 and 6379 are free.");
  });

  it("Esc clears the search, then the filter, then the selection; a digit from the list starts a search", async () => {
    const { wrapper } = await mountApp();
    const input = wrapper.get("input[aria-label='Search ports']");
    await input.setValue("51");
    expect(wrapper.get("footer").text()).toContain(`2 of ${N} ports`);
    press("Escape", {}, input.element);
    await flushPromises();
    expect((input.element as HTMLInputElement).value).toBe("");
    expect(rowsOf(wrapper)).toHaveLength(N);

    await nav(wrapper, "db").trigger("click");
    expect(portsOf(wrapper)).toEqual([5432, 6379]);
    expect(nav(wrapper, "db").attributes("aria-current")).toBe("true");
    press("Escape");
    await flushPromises();
    expect(rowsOf(wrapper)).toHaveLength(N);
    expect(nav(wrapper, "all").attributes("aria-current")).toBe("true");

    press("ArrowDown");
    await flushPromises();
    expect(wrapper.findAll("[role='row'][aria-selected='true']")).toHaveLength(1);
    // The column follows the selection.
    expect(inspector()?.textContent).toContain("[LISTENING ON :3000]");
    press("Escape");
    await flushPromises();
    expect(wrapper.findAll("[role='row'][aria-selected='true']")).toHaveLength(0);
    expect(inspector()).toBeNull();

    press("8");
    await flushPromises();
    expect((input.element as HTMLInputElement).value).toBe("8");
    expect(portsOf(wrapper)).toEqual([8080]);
  });

  it("the sidebar and the cards filter the list; the same card again shows everything", async () => {
    const { wrapper } = await mountApp();
    await nav(wrapper, "zombie").trigger("click");
    expect(portsOf(wrapper)).toEqual([4000, 5174]);
    expect(nav(wrapper, "zombie").attributes("aria-current")).toBe("true");
    await nav(wrapper, "ai").trigger("click");
    expect(portsOf(wrapper)).toEqual([11434]);
    await wrapper.get("[data-tile='public']").trigger("click");
    expect(portsOf(wrapper)).toEqual([8080, 5432, 6379]);
    expect(wrapper.get("[data-tile='public']").attributes("aria-pressed")).toBe("true");
    expect(nav(wrapper, "public").attributes("aria-current")).toBe("true");
    expect(wrapper.get("footer").text()).toContain(`3 of ${N} ports`);
    await wrapper.get("[data-tile='public']").trigger("click");
    expect(rowsOf(wrapper)).toHaveLength(N);
  });

  it("Reap takes the zombies, toasts the sum, and the Taskline shows ZOMBIE REAPED with Relaunch", async () => {
    const { wrapper, api } = await mountApp();
    const reapZombies = vi.spyOn(api, "reapZombies");
    await wrapper.get("[data-action='reap']").trigger("click");
    await flushPromises();
    expect(reapZombies).toHaveBeenCalledTimes(1);
    expect(rowsOf(wrapper)).toHaveLength(N - 2);
    expect(wrapper.text()).toContain("Reaped 2 zombies, 640 MB back.");
    expect(wrapper.get("[data-action='reap']").attributes("disabled")).toBeDefined();

    await nav(wrapper, "taskline").trigger("click");
    expect(nav(wrapper, "taskline").attributes("aria-current")).toBe("true");
    expect(nav(wrapper, "all").attributes("aria-current")).toBeUndefined();
    const feed = wrapper.get("[role='feed']");
    expect(feed.findAll("article")).toHaveLength(2);
    expect(feed.text()).toContain("ZOMBIE REAPED");
    expect(feed.text()).toContain("Reaped node (39871), a lost-terminal server on port 5174.");
    expect(feed.text()).toContain("Reaped ruby (18402), a lost-terminal server on port 4000.");
    expect(feed.text()).toMatch(/RAM: 220 MB · 180 ms · tinyrecipe-lp/);
    expect(feed.text()).toMatch(/RAM: 420 MB · 180 ms · legacy-docs/);
    expect(wrapper.text()).toContain("2 events this session");

    // Relaunch brings tinyrecipe-lp back: the feed records it, the badge counts three, the list has it again.
    const reaped = feed
      .findAll("[data-event][data-kind='zombieReaped']")
      .find((a) => a.text().includes("5174"));
    if (!reaped) throw new Error("no ZOMBIE REAPED event for :5174");
    await reaped.get("button").trigger("click");
    await flushPromises();
    expect(feed.findAll("article")).toHaveLength(3);
    expect(feed.text()).toContain("RELAUNCHED");
    expect(wrapper.get("[data-badge='taskline-count']").text()).toBe("3");
    // A category from the Taskline goes back to the Studio.
    await nav(wrapper, "all").trigger("click");
    expect(rowsOf(wrapper)).toHaveLength(N - 1);
    expect(wrapper.find("[role='row'][data-port='5174']").exists()).toBe(true);
    expect(wrapper.find("[role='row'][data-port='4000']").exists()).toBe(false);

    // Clear, in the toolbar, empties the feed.
    await nav(wrapper, "taskline").trigger("click");
    const clear = wrapper.findAll("button").find((b) => b.text() === "Clear");
    await clear?.trigger("click");
    await flushPromises();
    expect(wrapper.get("[role='feed']").text()).toContain("Nothing yet.");
    expect(wrapper.find("[data-badge='taskline-count']").exists()).toBe(false);
  });

  it("a row click fills the inspector column; the keys stay on; ✕ clears it; Restart brings the row back with a new pid", async () => {
    const { wrapper, killProcess } = await mountApp();
    await wrapper.get("[role='row'][data-port='3000']").trigger("click");
    await flushPromises();
    expect(inspector()?.textContent).toContain("Next.js");
    expect(inspector()?.textContent).toContain("[LISTENING ON :3000]");
    expect(wrapper.get("[role='row'][data-port='3000']").attributes("aria-selected")).toBe("true");

    // ↓ moves the selection and the column with it.
    press("ArrowDown");
    await flushPromises();
    expect(inspector()?.textContent).toContain("[LISTENING ON :4000]");

    inspector()?.querySelector<HTMLButtonElement>("button[aria-label='Close']")?.click();
    await flushPromises();
    expect(inspector()).toBeNull();
    expect(wrapper.findAll("[role='row'][aria-selected='true']")).toHaveLength(0);

    await wrapper.get("[role='row'][data-port='3000']").trigger("click");
    await flushPromises();
    inspectorButton(/Restart/)?.click();
    await flushPromises();
    expect(killProcess).toHaveBeenCalledWith({ pid: 48213, force: false });
    const back = wrapper.get("[role='row'][data-port='3000']");
    expect(back.attributes("data-pid")).not.toBe("48213");
    expect(back.attributes("aria-selected")).toBe("true");
    expect(inspector()?.textContent).toContain(`Back on :3000 as pid ${back.attributes("data-pid")}.`);
    expect(inspector()?.textContent).toContain(`PID ${back.attributes("data-pid")}`);
    expect(wrapper.text()).toContain(
      `Relaunched node on port 3000 (new pid ${back.attributes("data-pid")}).`,
    );
  });

  it("Kill from the inspector goes through the gate; the column moves on once the row is gone", async () => {
    const { wrapper, killProcess } = await mountApp();
    await wrapper.get("[role='row'][data-port='5432']").trigger("click");
    await flushPromises();
    inspectorButton(/^\s*Kill/)?.click();
    await flushPromises();
    expect(killProcess).not.toHaveBeenCalled();
    expect(dialog()?.textContent).toContain("Kill com.docker.backend (11710)?");
    [...(dialog()?.querySelectorAll("button") ?? [])]
      .find((b) => b.textContent?.includes("Kill anyway"))
      ?.click();
    await flushPromises();
    expect(killProcess).toHaveBeenCalledWith({ pid: 11710, force: false });
    // The selection slid to the neighbour (ControlCenter), and the column shows it.
    expect(inspector()?.textContent).not.toContain("com.docker.backend");
    expect(inspector()?.textContent).toContain("ControlCenter");
  });

  it("says when an inspector action is not available in the browser", async () => {
    const { wrapper } = await mountApp();
    await wrapper.get("[role='row'][data-port='3000']").trigger("click");
    await flushPromises();
    inspectorButton(/Reveal folder/)?.click();
    await flushPromises();
    expect(wrapper.text()).toContain("Not available in the browser");
  });

  it("shows the empty state", async () => {
    const { wrapper } = await mountApp(createMockApi([]));
    expect(wrapper.text()).toContain("No listening ports.");
    expect(wrapper.text()).toContain("Start a dev server and it will appear here.");
    expect(wrapper.get("[data-action='reap']").attributes("disabled")).toBeDefined();
  });
});

describe("App: preferences (WP-17b)", () => {
  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
  });

  it("shows no first-run card once dismissed; with the flag off it shows, and Got it stores the flag", async () => {
    const { wrapper } = await mountApp();
    expect(wrapper.find("[data-onboarding]").exists()).toBe(false);
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";

    const api = createMockApi();
    await api.setSettings({ ...(await api.getSettings()), onboardingDone: false });
    const setSettings = vi.spyOn(api, "setSettings");
    const { wrapper: fresh } = await mountApp(api);
    const card = fresh.get("[data-onboarding]");
    expect(card.text()).toContain("PortReaper is in your menu bar");
    expect(card.text()).toContain("Start at login is on");
    await card.get("[data-pref='startAtLogin']").trigger("click");
    await flushPromises();
    expect(setSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ startAtLogin: false, onboardingDone: false }),
    );
    expect(fresh.get("[data-onboarding]").text()).toContain("Start at login is off");

    await fresh.get("[data-action='got-it']").trigger("click");
    await flushPromises();
    expect(setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ onboardingDone: true }));
    expect(fresh.find("[data-onboarding]").exists()).toBe(false);
    expect((await api.getSettings()).onboardingDone).toBe(true);
    // The card is the Studio's and it is gone for good: Preferences and back bring nothing.
    await nav(fresh, "settings").trigger("click");
    await flushPromises();
    await nav(fresh, "all").trigger("click");
    expect(fresh.find("[data-onboarding]").exists()).toBe(false);
  });

  it("⌘, opens Preferences with the item on and the toolbar out of the way; a change saves; Esc goes back", async () => {
    const { wrapper, api } = await mountApp();
    press(",", { metaKey: true });
    await flushPromises();
    expect(wrapper.find("[data-view='settings']").exists()).toBe(true);
    expect(wrapper.get("[data-view='settings'] h1").text()).toBe("Preferences");
    expect(nav(wrapper, "settings").attributes("aria-current")).toBe("true");
    expect(nav(wrapper, "all").attributes("aria-current")).toBeUndefined();
    expect(rowsOf(wrapper)).toHaveLength(0);
    // The toolbar stays mounted but hidden: Preferences brings its own strip.
    expect(wrapper.find("[data-tauri-drag-region][style*='display: none']").exists()).toBe(true);
    expect(wrapper.find("[data-action='reap']").exists()).toBe(false);

    await wrapper.get("[data-pref='notifications']").trigger("click");
    await flushPromises();
    expect((await api.getSettings()).notifications).toBe(false);
    expect(wrapper.get("[data-pref='notifications']").attributes("aria-checked")).toBe("false");
    expect(wrapper.get("[data-row='notifications'] .transition-opacity").classes()).toContain("opacity-100");
    expect(wrapper.get("[data-row='dockIcon'] .transition-opacity").classes()).toContain("opacity-0");

    press("Escape");
    await flushPromises();
    expect(wrapper.find("[data-view='settings']").exists()).toBe(false);
    expect(rowsOf(wrapper)).toHaveLength(N);
    expect(nav(wrapper, "all").attributes("aria-current")).toBe("true");

    // The sidebar item opens it too, and the view re-reads what the core kept.
    await nav(wrapper, "settings").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-view='settings']").exists()).toBe(true);
    expect(wrapper.get("[data-pref='notifications']").attributes("aria-checked")).toBe("false");
  });

  it("Kill sends SIGKILL at once: ↩ forces the selection and ⌘⌫ is the graceful one", async () => {
    const api = createMockApi();
    await api.setSettings({ ...(await api.getSettings()), defaultForce: true });
    const { wrapper, killProcess } = await mountApp(api);
    press("ArrowDown");
    await flushPromises();
    press("Enter");
    await flushPromises();
    expect(killProcess).toHaveBeenCalledWith({ pid: 48213, force: true });
    expect(wrapper.text()).toContain("Force-killed node (48213). Port 3000 is free.");
    // The selection slid to the neighbour; ⌘⌫ flips the base back to graceful.
    press("Backspace", { metaKey: true });
    await flushPromises();
    expect(killProcess).toHaveBeenCalledTimes(2);
    expect(killProcess.mock.calls[1]?.[0]).toMatchObject({ force: false });
  });
});

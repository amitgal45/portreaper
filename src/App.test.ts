import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import App from "./App.vue";
import { API_KEY } from "./api";
import { createMockApi, MOCK_ENTRIES } from "./api/mock";
import { INSPECTOR_COLUMN_MIN_WIDTH } from "./composables/useInspector";
import { UNREAD_SETTINGS } from "./composables/useSettings";

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
}

const N = MOCK_ENTRIES.length;
/** The start time of a mock pid: what its rows carry, and so what a kill of one of them sends. */
const startOf = (pid: number) => MOCK_ENTRIES.find((e) => e.pid === pid)?.startedAt ?? null;

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
    expect(killProcess).toHaveBeenCalledWith({ pid: 48213, force: false, startedAt: startOf(48213) });
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
    expect(killProcess).toHaveBeenCalledWith({ pid: 11710, force: false, startedAt: startOf(11710) });
    expect(wrapper.find("[role='row'][data-port='6379']").exists()).toBe(false);
    expect(wrapper.text()).toContain("Ports 5432 and 6379 are free.");
  });

  it("a brew service launchd restarts: the dialog names the stop command; Copy command copies it and stays open", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    try {
      const { wrapper, killProcess } = await mountApp();
      await wrapper.get("[role='row'][data-port='11434'] button[aria-label='Kill']").trigger("click");
      await flushPromises();
      expect(killProcess).not.toHaveBeenCalled();
      expect(dialog()?.textContent).toContain("Kill ollama (32014)?");
      expect(dialog()?.textContent).toContain(
        "a Homebrew service (ollama) that launchd starts again after a kill",
      );
      expect(dialog()?.textContent).toContain("To stop it for good, run brew services stop ollama.");
      // The reason line says it comes back; the dialog does not say it twice.
      expect(dialog()?.textContent?.match(/starts (it )?again/g)).toHaveLength(1);

      const copy = dialog()?.querySelector<HTMLButtonElement>("[data-action='copy-stop-command']");
      expect(copy?.textContent?.trim()).toBe("Copy command");
      copy?.click();
      await flushPromises();
      // The core's string, as it came; a toast says so; the dialog is still up and nothing died.
      expect(writeText).toHaveBeenCalledWith("brew services stop ollama");
      expect(wrapper.text()).toContain("Copied brew services stop ollama");
      expect(dialog()?.textContent).toContain("Kill ollama (32014)?");
      expect(killProcess).not.toHaveBeenCalled();

      [...(dialog()?.querySelectorAll("button") ?? [])]
        .find((b) => b.textContent?.trim() === "Cancel")
        ?.click();
      await flushPromises();
      expect(wrapper.find("[role='row'][data-port='11434']").exists()).toBe(true);
      expect(killProcess).not.toHaveBeenCalled();
    } finally {
      writeText.mockRestore();
    }
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
    expect(portsOf(wrapper)).toEqual([5432, 5433, 6379]);
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
    expect(killProcess).toHaveBeenCalledWith({ pid: 48213, force: false, startedAt: startOf(48213) });
    const back = wrapper.get("[role='row'][data-port='3000']");
    expect(back.attributes("data-pid")).not.toBe("48213");
    expect(back.attributes("aria-selected")).toBe("true");
    expect(inspector()?.textContent).toContain(`Back on :3000 as pid ${back.attributes("data-pid")}.`);
    expect(inspector()?.textContent).toContain(`PID ${back.attributes("data-pid")}`);
    expect(wrapper.text()).toContain(
      `Relaunched node on port 3000 (new pid ${back.attributes("data-pid")}).`,
    );
  });

  it("a Kill from the inspector right after Restart, before the new pid is listed, sends no start time and kills it (#30)", async () => {
    // A narrow window: the inspector is a slide-over, which keeps its row while that row is not
    // listed (the column follows the selection and would close).
    const realMatchMedia = window.matchMedia.bind(window);
    const narrow = vi
      .spyOn(window, "matchMedia")
      .mockImplementation((query) =>
        query.includes(`${INSPECTOR_COLUMN_MIN_WIDTH}px`)
          ? ({ matches: false, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList)
          : realMatchMedia(query),
      );
    onTestFinished(() => narrow.mockRestore());
    // The relaunched server has not bound :3000 yet: the listing leaves its pid out. So the
    // inspector shows App.vue's row for it, not a listed one, and that row decides what a Kill sends.
    const api = createMockApi();
    const list = api.listPorts;
    api.listPorts = async () => (await list()).filter((e) => MOCK_ENTRIES.some((m) => m.pid === e.pid));
    const { wrapper, killProcess } = await mountApp(api);
    await wrapper.get("[role='row'][data-port='3000']").trigger("click");
    await flushPromises();
    inspectorButton(/Restart/)?.click();
    await flushPromises();
    const newPid = Number(/Back on :3000 as pid (\d+)\./.exec(inspector()?.textContent ?? "")?.[1]);
    expect(newPid).toBeGreaterThan(0);
    expect(wrapper.find(`[role='row'][data-pid='${newPid}']`).exists()).toBe(false);

    inspectorButton(/^\s*Kill/)?.click();
    await flushPromises();
    expect(killProcess).toHaveBeenLastCalledWith({ pid: newPid, force: false, startedAt: null });
    expect(killProcess).toHaveLastResolvedWith(expect.objectContaining({ status: "killed", pid: newPid }));
    // No port in the toast: the listing never showed the pid holding one.
    expect(wrapper.text()).toContain(`Killed node (${newPid}).`);
    expect(wrapper.text()).not.toContain("Did not kill");
    // The row goes: the core no longer lists the pid once it would have bound.
    expect((await list()).some((e) => e.pid === newPid)).toBe(false);
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
    expect(killProcess).toHaveBeenCalledWith({ pid: 11710, force: false, startedAt: startOf(11710) });
    // The selection slid to the neighbour, and the column shows it: the shop-db container row
    // that follows :5432 in the postgres:16 group (WP-20), held by another pid and so still there.
    expect(inspector()?.textContent).toContain("PID 11712");
    expect(inspector()?.textContent).toContain("Containershop-db");
    expect(inspector()?.textContent).not.toContain("PID 11710");
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

  it("Hide :7000 in the row menu: the row leaves at once, a toast says where it went, the status line counts it; × brings it back", async () => {
    const { wrapper, api } = await mountApp();
    const airplay = () => wrapper.find("[role='row'][data-port='7000']");
    await airplay().get("button[aria-label='More']").trigger("click");
    await flushPromises();
    const hide = document.body.querySelector<HTMLElement>("[role='menu'] [data-action='hide']");
    expect(hide?.textContent?.trim()).toBe("Hide :7000");
    hide?.click();
    await flushPromises();

    expect(airplay().exists()).toBe(false);
    expect(rowsOf(wrapper)).toHaveLength(N - 1);
    expect(wrapper.text()).toContain("Port 7000 hidden · Preferences lists it");
    expect(wrapper.get("footer").text()).toContain(`${N - 1} ports`);
    expect(wrapper.get("footer [data-hidden-count]").text()).toBe("· 1 hidden");
    expect((await api.getSettings()).hiddenPorts).toEqual([7000]);

    // Preferences lists it; its × shows it again, and the list has it before the next poll.
    await nav(wrapper, "settings").trigger("click");
    await flushPromises();
    expect(wrapper.findAll("[data-hidden-port]").map((c) => c.text())).toEqual([":7000"]);
    await wrapper.get("button[aria-label='Show port 7000 again']").trigger("click");
    await flushPromises();
    expect((await api.getSettings()).hiddenPorts).toEqual([]);
    expect(wrapper.find("[data-hidden-port]").exists()).toBe(false);
    expect(wrapper.find("footer [data-hidden-count]").exists()).toBe(false);
    expect(wrapper.get("footer").text()).toContain(`${N} ports`);
    await nav(wrapper, "all").trigger("click");
    expect(rowsOf(wrapper)).toHaveLength(N);
    expect(airplay().exists()).toBe(true);
  });

  it("Hide :7000 when the preferences could not be read saves nothing, keeps the row and says why", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getSettings").mockRejectedValueOnce(new Error("the store is unreadable"));
    const setSettings = vi.spyOn(api, "setSettings");
    const { wrapper } = await mountApp(api);
    const airplay = () => wrapper.find("[role='row'][data-port='7000']");
    await airplay().get("button[aria-label='More']").trigger("click");
    await flushPromises();
    document.body.querySelector<HTMLElement>("[role='menu'] [data-action='hide']")?.click();
    await flushPromises();

    // A save now would write the defaults over what the user stored.
    expect(setSettings).not.toHaveBeenCalled();
    expect(airplay().exists()).toBe(true);
    expect(rowsOf(wrapper)).toHaveLength(N);
    expect(wrapper.text()).toContain(`Could not hide port 7000: ${UNREAD_SETTINGS}`);
    expect(wrapper.find("footer [data-hidden-count]").exists()).toBe(false);
  });

  it("Kill sends SIGKILL at once: ↩ forces the selection and ⌘⌫ is the graceful one", async () => {
    const api = createMockApi();
    await api.setSettings({ ...(await api.getSettings()), defaultForce: true });
    const { wrapper, killProcess } = await mountApp(api);
    press("ArrowDown");
    await flushPromises();
    press("Enter");
    await flushPromises();
    expect(killProcess).toHaveBeenCalledWith({ pid: 48213, force: true, startedAt: startOf(48213) });
    expect(wrapper.text()).toContain("Force-killed node (48213). Port 3000 is free.");
    // The selection slid to the neighbour; ⌘⌫ flips the base back to graceful.
    press("Backspace", { metaKey: true });
    await flushPromises();
    expect(killProcess).toHaveBeenCalledTimes(2);
    expect(killProcess.mock.calls[1]?.[0]).toMatchObject({ force: false });
  });

  it("no key pressed in Preferences kills the selection: not ⌘⌫ or Enter in Port to hide, nor on the window", async () => {
    const { wrapper, api, killProcess } = await mountApp();
    const freePort = vi.spyOn(api, "freePort");
    const reapZombies = vi.spyOn(api, "reapZombies");
    press("ArrowDown");
    await flushPromises();
    expect(wrapper.get("[role='row'][data-port='3000']").attributes("aria-selected")).toBe("true");

    // The selection outlives the switch: ⌘⌫ or Enter reaching the window's handlers would kill :3000.
    press(",", { metaKey: true });
    await flushPromises();
    expect(wrapper.find("[data-view='settings']").exists()).toBe(true);
    const field = wrapper.get("input[aria-label='Port to hide']").element as HTMLInputElement;
    field.focus();
    expect(document.activeElement).toBe(field);
    press("Backspace", { metaKey: true }, field);
    press("Enter", {}, field);
    await flushPromises();
    // The handlers' own guard holds without the field's help: the same keys on the window, and ⌘⌫
    // on a shortcut recorder that is not recording.
    const recorder = wrapper.get("[data-pref='quickShortcut'] [data-recorder]").element;
    press("Backspace", { metaKey: true });
    press("Enter");
    press("Backspace", { metaKey: true }, recorder);
    await flushPromises();
    expect(killProcess).not.toHaveBeenCalled();
    expect(freePort).not.toHaveBeenCalled();
    expect(reapZombies).not.toHaveBeenCalled();
    expect(wrapper.find("[data-view='settings']").exists()).toBe(true);
    expect((await api.getSettings()).hiddenPorts).toEqual([]);

    // Esc is the one key the field lets through: back to the ports, where :3000 is still listed.
    press("Escape", {}, field);
    await flushPromises();
    expect(wrapper.find("[data-view='settings']").exists()).toBe(false);
    expect(rowsOf(wrapper)).toHaveLength(N);
    expect(wrapper.find("[role='row'][data-port='3000']").exists()).toBe(true);
    expect((await api.listPorts()).some((e) => e.pid === 48213)).toBe(true);
    expect(wrapper.text()).not.toContain("Killed node (48213)");
  });

  it("no key pressed on the Taskline kills the selection either", async () => {
    const { wrapper, killProcess } = await mountApp();
    press("ArrowDown");
    await flushPromises();
    expect(wrapper.get("[role='row'][data-port='3000']").attributes("aria-selected")).toBe("true");
    await wrapper.get("[data-nav='taskline']").trigger("click");
    await flushPromises();
    expect(wrapper.find("[role='feed']").exists()).toBe(true);
    press("Backspace", { metaKey: true });
    press("Enter");
    await flushPromises();
    expect(killProcess).not.toHaveBeenCalled();
    expect(wrapper.text()).not.toContain("Killed node (48213)");
  });
});

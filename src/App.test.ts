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

async function mountApp(api = createMockApi()) {
  const killProcess = vi.spyOn(api, "killProcess");
  const wrapper = mount(App, { global: { provide: { [API_KEY as symbol]: api } }, attachTo: document.body });
  mounted = wrapper;
  await flushPromises();
  return { api, killProcess, wrapper };
}

const rowsOf = (wrapper: VueWrapper) => wrapper.findAll("[role='row']");
const portsOf = (wrapper: VueWrapper) => rowsOf(wrapper).map((r) => Number(r.attributes("data-port")));
/** The drawer is portalled to the body. */
const drawer = () => document.body.querySelector<HTMLElement>("[data-drawer]");
const drawerButton = (name: RegExp) =>
  [...(drawer()?.querySelectorAll("button") ?? [])].find((b) => name.test(b.textContent ?? "")) ?? null;
const dialog = () => document.body.querySelector("[role='alertdialog']");

describe("App", () => {
  // Unmount here, not in the test: a failed assertion must not leave a zombie App listening.
  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
  });

  it("lists the machine grouped by project, with the counts in the title strip and the status line", async () => {
    const { wrapper } = await mountApp();
    expect(rowsOf(wrapper)).toHaveLength(N);
    expect(wrapper.text()).toContain("shop-api");
    expect(wrapper.get("header").text()).toContain(`${N} ports`);
    expect(wrapper.get("footer").text()).toContain(`${N} ports · 7 projects`);
    expect(wrapper.get("footer").text()).toMatch(/scan \d+ ms/);
    expect(wrapper.text()).toContain("v0.2.0-mock");
    // The tiles over the list.
    expect(wrapper.get("[data-tile='zombies']").text()).toContain("220 MB reclaimable");
    expect(wrapper.get("[data-tile='public']").text()).toContain("3");
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
    // The Taskline tab counts it.
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

  it("Esc clears the search, then the pill, then the selection; a digit from the list starts a search", async () => {
    const { wrapper } = await mountApp();
    const input = wrapper.get("input[aria-label='Search ports']");
    await input.setValue("51");
    expect(wrapper.get("footer").text()).toContain(`2 of ${N} ports`);
    press("Escape", {}, input.element);
    await flushPromises();
    expect((input.element as HTMLInputElement).value).toBe("");
    expect(rowsOf(wrapper)).toHaveLength(N);

    await wrapper.get("[data-pill='db']").trigger("click");
    expect(portsOf(wrapper)).toEqual([5432, 6379]);
    press("Escape");
    await flushPromises();
    expect(rowsOf(wrapper)).toHaveLength(N);

    press("ArrowDown");
    await flushPromises();
    expect(wrapper.findAll("[role='row'][aria-selected='true']")).toHaveLength(1);
    press("Escape");
    await flushPromises();
    expect(wrapper.findAll("[role='row'][aria-selected='true']")).toHaveLength(0);

    press("8");
    await flushPromises();
    expect((input.element as HTMLInputElement).value).toBe("8");
    expect(portsOf(wrapper)).toEqual([8080]);
  });

  it("the pills and the tiles filter the list; the same tile again shows everything", async () => {
    const { wrapper } = await mountApp();
    await wrapper.get("[data-pill='zombie']").trigger("click");
    expect(portsOf(wrapper)).toEqual([5174]);
    expect(wrapper.get("[data-pill='zombie']").attributes("aria-pressed")).toBe("true");
    await wrapper.get("[data-pill='ai']").trigger("click");
    expect(portsOf(wrapper)).toEqual([11434]);
    await wrapper.get("[data-tile='public']").trigger("click");
    expect(portsOf(wrapper)).toEqual([8080, 5432, 6379]);
    expect(wrapper.get("[data-tile='public']").attributes("aria-pressed")).toBe("true");
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
    expect(rowsOf(wrapper)).toHaveLength(N - 1);
    expect(wrapper.text()).toContain("Reaped 1 zombie, 220 MB back.");
    expect(wrapper.get("[data-action='reap']").attributes("disabled")).toBeDefined();

    await wrapper.get("[role='tab'][aria-selected='false']").trigger("click");
    const feed = wrapper.get("[role='feed']");
    expect(feed.findAll("article")).toHaveLength(1);
    expect(feed.text()).toContain("ZOMBIE REAPED");
    expect(feed.text()).toContain("Reaped node (39871), a lost-terminal server on port 5174.");
    expect(feed.text()).toMatch(/RAM: 220 MB · 180 ms · tinyrecipe-lp/);

    // Relaunch brings it back: the feed records it, the badge counts three, the list has it again.
    const relaunch = feed.get("[data-event][data-kind='zombieReaped'] button");
    await relaunch.trigger("click");
    await flushPromises();
    expect(feed.findAll("article")).toHaveLength(2);
    expect(feed.text()).toContain("RELAUNCHED");
    expect(wrapper.get("[data-badge='taskline-count']").text()).toBe("2");
    await wrapper.get("[role='tab'][aria-selected='false']").trigger("click");
    expect(rowsOf(wrapper)).toHaveLength(N);

    // Clear empties the feed.
    await wrapper.get("[role='tab'][aria-selected='false']").trigger("click");
    const clear = wrapper.findAll("button").find((b) => b.text() === "Clear");
    await clear?.trigger("click");
    await flushPromises();
    expect(wrapper.get("[role='feed']").text()).toContain("Nothing yet.");
    expect(wrapper.find("[data-badge='taskline-count']").exists()).toBe(false);
  });

  it("a row click opens the drawer with the tree; Esc closes it; Restart brings the row back with a new pid", async () => {
    const { wrapper, killProcess } = await mountApp();
    await wrapper.get("[role='row'][data-port='3000']").trigger("click");
    await flushPromises();
    expect(drawer()?.textContent).toContain("node (Next.js)");
    expect(drawer()?.textContent).toContain("[LISTENING ON :3000]");
    expect(wrapper.get("[role='row'][data-port='3000']").attributes("aria-selected")).toBe("true");

    // The list's keys are off while the drawer is open.
    press("Enter");
    await flushPromises();
    expect(killProcess).not.toHaveBeenCalled();

    drawer()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await flushPromises();
    expect(drawer()).toBeNull();

    await wrapper.get("[role='row'][data-port='3000'] button[aria-label='Inspect']").trigger("click");
    await flushPromises();
    drawerButton(/Restart/)?.click();
    await flushPromises();
    expect(killProcess).toHaveBeenCalledWith({ pid: 48213, force: false });
    const back = wrapper.get("[role='row'][data-port='3000']");
    expect(back.attributes("data-pid")).not.toBe("48213");
    expect(drawer()?.textContent).toContain(`Back on :3000 as pid ${back.attributes("data-pid")}.`);
    expect(drawer()?.textContent).toContain(`PID ${back.attributes("data-pid")}`);
    expect(wrapper.text()).toContain(
      `Relaunched node on port 3000 (new pid ${back.attributes("data-pid")}).`,
    );
  });

  it("Kill from the drawer goes through the gate and closes the drawer once the row is gone", async () => {
    const { wrapper, killProcess } = await mountApp();
    await wrapper.get("[role='row'][data-port='5432']").trigger("click");
    await flushPromises();
    drawerButton(/^\s*Kill/)?.click();
    await flushPromises();
    expect(killProcess).not.toHaveBeenCalled();
    expect(dialog()?.textContent).toContain("Kill com.docker.backend (11710)?");
    [...(dialog()?.querySelectorAll("button") ?? [])]
      .find((b) => b.textContent?.includes("Kill anyway"))
      ?.click();
    await flushPromises();
    expect(killProcess).toHaveBeenCalledWith({ pid: 11710, force: false });
    expect(drawer()).toBeNull();
  });

  it("says when a drawer action is not available in the browser", async () => {
    const { wrapper } = await mountApp();
    await wrapper.get("[role='row'][data-port='3000']").trigger("click");
    await flushPromises();
    drawerButton(/Reveal folder/)?.click();
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

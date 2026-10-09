import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App.vue";
import { API_KEY } from "./api";
import { createMockApi } from "./api/mock";

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
}

let mounted: VueWrapper | null = null;

async function mountApp(api = createMockApi()) {
  const killProcess = vi.spyOn(api, "killProcess");
  const wrapper = mount(App, { global: { provide: { [API_KEY as symbol]: api } }, attachTo: document.body });
  mounted = wrapper;
  await flushPromises();
  return { api, killProcess, wrapper };
}

describe("App", () => {
  // Unmount here, not in the test: a failed assertion must not leave a zombie App listening.
  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
  });

  it("lists the machine grouped by project with the count and version", async () => {
    const { wrapper } = await mountApp();
    const rows = wrapper.findAll("[role='row']");
    expect(rows).toHaveLength(9);
    expect(wrapper.text()).toContain("shop-api");
    expect(wrapper.text()).toContain("9 ports");
    expect(wrapper.text()).toContain("6 projects");
    expect(wrapper.text()).toContain("v0.1.0-mock");
  });

  it("type 3000, Enter: kills shop-api's next dev and frees the port", async () => {
    const { wrapper, killProcess } = await mountApp();
    const input = wrapper.get("input[aria-label='Search ports']");
    await input.setValue("3000");
    expect(wrapper.findAll("[role='row']")).toHaveLength(1);
    expect(wrapper.get("[role='row']").attributes("aria-selected")).toBe("true");
    press("Enter", {}, input.element);
    await flushPromises();
    expect(killProcess).toHaveBeenCalledWith({ pid: 48213, force: false });
    expect(wrapper.findAll("[role='row']")).toHaveLength(0);
    expect(wrapper.text()).toContain("Killed node (48213). Port 3000 is free.");
  });

  it("asks before killing a protected row and kills on Kill anyway", async () => {
    const { wrapper, killProcess } = await mountApp();
    const docker = wrapper.get("[role='row'][data-port='5432']");
    await docker.get("button[aria-label='Kill']").trigger("click");
    await flushPromises();
    expect(killProcess).not.toHaveBeenCalled();
    const dialog = document.body.querySelector("[role='alertdialog']");
    expect(dialog?.textContent).toContain("Kill com.docker.backend (11710)?");
    expect(dialog?.textContent).toContain("is Docker");
    expect(dialog?.textContent).toContain("ports 5432 and 6379");

    // Enter while the dialog is open must not reach the list.
    press("Enter");
    expect(killProcess).not.toHaveBeenCalled();

    const action = [...(dialog?.querySelectorAll("button") ?? [])].find((b) =>
      b.textContent?.includes("Kill anyway"),
    );
    action?.click();
    await flushPromises();
    expect(killProcess).toHaveBeenCalledWith({ pid: 11710, force: false });
    expect(wrapper.find("[role='row'][data-port='6379']").exists()).toBe(false);
    expect(wrapper.text()).toContain("Ports 5432 and 6379 are free.");
  });

  it("Esc clears the search, then the selection; a digit from the list starts a search", async () => {
    const { wrapper } = await mountApp();
    const input = wrapper.get("input[aria-label='Search ports']");
    await input.setValue("51");
    expect(wrapper.text()).toContain("2 of 9");
    press("Escape", {}, input.element);
    await flushPromises();
    expect((input.element as HTMLInputElement).value).toBe("");
    expect(wrapper.findAll("[role='row']")).toHaveLength(9);

    press("ArrowDown");
    await flushPromises();
    expect(wrapper.findAll("[aria-selected='true']")).toHaveLength(1);
    press("Escape");
    await flushPromises();
    expect(wrapper.findAll("[aria-selected='true']")).toHaveLength(0);

    press("8");
    await flushPromises();
    expect((input.element as HTMLInputElement).value).toBe("8");
    expect(wrapper.findAll("[role='row']").map((r) => r.attributes("data-port"))).toEqual(["8080"]);
  });

  it("says when a row action is not available in the browser", async () => {
    const { wrapper } = await mountApp();
    await wrapper.get("[role='row'][data-port='3000'] button[aria-label='More']").trigger("click");
    await flushPromises();
    const item = [...document.body.querySelectorAll("[role='menuitem']")].find((el) =>
      el.textContent?.includes("Reveal"),
    );
    expect(item).toBeDefined();
    item?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await flushPromises();
    expect(wrapper.text()).toContain("Not available in the browser");
  });

  it("shows the empty state", async () => {
    const { wrapper } = await mountApp(createMockApi([]));
    expect(wrapper.text()).toContain("No listening ports.");
    expect(wrapper.text()).toContain("Start a dev server and it will appear here.");
  });
});

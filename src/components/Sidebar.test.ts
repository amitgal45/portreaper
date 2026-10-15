import { mount, type VueWrapper } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { createMockApi, MOCK_UPDATE } from "../api/mock";
import { usePorts } from "../composables/usePorts";
import { type UpdateState, useUpdate } from "../composables/useUpdate";
import Sidebar from "./Sidebar.vue";

/** The sidebar over the mock, the way App.vue feeds it, with the banner in the given state. */
async function mountSidebar(update: UpdateState) {
  const store = usePorts(createMockApi(), { storage: null });
  await store.refresh();
  return mount(Sidebar, {
    props: { view: "studio", category: "all", counts: store.counts.value, tasklineCount: 0, update },
  });
}

const banner = (wrapper: VueWrapper) => wrapper.find("[data-update]");

describe("Sidebar update banner", () => {
  it("shows nothing while no update is known", async () => {
    const wrapper = await mountSidebar({ phase: "idle" });
    expect(banner(wrapper).exists()).toBe(false);
    expect(wrapper.get("[data-nav='taskline']").text()).toContain("Taskline");
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
    expect(button.classes()).toEqual(expect.arrayContaining(["bg-brand", "text-white"]));
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

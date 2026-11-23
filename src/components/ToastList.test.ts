import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { Toast } from "../composables/useToasts";
import ToastList from "./ToastList.vue";

/**
 * The stack as App.vue feeds it. The real TransitionGroup, not the test-utils stub: the stub renders a
 * `<transition-group-stub>` in place of the `div` the app really gets.
 */
function mountList(toasts: Toast[]) {
  return mount(ToastList, {
    props: { toasts },
    global: { stubs: { TransitionGroup: false } },
  });
}

const killed: Toast = { id: 7, message: "Killed node on :3000", kind: "info" };
const refused: Toast = { id: 9, message: "Could not kill pid 412: permission denied", kind: "error" };

describe("ToastList", () => {
  it("renders one button per toast, in the order given, with its message", () => {
    const wrapper = mountList([killed, refused]);
    const buttons = wrapper.findAll("button");
    expect(buttons.map((b) => b.text())).toEqual([
      "Killed node on :3000",
      "Could not kill pid 412: permission denied",
    ]);
    for (const b of buttons) expect(b.attributes("type")).toBe("button");
    wrapper.unmount();

    const reversed = mountList([refused, killed]);
    expect(reversed.findAll("button").map((b) => b.text())).toEqual([
      "Could not kill pid 412: permission denied",
      "Killed node on :3000",
    ]);
    reversed.unmount();
  });

  it("colours an error toast red and any other toast in ink with a green bar", () => {
    const wrapper = mountList([killed, refused]);
    const [info, error] = wrapper.findAll("button").map((b) => b.classes());
    expect(error).toContain("text-red-ink");
    expect(error).toContain("before:bg-red");
    expect(error).not.toContain("text-ink");
    expect(error).not.toContain("before:bg-green");
    expect(info).toContain("text-ink");
    expect(info).toContain("before:bg-green");
    expect(info).not.toContain("text-red-ink");
    expect(info).not.toContain("before:bg-red");
    wrapper.unmount();
  });

  it("emits dismiss once, with the id of the toast clicked", async () => {
    const wrapper = mountList([killed, refused]);
    await wrapper.findAll("button")[1]?.trigger("click");
    expect(wrapper.emitted("dismiss")).toEqual([[9]]);

    await wrapper.findAll("button")[0]?.trigger("click");
    expect(wrapper.emitted("dismiss")).toEqual([[9], [7]]);
    wrapper.unmount();
  });

  it("is a polite status region that holds nothing, and so hides, when there are no toasts", () => {
    const wrapper = mountList([killed]);
    expect(wrapper.element.tagName).toBe("DIV");
    expect(wrapper.attributes("role")).toBe("status");
    expect(wrapper.attributes("aria-live")).toBe("polite");
    expect(wrapper.classes()).toContain("empty:hidden");
    expect(wrapper.findAll("button")).toHaveLength(1);
    wrapper.unmount();

    const empty = mountList([]);
    expect(empty.element.tagName).toBe("DIV");
    expect(empty.attributes("role")).toBe("status");
    expect(empty.attributes("aria-live")).toBe("polite");
    expect(empty.findAll("button")).toHaveLength(0);
    // `empty:hidden` only applies to an element with no children at all, text included.
    expect(empty.element.children).toHaveLength(0);
    expect(empty.element.textContent).toBe("");
    empty.unmount();
  });
});

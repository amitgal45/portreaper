import { describe, expect, it } from "vitest";
import { createApp, defineComponent, h } from "vue";
import { killLabels, provideActions, type UiActions, useActions } from "./useActions";

/** Mount `child` under a parent that may or may not call provideActions(); return what useActions() gave. */
function mountWith(actions: UiActions | null): { got: UiActions | null; error: unknown } {
  const result: { got: UiActions | null; error: unknown } = { got: null, error: null };
  const Child = defineComponent({
    setup() {
      try {
        result.got = useActions();
      } catch (e) {
        result.error = e;
      }
      return () => null;
    },
  });
  const Parent = defineComponent({
    setup() {
      if (actions) provideActions(actions);
      return () => h(Child);
    },
  });
  const app = createApp(Parent);
  app.config.warnHandler = () => {};
  app.mount(document.createElement("div"));
  app.unmount();
  return result;
}

const noop = () => {};
const spies: UiActions = {
  select: noop,
  inspect: noop,
  kill: noop,
  killGroup: noop,
  restart: noop,
  reap: noop,
  toggleGroup: noop,
  openInBrowser: noop,
  copyKill: noop,
  copyCommand: noop,
  copyStopCommand: noop,
  revealFolder: noop,
  watch: noop,
  hide: noop,
};

describe("killLabels", () => {
  it("offers a force kill on ⌥ while the default is graceful", () => {
    expect(killLabels(false)).toEqual({ title: "Kill · ⌥ to force", alt: "Force kill" });
  });

  it("offers a graceful kill on ⌥ while the default is SIGKILL", () => {
    expect(killLabels(true)).toEqual({
      title: "Kill · SIGKILL at once · ⌥ for graceful",
      alt: "Graceful kill",
    });
  });
});

describe("useActions", () => {
  it("returns what an ancestor provided", () => {
    const { got, error } = mountWith(spies);
    expect(error).toBeNull();
    expect(got).toBe(spies);
  });

  it("throws without provideActions() in an ancestor", () => {
    const { got, error } = mountWith(null);
    expect(got).toBeNull();
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("useActions() needs provideActions() in an ancestor");
  });
});

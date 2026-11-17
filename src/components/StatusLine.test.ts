import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import StatusLine from "./StatusLine.vue";

/** The line as App.vue feeds it after a poll, with `hidden` ports hidden in Preferences. */
function mountLine(hidden: number) {
  return mount(StatusLine, {
    props: {
      shown: 11,
      total: 11,
      projects: 7,
      lastRefresh: null,
      scanMs: 3,
      version: "0.4.0",
      error: null,
      hidden,
    },
  });
}

describe("StatusLine", () => {
  it("says how many ports are hidden, in the line's muted ink, and where they are listed", () => {
    const two = mountLine(2);
    expect(two.text()).toContain("11 ports · 7 projects · scan 3 ms · last refresh never");
    const count = two.get("[data-hidden-count]");
    expect(count.text()).toBe("· 2 hidden");
    expect(count.attributes("title")).toBe("Hidden ports are listed in Preferences");
    // No colour of its own: it reads in the footer's muted ink, like the counts before it.
    expect(two.get("footer").classes()).toContain("text-ink-3");
    expect(count.classes().filter((c) => c.startsWith("text-"))).toEqual([]);
    two.unmount();

    const one = mountLine(1);
    expect(one.get("[data-hidden-count]").text()).toBe("· 1 hidden");
    one.unmount();

    const none = mountLine(0);
    expect(none.find("[data-hidden-count]").exists()).toBe(false);
    expect(none.text()).not.toContain("hidden");
    none.unmount();
  });
});

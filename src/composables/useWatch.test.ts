import { flushPromises } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "../api/mock";
import type { WatchedPort } from "../types";
import { useToasts } from "./useToasts";
import { transitionMessage, useWatch } from "./useWatch";

const silent = () => () => {};
const tcp3000 = { port: 3000, protocol: "tcp" } as const;

describe("useWatch", () => {
  it("toggle watches through the core and updates the set; again it stops", async () => {
    const api = createMockApi();
    const watchPort = vi.spyOn(api, "watchPort");
    const unwatchPort = vi.spyOn(api, "unwatchPort");
    const watch = useWatch(api, useToasts(), { subscribe: silent });
    expect(watch.isWatched(tcp3000)).toBe(false);

    expect(await watch.toggle(tcp3000)).toBe(true);
    expect(watchPort).toHaveBeenCalledWith(3000, "tcp");
    expect(watch.isWatched(tcp3000)).toBe(true);
    // UDP on the same number is another port.
    expect(watch.isWatched({ port: 3000, protocol: "udp" })).toBe(false);
    expect(watch.watches.value).toMatchObject([{ port: 3000, state: "listening", pid: 48213 }]);
    expect([...watch.keys.value]).toEqual(["tcp:3000"]);

    expect(await watch.toggle(tcp3000)).toBe(false);
    expect(unwatchPort).toHaveBeenCalledWith(3000, "tcp");
    expect(watch.watches.value).toEqual([]);
  });

  it("loads the set on start, subscribes to the core, and unsubscribes on stop", async () => {
    const api = createMockApi();
    await api.watchPort(5173, "tcp");
    const off = vi.fn();
    const subscribe = vi.fn(() => off);
    const watch = useWatch(api, useToasts(), { subscribe });
    expect(watch.loaded.value).toBe(false);
    watch.start();
    watch.start();
    await flushPromises();
    expect(watch.loaded.value).toBe(true);
    expect(watch.isWatched({ port: 5173, protocol: "tcp" })).toBe(true);
    expect(subscribe).toHaveBeenCalledTimes(1);
    watch.stop();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("a watch:changed payload updates the watch in place and makes one toast with the right text", () => {
    let deliver: ((w: WatchedPort) => void) | null = null;
    const toasts = useToasts();
    const watch = useWatch(createMockApi(), toasts, {
      subscribe: (handler) => {
        deliver = handler;
        return () => {};
      },
    });
    watch.start();
    const push = deliver as unknown as (w: WatchedPort) => void;

    const freed: WatchedPort = {
      port: 3000,
      protocol: "tcp",
      state: "free",
      pid: 48213,
      processName: "node",
      project: "shop-api",
      sinceMs: 1,
    };
    push(freed);
    expect(toasts.toasts.value.map((t) => [t.message, t.kind])).toEqual([["Port 3000 is free", "info"]]);
    // A watch the UI did not know yet (set from another window) is taken in.
    expect(watch.watches.value).toEqual([freed]);

    const taken: WatchedPort = { ...freed, state: "listening", pid: 51022, sinceMs: 2 };
    push(taken);
    expect(toasts.toasts.value).toHaveLength(2);
    expect(toasts.toasts.value[1]?.message).toBe("Port 3000 taken by node");
    expect(watch.watches.value).toEqual([taken]);

    expect(transitionMessage({ ...taken, processName: null })).toBe("Port 3000 taken");
    watch.stop();
  });

  it("toasts a failure and leaves the set alone", async () => {
    const api = createMockApi();
    vi.spyOn(api, "watchPort").mockRejectedValueOnce(new Error("ipc down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const toasts = useToasts();
    const watch = useWatch(api, toasts, { subscribe: silent });
    expect(await watch.toggle(tcp3000)).toBe(false);
    expect(toasts.toasts.value[0]).toMatchObject({ message: "Could not watch port 3000.", kind: "error" });
    expect(watch.watches.value).toEqual([]);
  });
});

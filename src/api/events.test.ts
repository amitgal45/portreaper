import { afterEach, describe, expect, it, vi } from "vitest";
import type { TasklineEvent } from "../types";
import { isTasklineEvent, onTasklineEvent, TASKLINE_EVENT } from "./events";

const { listen } = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

const sample: TasklineEvent = {
  id: 1,
  atMs: 1_700_000_000_000,
  kind: "portFreed",
  port: 3000,
  protocol: "tcp",
  pid: 48213,
  processName: "node",
  project: "shop-api",
  memoryBytes: 412 * 1024 * 1024,
  durationMs: 180,
  message: "Killed node (48213). Port 3000 is free.",
  relaunchable: true,
};

describe("isTasklineEvent", () => {
  it("accepts the contract's shape and nothing else", () => {
    expect(isTasklineEvent(sample)).toBe(true);
    expect(isTasklineEvent({ ...sample, kind: "exploded" })).toBe(false);
    expect(isTasklineEvent({ ...sample, id: "1" })).toBe(false);
    expect(isTasklineEvent(null)).toBe(false);
    expect(isTasklineEvent("portFreed")).toBe(false);
  });
});

describe("onTasklineEvent", () => {
  afterEach(() => {
    listen.mockReset();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("is a no-op outside Tauri", () => {
    const handler = vi.fn();
    const off = onTasklineEvent(handler);
    expect(listen).not.toHaveBeenCalled();
    off();
  });

  it("subscribes inside Tauri, validates the payload, and unsubscribes", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = vi.fn();
    const off = onTasklineEvent(handler);
    await Promise.resolve();
    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen.mock.calls[0]?.[0]).toBe(TASKLINE_EVENT);
    const deliver = listen.mock.calls[0]?.[1] as (event: { payload: unknown }) => void;
    deliver({ payload: sample });
    deliver({ payload: { nope: true } });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(sample);
    off();
    expect(unlisten).toHaveBeenCalledTimes(1);
    deliver({ payload: sample });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("drops a subscription that resolves after the unsubscribe", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const unlisten = vi.fn();
    let resolve: ((fn: typeof unlisten) => void) | undefined;
    listen.mockImplementation(() => new Promise((r) => (resolve = r)));
    const off = onTasklineEvent(vi.fn());
    off();
    resolve?.(unlisten);
    await Promise.resolve();
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

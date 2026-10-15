import { afterEach, describe, expect, it, vi } from "vitest";
import type { TasklineEvent } from "../types";
import {
  isTasklineEvent,
  isUpdateFailure,
  isUpdateInfo,
  isUpdateProgress,
  onTasklineEvent,
  onUpdateAvailable,
  onUpdateError,
  onUpdateProgress,
  TASKLINE_EVENT,
  UPDATE_AVAILABLE_EVENT,
  UPDATE_ERROR_EVENT,
  UPDATE_PROGRESS_EVENT,
} from "./events";

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

describe("the update payload guards", () => {
  it("accept the contract's shapes and nothing else", () => {
    expect(isUpdateInfo({ version: "0.3.0", notes: "- The Board", date: "2026-10-15T20:00:00Z" })).toBe(true);
    expect(isUpdateInfo({ version: "0.3.0", notes: null, date: null })).toBe(true);
    expect(isUpdateInfo({ version: 3, notes: null, date: null })).toBe(false);
    expect(isUpdateInfo({ version: "0.3.0", notes: 7, date: null })).toBe(false);
    expect(isUpdateInfo({ version: "0.3.0" })).toBe(false);
    expect(isUpdateInfo(null)).toBe(false);

    expect(isUpdateProgress({ downloaded: 42, total: 100 })).toBe(true);
    expect(isUpdateProgress({ downloaded: 42, total: null })).toBe(true);
    expect(isUpdateProgress({ downloaded: "42", total: 100 })).toBe(false);
    expect(isUpdateProgress({ downloaded: 42 })).toBe(false);

    expect(isUpdateFailure({ message: "Couldn't reach the update server" })).toBe(true);
    expect(isUpdateFailure({ message: 1 })).toBe(false);
    expect(isUpdateFailure("nope")).toBe(false);
  });
});

describe("the update listeners", () => {
  afterEach(() => {
    listen.mockReset();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("are no-ops outside Tauri", () => {
    for (const off of [onUpdateAvailable(vi.fn()), onUpdateProgress(vi.fn()), onUpdateError(vi.fn())]) off();
    expect(listen).not.toHaveBeenCalled();
  });

  it("subscribe to their event inside Tauri and drop a payload that is not theirs", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    listen.mockResolvedValue(vi.fn());
    vi.spyOn(console, "error").mockImplementation(() => {});
    const available = vi.fn();
    const progress = vi.fn();
    const error = vi.fn();
    onUpdateAvailable(available);
    onUpdateProgress(progress);
    onUpdateError(error);
    await Promise.resolve();
    expect(listen.mock.calls.map((c) => c[0])).toEqual([
      UPDATE_AVAILABLE_EVENT,
      UPDATE_PROGRESS_EVENT,
      UPDATE_ERROR_EVENT,
    ]);
    const deliver = (index: number, payload: unknown) => {
      const handler = listen.mock.calls[index]?.[1] as ((event: { payload: unknown }) => void) | undefined;
      if (!handler) throw new Error(`no listener ${index}`);
      handler({ payload });
    };
    deliver(0, { version: "0.3.0", notes: null, date: null });
    deliver(0, { downloaded: 1, total: null });
    deliver(1, { downloaded: 1, total: null });
    deliver(2, { message: "x" });
    deliver(2, {});
    expect(available).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith({ downloaded: 1, total: null });
    expect(error).toHaveBeenCalledWith({ message: "x" });
    expect(console.error).toHaveBeenCalledTimes(2);
  });
});

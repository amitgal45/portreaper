import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "../api/mock";
import type { TasklineEvent } from "../types";
import { relaunchMessage, useTaskline } from "./useTaskline";
import { useToasts } from "./useToasts";

function collision(id: number, port: number, atMs: number): TasklineEvent {
  return {
    id,
    atMs,
    kind: "collisionResolved",
    port,
    protocol: "tcp",
    pid: 1,
    processName: "node",
    project: null,
    memoryBytes: 0,
    durationMs: 0,
    message: `Port ${port} was taken by a new process after PortReaper freed it.`,
    relaunchable: false,
  };
}

describe("useTaskline: loading", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("loads on start, polls while visible, and stops", async () => {
    const api = createMockApi();
    const tasklineEvents = vi.spyOn(api, "tasklineEvents");
    let visible = true;
    const taskline = useTaskline(api, useToasts(), { isVisible: () => visible, subscribe: () => () => {} });
    expect(taskline.loaded.value).toBe(false);
    taskline.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(taskline.loaded.value).toBe(true);
    expect(taskline.events.value).toEqual([]);
    expect(tasklineEvents).toHaveBeenCalledTimes(1);

    await api.killProcess({ pid: 48213, force: false });
    await vi.advanceTimersByTimeAsync(2000);
    expect(tasklineEvents).toHaveBeenCalledTimes(2);
    expect(taskline.count.value).toBe(1);
    expect(taskline.events.value[0]).toMatchObject({ kind: "portFreed", port: 3000 });

    visible = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(6000);
    expect(tasklineEvents).toHaveBeenCalledTimes(2);
    visible = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(tasklineEvents).toHaveBeenCalledTimes(3);

    taskline.stop();
    await vi.advanceTimersByTimeAsync(4000);
    expect(tasklineEvents).toHaveBeenCalledTimes(3);
  });

  it("subscribes to the core's event on start and unsubscribes on stop", async () => {
    const off = vi.fn();
    let deliver: ((e: TasklineEvent) => void) | null = null;
    const subscribe = vi.fn((handler: (e: TasklineEvent) => void) => {
      deliver = handler;
      return off;
    });
    const taskline = useTaskline(createMockApi(), useToasts(), { subscribe, isVisible: () => true });
    taskline.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(subscribe).toHaveBeenCalledTimes(1);

    const event = collision(7, 3000, Date.now());
    (deliver as unknown as (e: TasklineEvent) => void)(event);
    (deliver as unknown as (e: TasklineEvent) => void)(event);
    expect(taskline.events.value).toEqual([event]);
    expect(taskline.count.value).toBe(1);

    taskline.stop();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("keeps the last feed and reports the error when a poll fails", async () => {
    const api = createMockApi();
    const taskline = useTaskline(api, useToasts(), { isVisible: () => true, subscribe: () => () => {} });
    taskline.start();
    await vi.advanceTimersByTimeAsync(0);
    vi.spyOn(api, "tasklineEvents").mockRejectedValueOnce(new Error("core went away"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(2000);
    expect(taskline.error.value).toBe("core went away");
    await vi.advanceTimersByTimeAsync(2000);
    expect(taskline.error.value).toBeNull();
    taskline.stop();
  });
});

describe("useTaskline: relaunch", () => {
  async function killed() {
    const api = createMockApi();
    const toasts = useToasts();
    const taskline = useTaskline(api, toasts, { subscribe: () => () => {} });
    await api.killProcess({ pid: 48213, force: false });
    await taskline.refresh();
    const event = taskline.events.value[0] as TasklineEvent;
    return { api, toasts, taskline, event };
  }

  it("brings the process back, toasts the new pid, hides the button, and reloads the feed", async () => {
    const { api, toasts, taskline, event } = await killed();
    expect(taskline.canRelaunch(event)).toBe(true);
    expect(taskline.latestFor(48213)).toBe(event);
    const outcome = await taskline.relaunch(event.id);
    expect(outcome.status).toBe("started");
    const pid = outcome.status === "started" ? outcome.pid : -1;
    expect(toasts.toasts.value[0]?.message).toBe(`Relaunched node on port 3000 (new pid ${pid}).`);
    expect(toasts.toasts.value[0]?.kind).toBe("info");
    expect(taskline.canRelaunch(event)).toBe(false);
    expect(taskline.events.value[0]?.kind).toBe("relaunched");
    expect((await api.listPorts()).find((e) => e.port === 3000)?.pid).toBe(pid);
  });

  it("toasts a failure in coral and keeps the button", async () => {
    const { api, toasts, taskline, event } = await killed();
    vi.spyOn(api, "relaunch").mockResolvedValueOnce({ status: "failed", eventId: event.id, error: "ENOENT" });
    expect((await taskline.relaunch(event.id)).status).toBe("failed");
    expect(toasts.toasts.value[0]).toMatchObject({
      message: "Could not relaunch node on port 3000: ENOENT.",
      kind: "error",
    });
    expect(taskline.canRelaunch(event)).toBe(true);
    expect(taskline.relaunching.size).toBe(0);
  });

  it("says when the core forgot the event or could not be reached", async () => {
    const { api, toasts, taskline, event } = await killed();
    vi.spyOn(api, "relaunch").mockResolvedValueOnce({ status: "notFound", eventId: event.id });
    await taskline.relaunch(event.id);
    expect(toasts.toasts.value[0]?.message).toBe(
      "Nothing to relaunch for node on port 3000: the core forgot it.",
    );
    vi.spyOn(api, "relaunch").mockRejectedValueOnce(new Error("ipc down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await taskline.relaunch(event.id)).toEqual({
      status: "transport",
      eventId: event.id,
      error: "ipc down",
    });
    expect(toasts.toasts.value.at(-1)?.message).toBe("Could not reach the core.");
    expect(relaunchMessage(null, { status: "started", pid: 5 })).toEqual({
      message: "Relaunched the process (new pid 5).",
      kind: "info",
    });
  });

  it("clears the feed through the core", async () => {
    const { api, taskline } = await killed();
    expect(taskline.count.value).toBe(1);
    await taskline.clear();
    expect(taskline.count.value).toBe(0);
    expect(await api.tasklineEvents()).toEqual([]);
  });
});

describe("useTaskline: recent collisions", () => {
  it("names the ports a collisionResolved touched in the last minute, and forgets them after", async () => {
    let t = 1_000_000;
    const api = createMockApi();
    vi.spyOn(api, "tasklineEvents").mockResolvedValue([
      collision(3, 5173, t - 10_000),
      collision(2, 3000, t - 59_000),
      collision(1, 8080, t - 61_000),
    ]);
    const taskline = useTaskline(api, useToasts(), { now: () => t, subscribe: () => () => {} });
    await taskline.refresh();
    expect([...taskline.recentCollisions.value].sort()).toEqual([3000, 5173]);

    t += 2000;
    await taskline.refresh();
    expect([...taskline.recentCollisions.value]).toEqual([5173]);

    t += 60_000;
    taskline.push(collision(4, 4000, t));
    expect([...taskline.recentCollisions.value]).toEqual([4000]);
  });
});

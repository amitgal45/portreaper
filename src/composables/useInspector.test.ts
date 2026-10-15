import { describe, expect, it } from "vitest";
import { nextTick } from "vue";
import { createMockApi } from "../api/mock";
import type { PortEntry } from "../types";
import { INSPECTOR_COLUMN_MIN_WIDTH, useInspector } from "./useInspector";
import { useKillFlow } from "./useKillFlow";
import { usePorts } from "./usePorts";
import { useTaskline } from "./useTaskline";
import { useToasts } from "./useToasts";

/** A window whose width a test can change. */
function fakeWindow(width: number) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  let matches = width >= INSPECTOR_COLUMN_MIN_WIDTH;
  return {
    matchMedia: (query: string) => {
      expect(query).toBe(`(min-width: ${INSPECTOR_COLUMN_MIN_WIDTH}px)`);
      return {
        get matches() {
          return matches;
        },
        addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => void listeners.add(fn),
        removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => void listeners.delete(fn),
      } as unknown as MediaQueryList;
    },
    resize(to: number) {
      matches = to >= INSPECTOR_COLUMN_MIN_WIDTH;
      for (const fn of listeners) fn({ matches } as MediaQueryListEvent);
    },
  };
}

async function setup(width: number) {
  const api = createMockApi();
  const ports = usePorts(api, { storage: null });
  await ports.refresh();
  const toasts = useToasts();
  const taskline = useTaskline(api, toasts, { subscribe: () => () => {} });
  const flow = useKillFlow(ports, toasts, taskline);
  const win = fakeWindow(width);
  const inspector = useInspector(ports, flow, { matchMedia: win.matchMedia });
  const byPort = (port: number) => ports.entries.value.find((e) => e.port === port) as PortEntry;
  return { api, ports, flow, inspector, win, byPort };
}

describe("useInspector in a wide window", () => {
  it("is a column that follows the selection and closes with it", async () => {
    const { ports, inspector, byPort } = await setup(900);
    expect(inspector.wide.value).toBe(true);
    expect(inspector.column.value).toBe(false);
    ports.select(byPort(3000));
    await nextTick();
    expect(inspector.column.value).toBe(true);
    expect(inspector.overlay.value).toBe(false);
    expect(inspector.entry.value?.port).toBe(3000);
    ports.selectNext();
    await nextTick();
    expect(inspector.entry.value?.port).toBe(4000);
    ports.clearSelection();
    await nextTick();
    expect(inspector.entry.value).toBeNull();
    expect(inspector.column.value).toBe(false);
  });

  it("shows the live row, and closes when the row leaves the list", async () => {
    const { ports, inspector, byPort } = await setup(900);
    inspector.open(byPort(3000));
    await nextTick();
    expect(inspector.entry.value).toBe(byPort(3000));
    await ports.kill(byPort(3000));
    await nextTick();
    expect(inspector.entry.value).toBeNull();
  });

  it("keeps the restarting row on show while the kill and the relaunch run, then takes the new pid", async () => {
    const { ports, flow, inspector, byPort } = await setup(900);
    const original = byPort(3000);
    ports.select(original);
    inspector.open(original);
    await nextTick();
    const done = flow.restart(original);
    await nextTick();
    // The kill slid the selection to the neighbour; the inspector did not follow.
    expect(flow.restarting.value?.phase).not.toBe("started");
    expect(inspector.inspecting.value?.pid).toBe(48213);
    const outcome = await done;
    expect(outcome.status).toBe("started");
    const back = ports.entries.value.find((e) => e.port === 3000) as PortEntry;
    inspector.inspecting.value = back;
    ports.select(back);
    await nextTick();
    expect(inspector.entry.value?.pid).toBe(back.pid);
    // The story is still there: opening the same row again does not forget it.
    expect(flow.restarting.value).toEqual({ phase: "started", pid: 48213, newPid: back.pid });
    // Another row forgets it.
    ports.select(byPort(5173));
    await nextTick();
    expect(flow.restarting.value).toBeNull();
  });
});

describe("useInspector in a narrow window", () => {
  it("is a slide-over that a click opens and the selection does not", async () => {
    const { ports, inspector, byPort } = await setup(760);
    expect(inspector.wide.value).toBe(false);
    ports.select(byPort(3000));
    await nextTick();
    expect(inspector.overlay.value).toBe(false);
    inspector.open(byPort(3000));
    await nextTick();
    expect(inspector.overlay.value).toBe(true);
    expect(inspector.column.value).toBe(false);
    inspector.close();
    expect(inspector.overlay.value).toBe(false);
    // Closing leaves the selection alone.
    expect(ports.selected.value?.port).toBe(3000);
  });

  it("closes across a resize to narrow, and takes the selection across a resize to wide", async () => {
    const { ports, inspector, win, byPort } = await setup(760);
    inspector.open(byPort(3000));
    ports.select(byPort(5173));
    win.resize(1000);
    await nextTick();
    expect(inspector.wide.value).toBe(true);
    expect(inspector.entry.value?.port).toBe(5173);
    win.resize(760);
    await nextTick();
    expect(inspector.entry.value).toBeNull();
    expect(inspector.overlay.value).toBe(false);
  });
});

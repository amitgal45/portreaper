import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { createMockApi } from "../api/mock";
import type { PortEntry } from "../types";
import { useKillFlow } from "./useKillFlow";
import { usePorts } from "./usePorts";
import { useToasts } from "./useToasts";
import { isTraySelectPayload, selectFromTray, TRAY_SELECT_PORT, useTrayListener } from "./useTray";

const { listen } = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

async function setup() {
  const api = createMockApi();
  const killProcess = vi.spyOn(api, "killProcess");
  const ports = usePorts(api, { storage: null });
  await ports.refresh();
  const flow = useKillFlow(ports, useToasts());
  return { api, killProcess, ports, flow };
}

describe("selectFromTray", () => {
  it("clears the search, selects the row and opens the confirm without killing", async () => {
    const { ports, flow, killProcess } = await setup();
    ports.query.value = "3000";
    await nextTick();
    expect(ports.selected.value?.port).toBe(3000);

    expect(await selectFromTray(ports, flow, { port: 5432, protocol: "tcp" })).toBe(true);
    await nextTick();
    expect(ports.query.value).toBe("");
    expect(ports.selected.value?.port).toBe(5432);
    expect(flow.confirm.value).toMatchObject({ kind: "entry", force: false });
    expect(flow.confirm.value?.kind === "entry" && flow.confirm.value.entry.pid).toBe(11710);
    expect(killProcess).not.toHaveBeenCalled();
  });

  it("asks even for a row that is not marked protected", async () => {
    const { ports, flow, killProcess } = await setup();
    expect(await selectFromTray(ports, flow, { port: 3000, protocol: "tcp" })).toBe(true);
    expect(flow.confirming.value).toBe(true);
    expect(killProcess).not.toHaveBeenCalled();
  });

  it("expands a collapsed group so the row is on screen", async () => {
    const { ports, flow } = await setup();
    ports.toggleGroup("p:postgres:16");
    expect(ports.visibleEntries.value.some((e) => e.port === 5432)).toBe(false);
    await selectFromTray(ports, flow, { port: 5432, protocol: "tcp" });
    await nextTick();
    expect(ports.collapsed.has("p:postgres:16")).toBe(false);
    expect(ports.selected.value?.port).toBe(5432);
  });

  it("matches the protocol, refreshes once for an unknown port, and gives up quietly", async () => {
    const { api, ports, flow } = await setup();
    const listPorts = vi.spyOn(api, "listPorts");
    expect(await selectFromTray(ports, flow, { port: 53, protocol: "udp" })).toBe(true);
    flow.cancel();
    expect(listPorts).not.toHaveBeenCalled();

    expect(await selectFromTray(ports, flow, { port: 53, protocol: "tcp" })).toBe(false);
    expect(listPorts).toHaveBeenCalledTimes(1);
    expect(flow.confirm.value).toBeNull();
  });

  it("finds a port that only the fresh list has", async () => {
    const { api, ports, flow } = await setup();
    const fresh: PortEntry = { ...(ports.entries.value[0] as PortEntry), port: 4444, pid: 777 };
    vi.spyOn(api, "listPorts").mockResolvedValueOnce([...ports.entries.value, fresh]);
    expect(await selectFromTray(ports, flow, { port: 4444, protocol: "tcp" })).toBe(true);
    expect(flow.confirm.value?.kind === "entry" && flow.confirm.value.entry.pid).toBe(777);
  });
});

describe("isTraySelectPayload", () => {
  it("accepts only a port number and a known protocol", () => {
    expect(isTraySelectPayload({ port: 3000, protocol: "tcp" })).toBe(true);
    expect(isTraySelectPayload({ port: 53, protocol: "udp" })).toBe(true);
    expect(isTraySelectPayload({ port: "3000", protocol: "tcp" })).toBe(false);
    expect(isTraySelectPayload({ port: 3000, protocol: "sctp" })).toBe(false);
    expect(isTraySelectPayload(null)).toBe(false);
    expect(isTraySelectPayload(3000)).toBe(false);
  });
});

describe("useTrayListener", () => {
  afterEach(() => {
    listen.mockReset();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("does nothing outside Tauri", async () => {
    const onSelect = vi.fn();
    const tray = useTrayListener(onSelect);
    await tray.start();
    expect(listen).not.toHaveBeenCalled();
    tray.stop();
  });

  it("listens once inside Tauri, validates the payload, and unlistens on stop", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    const onSelect = vi.fn();
    const tray = useTrayListener(onSelect);
    await tray.start();
    await tray.start();
    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen.mock.calls[0]?.[0]).toBe(TRAY_SELECT_PORT);

    const handler = listen.mock.calls[0]?.[1] as (event: { payload: unknown }) => void;
    vi.spyOn(console, "error").mockImplementation(() => {});
    handler({ payload: { port: 5432, protocol: "tcp" } });
    handler({ payload: { nope: true } });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith({ port: 5432, protocol: "tcp" });

    tray.stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("drops a listener that resolves after stop()", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const unlisten = vi.fn();
    let resolve: ((fn: typeof unlisten) => void) | undefined;
    listen.mockImplementation(() => new Promise((r) => (resolve = r)));
    const tray = useTrayListener(vi.fn());
    const started = tray.start();
    tray.stop();
    resolve?.(unlisten);
    await started;
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

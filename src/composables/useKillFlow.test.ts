import { describe, expect, it, vi } from "vitest";
import { createMockApi, MOCK_ENTRIES } from "../api/mock";
import type { KillOutcome, PortEntry } from "../types";
import { killMessage, reapMessage, useKillFlow } from "./useKillFlow";
import { type PortGroup, usePorts } from "./usePorts";
import { useTaskline } from "./useTaskline";
import { useToasts } from "./useToasts";

async function setup() {
  const api = createMockApi();
  const killProcess = vi.spyOn(api, "killProcess");
  const ports = usePorts(api, { storage: null });
  await ports.refresh();
  const toasts = useToasts();
  const flow = useKillFlow(ports, toasts);
  const byPort = (port: number) => ports.entries.value.find((e) => e.port === port) as PortEntry;
  const group = (name: string) => ports.groups.value.find((g) => g.name === name) as PortGroup;
  return { api, killProcess, ports, toasts, flow, byPort, group };
}

describe("useKillFlow", () => {
  it("kills an unprotected row at once and toasts the freed port", async () => {
    const { flow, killProcess, toasts, byPort } = await setup();
    await flow.request({ kind: "entry", entry: byPort(3000), force: false });
    expect(killProcess).toHaveBeenCalledWith({ pid: 48213, force: false });
    expect(flow.confirm.value).toBeNull();
    expect(toasts.toasts.value[0]?.message).toBe("Killed node (48213). Port 3000 is free.");
  });

  it("says so when the kill was forced", async () => {
    const { flow, killProcess, toasts, byPort } = await setup();
    await flow.request({ kind: "entry", entry: byPort(3000), force: true });
    expect(killProcess).toHaveBeenCalledWith({ pid: 48213, force: true });
    expect(toasts.toasts.value[0]?.message).toBe("Force-killed node (48213). Port 3000 is free.");

    const entry = { processName: "node", pid: 7, port: 3000 } as PortEntry;
    const killed = (graceful: boolean) =>
      killMessage({ entry, ports: [3000], outcome: { status: "killed", pid: 7, graceful, waitedMs: 0 } });
    expect(killed(false).message).toBe("Force-killed node (7). Port 3000 is free.");
    expect(killed(true).message).toBe("Killed node (7). Port 3000 is free.");
  });

  it("asks before killing a protected row, even with force", async () => {
    const { flow, killProcess, byPort } = await setup();
    await flow.request({ kind: "entry", entry: byPort(5432), force: true });
    expect(killProcess).not.toHaveBeenCalled();
    expect(flow.confirming.value).toBe(true);
    flow.cancel();
    expect(flow.confirm.value).toBeNull();
    expect(killProcess).not.toHaveBeenCalled();
  });

  it("kills the protected row on confirm and names every port it held", async () => {
    const { flow, killProcess, toasts, byPort } = await setup();
    await flow.request({ kind: "entry", entry: byPort(5432), force: true });
    await flow.confirmed();
    expect(killProcess).toHaveBeenCalledWith({ pid: 11710, force: true });
    expect(toasts.toasts.value[0]?.message).toBe(
      "Force-killed com.docker.backend (11710). Ports 5432 and 6379 are free.",
    );
  });

  it("asks for a group with any protected member and kills groups at once otherwise", async () => {
    const { flow, killProcess, group } = await setup();
    await flow.request({ kind: "group", group: group("redis:7"), force: false });
    expect(killProcess).not.toHaveBeenCalled();
    flow.cancel();
    await flow.request({ kind: "group", group: group("shop-api"), force: false });
    expect(killProcess).toHaveBeenCalledWith({ pid: 48213, force: false });
  });

  it("ignores a second click while the first kill is in flight", async () => {
    const { flow, killProcess, ports, byPort } = await setup();
    ports.pending.add(48213);
    await flow.request({ kind: "entry", entry: byPort(3000), force: false });
    expect(killProcess).not.toHaveBeenCalled();
  });

  it("carries the reason on refused, failed and transport", async () => {
    const entry = { processName: "node", pid: 7, port: 3000 } as PortEntry;
    expect(
      killMessage({ entry, ports: [3000], outcome: { status: "refused", pid: 7, reason: "launchd" } }),
    ).toEqual({
      message: "Did not kill node (7): launchd.",
      kind: "error",
    });
    expect(
      killMessage({ entry, ports: [3000], outcome: { status: "failed", pid: 7, error: "EPERM" } }),
    ).toEqual({
      message: "Could not kill node (7): EPERM.",
      kind: "error",
    });
    expect(
      killMessage({ entry, ports: [3000], outcome: { status: "transport", pid: 7, error: "x" } }),
    ).toEqual({
      message: "Could not reach the core.",
      kind: "error",
    });
    expect(killMessage({ entry, ports: [3000], outcome: { status: "notFound", pid: 7 } })).toEqual({
      message: "node (7) is already gone.",
      kind: "info",
    });
  });
});

describe("useKillFlow: reap and restart (v0.2)", () => {
  async function setupWithTaskline(api = createMockApi()) {
    const killProcess = vi.spyOn(api, "killProcess");
    const ports = usePorts(api, { storage: null });
    await ports.refresh();
    const toasts = useToasts();
    const taskline = useTaskline(api, toasts, { subscribe: () => () => {} });
    const flow = useKillFlow(ports, toasts, taskline);
    const byPort = (port: number) => ports.entries.value.find((e) => e.port === port) as PortEntry;
    return { api, killProcess, ports, toasts, taskline, flow, byPort };
  }

  it("reaps two zombies at once and sums what came back", async () => {
    const { flow, ports, toasts, api } = await setupWithTaskline();
    const reapZombies = vi.spyOn(api, "reapZombies");
    await flow.reap();
    expect(reapZombies).toHaveBeenCalledTimes(1);
    expect(flow.confirm.value).toBeNull();
    expect(ports.counts.value.zombie).toBe(0);
    expect(toasts.toasts.value[0]?.message).toBe("Reaped 2 zombies, 640 MB back.");
  });

  it("asks once above three zombies", async () => {
    const base = MOCK_ENTRIES.find((e) => e.port === 5174) as PortEntry;
    const many = [4001, 4002, 4003, 4004].map((port, i) => ({ ...base, port, pid: 70000 + i }));
    const { flow, api } = await setupWithTaskline(createMockApi([...MOCK_ENTRIES, ...many]));
    const reapZombies = vi.spyOn(api, "reapZombies");
    await flow.reap();
    expect(reapZombies).not.toHaveBeenCalled();
    expect(flow.confirm.value).toEqual({
      kind: "zombies",
      count: 6,
      memoryBytes: (220 * 5 + 420) * 1024 * 1024,
    });
    await flow.confirmed();
    expect(reapZombies).toHaveBeenCalledTimes(1);
  });

  it("words the reap summary", () => {
    const outcomes: KillOutcome[] = [];
    expect(reapMessage({ outcomes, freed: 0, refused: 0, memoryBytes: 0 })).toEqual({
      message: "No zombies to reap.",
      kind: "info",
    });
    expect(reapMessage({ outcomes, freed: 1, refused: 1, memoryBytes: 220 * 1024 * 1024 })).toEqual({
      message: "Reaped 1 zombie, 220 MB back; 1 refused.",
      kind: "error",
    });
    expect(reapMessage({ outcomes, freed: 0, refused: 2, memoryBytes: 0 })).toEqual({
      message: "Reaped nothing; 2 refused.",
      kind: "error",
    });
  });

  it("restart kills gracefully, relaunches what the core recorded, and brings the row back with a new pid", async () => {
    const { flow, killProcess, ports, taskline, byPort } = await setupWithTaskline();
    const outcome = await flow.restart(byPort(3000));
    expect(killProcess).toHaveBeenCalledWith({ pid: 48213, force: false });
    expect(outcome.status).toBe("started");
    const pid = outcome.status === "started" ? outcome.pid : -1;
    expect(flow.restarting.value).toEqual({ phase: "started", pid: 48213, newPid: pid });
    expect(ports.entries.value.find((e) => e.port === 3000)?.pid).toBe(pid);
    expect(taskline.events.value.map((e) => e.kind)).toEqual(["relaunched", "portFreed"]);
    flow.clearRestart();
    expect(flow.restarting.value).toBeNull();
  });

  it("restart reports a relaunch failure and leaves the row gone", async () => {
    const { flow, api, ports, byPort } = await setupWithTaskline();
    vi.spyOn(api, "relaunch").mockResolvedValueOnce({ status: "failed", eventId: 1, error: "ENOENT" });
    const outcome = await flow.restart(byPort(5173));
    expect(outcome).toEqual({ status: "failed", error: "ENOENT" });
    expect(flow.restarting.value).toEqual({ phase: "failed", pid: 51022, error: "ENOENT" });
    expect(ports.entries.value.some((e) => e.port === 5173)).toBe(false);
  });

  it("restart stops at a kill that did not happen, and refuses protected rows", async () => {
    const { flow, api, byPort } = await setupWithTaskline();
    vi.spyOn(api, "killProcess").mockResolvedValueOnce({ status: "refused", pid: 51022, reason: "EPERM" });
    const refused = await flow.restart(byPort(5173));
    expect(refused).toEqual({ status: "failed", error: "Did not kill node (51022): EPERM." });
    const docker = await flow.restart(byPort(5432));
    expect(docker.status).toBe("failed");
    expect(api.killProcess).toHaveBeenCalledTimes(1);
    const noTaskline = useKillFlow(usePorts(api, { storage: null }), useToasts());
    expect((await noTaskline.restart(byPort(5173))).status).toBe("failed");
  });
});

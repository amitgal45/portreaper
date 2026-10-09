import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "../api/mock";
import type { PortEntry } from "../types";
import { killMessage, useKillFlow } from "./useKillFlow";
import { type PortGroup, usePorts } from "./usePorts";
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

import { describe, expect, it } from "vitest";
import { createMockApi, MOCK_ENTRIES } from "./mock";

describe("mock api", () => {
  it("lists a believable machine", async () => {
    const api = createMockApi();
    const entries = await api.listPorts();
    expect(entries.length).toBe(MOCK_ENTRIES.length);
    expect(entries.find((e) => e.port === 3000)?.project?.branch).toBe("feature/cart");
  });

  it("a killed pid disappears on the next list", async () => {
    const api = createMockApi();
    const outcome = await api.killProcess({ pid: 48213, force: false });
    expect(outcome.status).toBe("killed");
    expect((await api.listPorts()).some((e) => e.pid === 48213)).toBe(false);
  });

  it("freeing a port kills each pid once", async () => {
    const api = createMockApi();
    const outcomes = await api.freePort(5432, false);
    expect(outcomes).toHaveLength(1);
    expect((await api.listPorts()).some((e) => e.port === 6379)).toBe(false);
  });

  it("does not mutate the seed", async () => {
    const api = createMockApi();
    await api.killProcess({ pid: 51022, force: true });
    expect(MOCK_ENTRIES.some((e) => e.pid === 51022)).toBe(true);
  });
});

describe("mock api v0.2", () => {
  it("classifies the taxonomy and carries the two v0.2 entries", async () => {
    const api = createMockApi();
    const entries = await api.listPorts();
    const byPort = (port: number) => entries.find((e) => e.port === port);
    expect(byPort(3000)?.category).toBe("web");
    expect(byPort(3000)?.framework).toBe("Next.js");
    expect(byPort(5432)?.category).toBe("db");
    expect(byPort(11434)).toMatchObject({ category: "ai", framework: "Ollama", cwd: "/Users/amit" });
    expect(byPort(4000)).toMatchObject({ category: "api", framework: "Jekyll", orphan: true });
    expect(byPort(4000)?.project?.name).toBe("legacy-docs");
  });

  it("knows the ancestry of a process, launchd first", async () => {
    const api = createMockApi();
    expect((await api.processTree(48213)).map((n) => n.name)).toEqual(["launchd", "iTerm2", "zsh", "node"]);
    expect((await api.processTree(39871)).map((n) => n.pid)).toEqual([1, 39871]);
    expect(await api.processTree(1)).toEqual([]);
  });

  it("records a kill in the Taskline and relaunches it with a new pid", async () => {
    const api = createMockApi();
    await api.killProcess({ pid: 48213, force: false });
    const [event] = await api.tasklineEvents();
    expect(event).toMatchObject({
      kind: "portFreed",
      port: 3000,
      pid: 48213,
      project: "shop-api",
      relaunchable: true,
    });
    const outcome = await api.relaunch(event?.id ?? -1);
    expect(outcome.status).toBe("started");
    const back = (await api.listPorts()).find((e) => e.port === 3000);
    expect(back?.pid).toBe(outcome.status === "started" ? outcome.pid : -1);
    expect((await api.tasklineEvents())[0]?.kind).toBe("relaunched");
    expect(await api.relaunch(999)).toEqual({ status: "notFound", eventId: 999 });
    await api.clearTaskline();
    expect(await api.tasklineEvents()).toEqual([]);
  });

  it("reaps the unprotected orphans and nothing else", async () => {
    const api = createMockApi();
    const outcomes = await api.reapZombies();
    expect(outcomes.map((o) => o.pid)).toEqual([39871]);
    expect((await api.listPorts()).some((e) => e.orphan && !e.protected)).toBe(false);
    expect((await api.listPorts()).some((e) => e.pid === 18402)).toBe(true);
    expect((await api.tasklineEvents()).map((e) => e.kind)).toEqual(["zombieReaped"]);
  });
});

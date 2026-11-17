import { describe, expect, it } from "vitest";
import { MAX_HIDDEN_PORTS } from "../types";
import { createMockApi, MOCK_ENTRIES, MOCK_STDIO_ZOMBIES } from "./mock";

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
    // The mock's two zombies, plus a protected orphan that Reap must leave alone.
    const jekyll = MOCK_ENTRIES.find((e) => e.port === 4000);
    if (!jekyll) throw new Error("mock changed");
    const guarded = { ...jekyll, port: 4001, pid: 18403, protected: true };
    const api = createMockApi([...MOCK_ENTRIES, guarded]);
    const outcomes = await api.reapZombies();
    expect(outcomes.map((o) => o.pid)).toEqual([39871, 18402]);
    const left = await api.listPorts();
    expect(left.some((e) => e.orphan && !e.protected)).toBe(false);
    expect(left.some((e) => e.pid === 39871 || e.pid === 18402)).toBe(false);
    expect(left.some((e) => e.pid === 18403)).toBe(true);
    expect((await api.tasklineEvents()).map((e) => e.kind)).toEqual(["zombieReaped", "zombieReaped"]);
  });
});

describe("mock api: launchd jobs", () => {
  it("runs Ollama as a brew service: launchd's child on purpose, protected, and never reaped", async () => {
    const api = createMockApi();
    const ollama = (await api.listPorts()).find((e) => e.port === 11434);
    expect(ollama).toMatchObject({
      pid: 32014,
      parentPid: 1,
      orphan: false,
      protected: true,
      launchd: {
        label: "homebrew.mxcl.ollama",
        restarts: true,
        brew: "ollama",
        stopCommand: "brew services stop ollama",
      },
    });
    // No other row is a launchd job.
    expect(MOCK_ENTRIES.filter((e) => e.launchd !== null).map((e) => e.port)).toEqual([11434]);

    const outcomes = await api.reapZombies();
    expect(outcomes.map((o) => o.pid)).toEqual([39871, 18402]);
    expect((await api.listPorts()).some((e) => e.pid === 32014)).toBe(true);
    expect((await api.tasklineEvents()).some((e) => e.pid === 32014)).toBe(false);
  });
});

describe("mock api v0.3", () => {
  it("names one container on its own port, and stops it without touching the other Docker rows", async () => {
    expect(MOCK_ENTRIES.filter((e) => e.container !== null).map((e) => e.port)).toEqual([5433]);
    const api = createMockApi();
    const shopDb = (await api.listPorts()).find((e) => e.port === 5433);
    expect(shopDb).toMatchObject({
      container: "shop-db",
      processName: "com.docker.backend",
      category: "db",
      framework: "PostgreSQL 16",
      protected: true,
      bind: "loopback",
      project: { name: "postgres:16", root: "", tool: "docker" },
    });

    const outcome = await api.killProcess({ pid: shopDb?.pid ?? -1, force: false });
    expect(outcome).toEqual({ status: "killed", pid: 11712, graceful: true, waitedMs: 180 });
    const left = await api.listPorts();
    expect(left.some((e) => e.port === 5433)).toBe(false);
    expect(left.filter((e) => e.processName === "com.docker.backend").map((e) => e.port)).toEqual([
      5432, 6379,
    ]);
    const [event] = await api.tasklineEvents();
    expect(event).toMatchObject({
      kind: "portFreed",
      port: 5433,
      pid: 11712,
      project: "postgres:16",
      message: "Stopped container shop-db. Port 5433 is free.",
      relaunchable: false,
    });
    expect(await api.relaunch(event?.id ?? -1)).toMatchObject({ status: "failed" });

    const forced = createMockApi();
    await forced.killProcess({ pid: 11712, force: true });
    expect((await forced.tasklineEvents())[0]).toMatchObject({
      kind: "forceKilled",
      message: "Killed container shop-db. Port 5433 is free.",
    });
  });
});

describe("mock api: protection is by pid", () => {
  it("a pid protected on one socket is protected on all of them, a hidden one included, and Reap spares it", async () => {
    const jekyll = MOCK_ENTRIES.find((e) => e.port === 4000);
    if (!jekyll) throw new Error("mock changed");
    const pid = jekyll.pid;
    // The Jekyll's pid also holds a database port: the port protects that socket alone.
    const api = createMockApi([...MOCK_ENTRIES, { ...jekyll, port: 5432, protected: true }]);
    const rows = async () => {
      const mine = (await api.listPorts()).filter((e) => e.pid === pid);
      return mine.map((e) => `:${e.port} ${e.protected ? "protected" : "open"}`);
    };
    expect(await rows()).toEqual([":4000 protected", ":5432 protected"]);
    // Nobody else's protection spreads, and the seed is left as it was.
    expect((await api.listPorts()).find((e) => e.port === 3000)?.protected).toBe(false);
    expect(jekyll.protected).toBe(false);

    // Hidden, the protected socket still protects the one the user sees: Reap spares the pid.
    await api.setSettings({ ...(await api.getSettings()), hiddenPorts: [5432] });
    expect(await rows()).toEqual([":4000 protected"]);
    expect((await api.reapZombies()).map((o) => o.pid)).toEqual([39871]);
    expect(await rows()).toEqual([":4000 protected"]);
    // Killed on purpose, it is not offered for a relaunch: the core never brings a protected pid back.
    await api.killProcess({ pid, force: false });
    expect((await api.tasklineEvents())[0]).toMatchObject({ pid, relaunchable: false });
  });
});

describe("mock api: hidden ports", () => {
  it("leaves a hidden port out of the list by number and keeps the stdio entries; unhidden, it is back", async () => {
    const api = createMockApi([...MOCK_ENTRIES, ...MOCK_STDIO_ZOMBIES]);
    const all = await api.listPorts();
    expect((await api.getSettings()).hiddenPorts).toEqual([]);

    // 0, a duplicate, a number out of range and a fraction: the mock normalizes like the core.
    const saved = await api.setSettings({
      ...(await api.getSettings()),
      hiddenPorts: [7000, 5173, 0, 5173, 70_000, 1.5],
    });
    expect(saved.hiddenPorts).toEqual([5173, 7000]);
    expect((await api.getSettings()).hiddenPorts).toEqual([5173, 7000]);

    const shown = await api.listPorts();
    expect(shown.some((e) => e.port === 5173 || e.port === 7000)).toBe(false);
    expect(shown).toHaveLength(all.length - 2);
    expect(shown.filter((e) => e.port === 0).map((e) => e.pid)).toEqual([74910, 74911]);

    await api.setSettings({ ...(await api.getSettings()), hiddenPorts: [] });
    expect(await api.listPorts()).toEqual(all);
  });

  it("keeps at most MAX_HIDDEN_PORTS, the lowest, and hands out a copy", async () => {
    const api = createMockApi();
    const seventy = Array.from({ length: 70 }, (_, i) => 70 - i);
    const saved = await api.setSettings({ ...(await api.getSettings()), hiddenPorts: seventy });
    expect(saved.hiddenPorts).toEqual(Array.from({ length: MAX_HIDDEN_PORTS }, (_, i) => i + 1));

    saved.hiddenPorts.push(3000);
    (await api.getSettings()).hiddenPorts.push(3000);
    expect((await api.getSettings()).hiddenPorts).toHaveLength(MAX_HIDDEN_PORTS);
    expect((await api.listPorts()).some((e) => e.port === 3000)).toBe(true);
  });

  it("reaps around a hidden zombie and leaves it running", async () => {
    const api = createMockApi();
    await api.setSettings({ ...(await api.getSettings()), hiddenPorts: [5174] });
    const outcomes = await api.reapZombies();
    expect(outcomes.map((o) => o.pid)).toEqual([18402]);
    expect((await api.tasklineEvents()).map((e) => e.port)).toEqual([4000]);

    await api.setSettings({ ...(await api.getSettings()), hiddenPorts: [] });
    const left = await api.listPorts();
    expect(left.find((e) => e.port === 5174)).toMatchObject({ pid: 39871, orphan: true });
    expect(left.some((e) => e.pid === 18402)).toBe(false);
  });

  it("leaves a hidden port out of the watches and keeps the watch for when it is shown again", async () => {
    const api = createMockApi();
    await api.watchPort(3000, "tcp");
    await api.watchPort(5173, "tcp");
    await api.setSettings({ ...(await api.getSettings()), hiddenPorts: [5173] });
    expect((await api.watchedPorts()).map((w) => w.port)).toEqual([3000]);
    expect((await api.watchPort(8080, "tcp")).map((w) => w.port)).toEqual([3000, 8080]);

    await api.setSettings({ ...(await api.getSettings()), hiddenPorts: [] });
    expect((await api.watchedPorts()).map((w) => w.port)).toEqual([3000, 5173, 8080]);
  });
});

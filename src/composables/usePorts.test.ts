import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { createMockApi, MOCK_ENTRIES } from "../api/mock";
import type { KillOutcome, PortApi, PortEntry } from "../types";
import { entryKey, groupEntries, matchesCategory, memoryOf, usePorts } from "./usePorts";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A store that is loaded and not polling. */
async function loadedStore(api: PortApi = createMockApi()) {
  const store = usePorts(api, { storage: null });
  await store.refresh();
  return store;
}

describe("usePorts: loading and polling", () => {
  let visible = true;
  beforeEach(() => {
    visible = true;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads on start and shows the version", async () => {
    const api = createMockApi();
    const store = usePorts(api, { storage: null });
    expect(store.loaded.value).toBe(false);
    store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.loaded.value).toBe(true);
    expect(store.entries.value).toHaveLength(MOCK_ENTRIES.length);
    expect(store.version.value).toBe("0.2.0-mock");
    expect(store.lastRefresh.value).not.toBeNull();
    store.stop();
  });

  it("polls every tick while visible and pauses when hidden", async () => {
    const api = createMockApi();
    const listPorts = vi.spyOn(api, "listPorts");
    const store = usePorts(api, { storage: null, intervalMs: 2000, isVisible: () => visible });
    store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(listPorts).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(listPorts).toHaveBeenCalledTimes(2);

    visible = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(6000);
    expect(listPorts).toHaveBeenCalledTimes(2);

    visible = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(listPorts).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2000);
    expect(listPorts).toHaveBeenCalledTimes(4);

    store.stop();
    await vi.advanceTimersByTimeAsync(4000);
    expect(listPorts).toHaveBeenCalledTimes(4);
  });

  it("re-arms the timer when the interval changes, and leaves a stopped poller alone", async () => {
    const api = createMockApi();
    const listPorts = vi.spyOn(api, "listPorts");
    const intervalMs = ref(2000);
    const store = usePorts(api, { storage: null, intervalMs, isVisible: () => true });
    store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(listPorts).toHaveBeenCalledTimes(1);

    intervalMs.value = 500;
    await nextTick();
    await vi.advanceTimersByTimeAsync(1000);
    expect(listPorts).toHaveBeenCalledTimes(3);

    intervalMs.value = 5000;
    await nextTick();
    await vi.advanceTimersByTimeAsync(4000);
    expect(listPorts).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(listPorts).toHaveBeenCalledTimes(4);

    store.stop();
    intervalMs.value = 100;
    await nextTick();
    await vi.advanceTimersByTimeAsync(1000);
    expect(listPorts).toHaveBeenCalledTimes(4);
  });

  it("keeps the last list and reports the error when a poll fails", async () => {
    const api = createMockApi();
    const store = usePorts(api, { storage: null, isVisible: () => true });
    store.start();
    await vi.advanceTimersByTimeAsync(0);
    const before = store.entries.value.length;
    vi.spyOn(api, "listPorts").mockRejectedValueOnce(new Error("core went away"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.error.value).toBe("core went away");
    expect(store.entries.value).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.error.value).toBeNull();
    store.stop();
  });
});

describe("usePorts: search", () => {
  it("matches a port by prefix", async () => {
    const store = await loadedStore();
    store.query.value = "51";
    await nextTick();
    expect(store.visibleEntries.value.map((e) => e.port)).toEqual([5173, 5174]);
    store.query.value = "3000";
    await nextTick();
    expect(store.visibleEntries.value.map((e) => e.port)).toEqual([3000]);
  });

  it("matches process name, project, branch and command, case-insensitively", async () => {
    const store = await loadedStore();
    const ports = () => store.visibleEntries.value.map((e) => e.port);
    store.query.value = "Docker";
    await nextTick();
    expect(ports()).toEqual([5432, 6379]);
    store.query.value = "shop";
    await nextTick();
    expect(ports()).toEqual([3000]);
    store.query.value = "TR-120";
    await nextTick();
    expect(ports()).toEqual([5174]);
    store.query.value = "dist/main";
    await nextTick();
    expect(ports()).toEqual([8080]);
    store.query.value = "nothing here";
    await nextTick();
    expect(ports()).toEqual([]);
  });

  it("selects the first match so Enter has a target, and nothing when cleared", async () => {
    const store = await loadedStore();
    expect(store.selected.value).toBeNull();
    store.query.value = "3";
    await nextTick();
    expect(store.selected.value?.port).toBe(3000);
    store.clearSearch();
    await nextTick();
    expect(store.selected.value).toBeNull();
  });
});

describe("usePorts: grouping and order", () => {
  it("groups by project name, else process name, dev servers first and protected last", async () => {
    const store = await loadedStore();
    const names = store.groups.value.map((g) => g.name);
    expect(names).toEqual([
      "shop-api",
      "legacy-docs",
      "portreaper",
      "tinyrecipe-lp",
      "@specmate/api",
      "chrome-helper",
      "ollama",
      "mDNSResponder",
      "postgres:16",
      "redis:7",
      "ControlCenter",
    ]);
    const protectedFlags = store.groups.value.map((g) => g.protected);
    expect(protectedFlags).toEqual([false, false, false, false, false, false, false, true, true, true, true]);
  });

  it("sorts inside a group by port and lists distinct pids", () => {
    const base = MOCK_ENTRIES[0] as PortEntry;
    const same = (port: number, pid: number): PortEntry => ({ ...base, port, pid });
    const [group] = groupEntries([same(3002, 1), same(3000, 2), same(3001, 2)]);
    expect(group?.entries.map((e) => e.port)).toEqual([3000, 3001, 3002]);
    expect(group?.pids).toEqual([2, 1]);
    expect(group?.branch).toBe("feature/cart");
  });

  it("drops branch and tool from the header when the group disagrees", () => {
    const base = MOCK_ENTRIES[0] as PortEntry;
    const project = base.project as NonNullable<PortEntry["project"]>;
    const [group] = groupEntries([
      base,
      { ...base, port: 3001, pid: 2, project: { ...project, branch: "main", root: "/elsewhere" } },
    ]);
    expect(group?.branch).toBeNull();
    expect(group?.root).toBeNull();
    expect(group?.tool).toBe("next");
  });

  it("does not merge a project named like a process with that process", () => {
    const base = MOCK_ENTRIES[0] as PortEntry;
    const project = base.project as NonNullable<PortEntry["project"]>;
    const groups = groupEntries([
      { ...base, project: { ...project, name: "node" } },
      { ...base, port: 4000, pid: 9, project: null },
    ]);
    expect(groups).toHaveLength(2);
  });

  it("remembers collapsed groups in storage and skips them for selection", async () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => void memory.set(k, v),
    } as unknown as Storage;
    const store = usePorts(createMockApi(), { storage });
    await store.refresh();
    store.toggleGroup("p:shop-api");
    expect(store.visibleEntries.value[0]?.port).toBe(4000);
    expect(memory.get("portreaper.collapsed")).toBe(JSON.stringify(["p:shop-api"]));

    const again = usePorts(createMockApi(), { storage });
    expect(again.collapsed.has("p:shop-api")).toBe(true);
  });
});

describe("usePorts: selection", () => {
  it("moves with clamping and starts from the ends", async () => {
    const store = await loadedStore();
    const list = store.visibleEntries.value;
    store.selectNext();
    expect(store.selected.value).toBe(list[0]);
    store.selectPrev();
    expect(store.selected.value).toBe(list[0]);
    for (let i = 0; i < 50; i++) store.selectNext();
    expect(store.selected.value).toBe(list[list.length - 1]);
    store.clearSelection();
    store.selectPrev();
    expect(store.selected.value).toBe(list[list.length - 1]);
  });

  it("slides to the neighbour when the selected row disappears", async () => {
    const store = await loadedStore();
    const [first, second] = store.visibleEntries.value;
    store.select(first as PortEntry);
    await store.kill(first as PortEntry);
    await nextTick();
    expect(store.selected.value).toBe(second);
    expect(store.selectedKey.value).toBe(entryKey(second as PortEntry));
  });
});

describe("usePorts: kill", () => {
  it("removes every row of the pid before the next poll, and the next poll agrees", async () => {
    const api = createMockApi();
    const store = await loadedStore(api);
    const docker = store.entries.value.find((e) => e.port === 5432) as PortEntry;
    const report = await store.kill(docker);
    expect(report.outcome.status).toBe("killed");
    expect(report.ports).toEqual([5432, 6379]);
    expect(store.entries.value.some((e) => e.pid === docker.pid)).toBe(false);
    await store.refresh();
    expect(store.entries.value.some((e) => e.pid === docker.pid)).toBe(false);
  });

  it("shows the spinner during the call and passes force through", async () => {
    const api = createMockApi();
    let resolve: ((o: KillOutcome) => void) | undefined;
    const killProcess = vi
      .spyOn(api, "killProcess")
      .mockImplementation(() => new Promise<KillOutcome>((r) => (resolve = r)));
    const store = await loadedStore(api);
    const entry = store.entries.value[0] as PortEntry;
    const done = store.kill(entry, true);
    expect(store.pending.has(entry.pid)).toBe(true);
    expect(killProcess).toHaveBeenCalledWith({ pid: entry.pid, force: true });
    resolve?.({ status: "killed", pid: entry.pid, graceful: false, waitedMs: 0 });
    await done;
    expect(store.pending.has(entry.pid)).toBe(false);
  });

  it("keeps the row on failed, refused and notFound", async () => {
    const api = createMockApi();
    const store = await loadedStore(api);
    const entry = store.entries.value[0] as PortEntry;
    const outcomes: KillOutcome[] = [
      { status: "failed", pid: entry.pid, error: "EPERM" },
      { status: "refused", pid: entry.pid, reason: "launchd" },
      { status: "notFound", pid: entry.pid },
    ];
    for (const outcome of outcomes) {
      vi.spyOn(api, "killProcess").mockResolvedValueOnce(outcome);
      const report = await store.kill(entry);
      expect(report.outcome).toEqual(outcome);
      expect(store.entries.value.some((e) => e.pid === entry.pid)).toBe(true);
      expect(store.pending.has(entry.pid)).toBe(false);
    }
  });

  it("restores the row when the transport fails", async () => {
    const api = createMockApi();
    vi.spyOn(api, "killProcess").mockRejectedValueOnce(new Error("ipc down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = await loadedStore(api);
    const entry = store.entries.value[0] as PortEntry;
    const report = await store.kill(entry);
    expect(report.outcome).toEqual({ status: "transport", pid: entry.pid, error: "ipc down" });
    expect(store.entries.value.some((e) => e.pid === entry.pid)).toBe(true);
  });

  it("hides a killed pid even when a stale poll still lists it", async () => {
    const api = createMockApi();
    const store = await loadedStore(api);
    const entry = store.entries.value[0] as PortEntry;
    const stale = await api.listPorts();
    await store.kill(entry);
    vi.spyOn(api, "listPorts").mockResolvedValueOnce(stale);
    await store.refresh();
    expect(store.entries.value.some((e) => e.pid === entry.pid)).toBe(false);
  });

  it("killGroup kills once per distinct pid", async () => {
    const api = createMockApi();
    const killProcess = vi.spyOn(api, "killProcess");
    const store = await loadedStore(api);
    const docker = store.groups.value.find((g) => g.name === "postgres:16");
    const specmate = store.groups.value.find((g) => g.name === "@specmate/api");
    if (!docker || !specmate) throw new Error("mock changed");
    const reports = await store.killGroup(docker);
    expect(reports).toHaveLength(1);
    expect(killProcess).toHaveBeenCalledTimes(1);
    expect(killProcess).toHaveBeenCalledWith({ pid: 11710, force: false });
    await store.killGroup(specmate, true);
    expect(killProcess).toHaveBeenLastCalledWith({ pid: 22104, force: true });
    await flush();
    expect(store.entries.value.some((e) => e.port === 6379 || e.port === 8080)).toBe(false);
  });

  it("names the reason for a protected row", async () => {
    const store = await loadedStore();
    const byPort = (port: number) => store.entries.value.find((e) => e.port === port) as PortEntry;
    expect(store.reasonFor(byPort(5432))).toBe("Docker");
    expect(store.reasonFor(byPort(7000))).toBe("a system process");
    expect(store.currentUser.value).toBe("amit");
  });
});

describe("usePorts: categories (v0.2)", () => {
  it("counts the pills over the whole list and sums memory once per pid", async () => {
    const store = await loadedStore();
    expect(store.counts.value).toEqual({ all: 11, dev: 5, ai: 1, db: 2, zombie: 2, public: 3 });
    // web + api + ai: 412 + 180 + 220 + 610 + 420 MB and Ollama's 4.85 GB.
    expect(Math.round(store.devMemoryBytes.value / (1024 * 1024))).toBe(1842 + Math.round(4.85 * 1024));
    // The two lost-terminal servers: tinyrecipe-lp's 220 MB and the Jekyll's 420 MB.
    expect(store.zombieMemoryBytes.value).toBe(640 * 1024 * 1024);
    expect(store.projectCount.value).toBe(7);
    // The docker pid holds two ports: it counts once for memory, twice for the db pill.
    const docker = store.entries.value.filter((e) => e.pid === 11710);
    expect(docker).toHaveLength(2);
    expect(memoryOf(docker, () => true)).toBe(1200 * 1024 * 1024);
  });

  it("filters the list by pill, on top of the search, and keeps the order", async () => {
    const store = await loadedStore();
    const ports = () => store.visibleEntries.value.map((e) => e.port);
    store.setCategory("zombie");
    await nextTick();
    expect(ports()).toEqual([4000, 5174]);
    store.setCategory("public");
    await nextTick();
    expect(ports()).toEqual([8080, 5432, 6379]);
    store.setCategory("ai");
    await nextTick();
    expect(ports()).toEqual([11434]);
    store.setCategory("db");
    await nextTick();
    expect(ports()).toEqual([5432, 6379]);
    store.setCategory("dev");
    await nextTick();
    // Group order as today: the user's projects by first port, the Jekyll's legacy-docs among them.
    expect(ports()).toEqual([3000, 4000, 5173, 5174, 8080]);
    store.query.value = "vite";
    await nextTick();
    expect(ports()).toEqual([5173, 5174]);
    expect(store.counts.value.dev).toBe(5);
    store.toggleCategory("dev");
    await nextTick();
    expect(store.category.value).toBe("all");
    store.toggleCategory("db");
    expect(store.category.value).toBe("db");
  });

  it("names the categories from the data", () => {
    const base = MOCK_ENTRIES[0] as PortEntry;
    const e = (over: Partial<PortEntry>): PortEntry => ({ ...base, ...over });
    expect(matchesCategory(e({ category: "api" }), "dev")).toBe(true);
    expect(matchesCategory(e({ category: "other" }), "dev")).toBe(false);
    expect(matchesCategory(e({ orphan: true, protected: true }), "zombie")).toBe(false);
    expect(matchesCategory(e({ bind: "any", category: "system" }), "public")).toBe(false);
    expect(matchesCategory(e({ bind: "any", category: "db" }), "public")).toBe(true);
    expect(matchesCategory(e({ bind: "other" }), "public")).toBe(false);
  });

  it("reaps the zombies, removes them at once, and reports what came back", async () => {
    const api = createMockApi();
    const reapZombies = vi.spyOn(api, "reapZombies");
    const store = await loadedStore(api);
    const report = await store.reapZombies();
    expect(reapZombies).toHaveBeenCalledTimes(1);
    expect(report.freed).toBe(2);
    expect(report.refused).toBe(0);
    expect(report.memoryBytes).toBe(640 * 1024 * 1024);
    expect(store.entries.value.some((e) => e.orphan && !e.protected)).toBe(false);
    expect(store.counts.value.zombie).toBe(0);
    await store.refresh();
    expect(store.entries.value).toHaveLength(9);
  });

  it("counts a refusal and keeps that row", async () => {
    const api = createMockApi();
    vi.spyOn(api, "reapZombies").mockResolvedValueOnce([
      { status: "killed", pid: 39871, graceful: true, waitedMs: 10 },
      { status: "refused", pid: 18402, reason: "EPERM" },
    ]);
    const store = await loadedStore(api);
    const report = await store.reapZombies();
    expect(report).toMatchObject({ freed: 1, refused: 1, memoryBytes: 220 * 1024 * 1024 });
    expect(store.entries.value.some((e) => e.pid === 18402)).toBe(true);
    expect(store.entries.value.some((e) => e.pid === 39871)).toBe(false);
    expect(store.pending.size).toBe(0);
  });

  it("measures the round-trip of the last scan", async () => {
    const store = usePorts(createMockApi(), { storage: null });
    expect(store.scanMs.value).toBeNull();
    await store.refresh();
    expect(store.scanMs.value).toBeGreaterThanOrEqual(0);
    expect(store.scanMs.value).toBeLessThan(1000);
  });
});

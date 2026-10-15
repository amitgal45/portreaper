import { describe, expect, it } from "vitest";
import { MOCK_ENTRIES } from "../api/mock";
import type { PortEntry, TasklineEvent } from "../types";
import { collisionPorts, isNumericQuery, isZombie, preselect, quickKey, rankMatches, recents } from "./match";

const base: PortEntry = {
  port: 0,
  protocol: "tcp",
  bind: "loopback",
  address: "127.0.0.1",
  pid: 0,
  processName: "node",
  command: "node",
  cwd: null,
  exe: null,
  user: "amit",
  memoryBytes: 0,
  startedAt: 1_000,
  parentPid: 900,
  orphan: false,
  project: null,
  protected: false,
  category: "other",
  framework: null,
};

const entry = (partial: Partial<PortEntry>): PortEntry => ({ ...base, ...partial });

describe("rankMatches", () => {
  it("ranks an exact port before a prefix, before an exact pid, before a name match", () => {
    const entries = [
      entry({ port: 8000, pid: 1, processName: "x30y" }),
      entry({ port: 3001, pid: 2 }),
      entry({ port: 9000, pid: 30 }),
      entry({ port: 3000, pid: 3 }),
      entry({ port: 30, pid: 4 }),
      entry({
        port: 7000,
        pid: 5,
        project: { name: "app", root: "/a", kind: "node", branch: "fix/30-things", tool: null },
      }),
    ];
    expect(rankMatches(entries, "30").map((e) => e.port)).toEqual([30, 3000, 3001, 9000, 7000, 8000]);
  });

  it("matches process name, project, branch and command, case-insensitively, and trims", () => {
    const ports = (q: string) => rankMatches(MOCK_ENTRIES, q).map((e) => e.port);
    expect(ports("Docker")).toEqual([5432, 6379]);
    expect(ports("  shop ")).toEqual([3000]);
    expect(ports("TR-120")).toEqual([5174]);
    expect(ports("dist/main")).toEqual([8080]);
    expect(ports("48213")).toEqual([3000]);
    expect(ports("nothing here")).toEqual([]);
  });

  it("caps the list at the limit", () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry({ port: 3000 + i, pid: 100 + i }));
    expect(rankMatches(entries, "3")).toHaveLength(6);
    expect(rankMatches(entries, "3", 2).map((e) => e.port)).toEqual([3000, 3001]);
  });

  it("falls back to recents for an empty or blank query", () => {
    expect(rankMatches(MOCK_ENTRIES, "")).toEqual(recents(MOCK_ENTRIES));
    expect(rankMatches(MOCK_ENTRIES, "   ")).toEqual(recents(MOCK_ENTRIES));
  });
});

describe("recents", () => {
  it("shows the newest non-protected entries first, unknown start times last", () => {
    const entries = [
      entry({ port: 1, pid: 1, startedAt: 10 }),
      entry({ port: 2, pid: 2, startedAt: 30, protected: true }),
      entry({ port: 3, pid: 3, startedAt: null }),
      entry({ port: 4, pid: 4, startedAt: 20 }),
      entry({ port: 5, pid: 5, startedAt: 20 }),
    ];
    expect(recents(entries).map((e) => e.port)).toEqual([4, 5, 1, 3]);
  });

  it("on the mock: the unprotected entries newest first, six of the seven", () => {
    expect(recents(MOCK_ENTRIES).map((e) => e.port)).toEqual([5173, 3000, 8080, 5174, 9335, 4000]);
    expect(recents(MOCK_ENTRIES, 2).map((e) => e.port)).toEqual([5173, 3000]);
    expect(recents(MOCK_ENTRIES, 7).map((e) => e.port)).toEqual([5173, 3000, 8080, 5174, 9335, 4000, 11434]);
  });
});

describe("preselect: what an empty query offers, in order", () => {
  // One table, every tier: zombies, then contested ports, then the rest newest first.
  const zombieOld = entry({ port: 5174, pid: 1, startedAt: 100, orphan: true });
  const zombieNew = entry({ port: 4200, pid: 2, startedAt: 900, orphan: true });
  const contestedOld = entry({ port: 3000, pid: 3, startedAt: 200 });
  const contestedNew = entry({ port: 8080, pid: 4, startedAt: 800 });
  const devNewest = entry({ port: 5173, pid: 5, startedAt: 950 });
  const devOlder = entry({ port: 9335, pid: 6, startedAt: 50 });
  const devUnknown = entry({ port: 7777, pid: 7, startedAt: null });
  const protectedZombie = entry({ port: 7000, pid: 8, startedAt: 999, orphan: true, protected: true });
  const protectedContested = entry({ port: 5432, pid: 9, startedAt: 999, protected: true });
  const all = [
    devOlder,
    protectedContested,
    contestedOld,
    devUnknown,
    zombieOld,
    devNewest,
    protectedZombie,
    contestedNew,
    zombieNew,
  ];
  const contested = new Set([3000, 8080, 5432]);

  const table: [string, PortEntry[], Set<number>, number[]][] = [
    [
      "zombies newest first, then contested newest first, then the rest newest first; protected never",
      all,
      contested,
      [4200, 5174, 8080, 3000, 5173, 9335, 7777],
    ],
    ["no collisions: zombies, then recents", all, new Set(), [4200, 5174, 5173, 8080, 3000, 9335, 7777]],
    [
      "no zombies, no collisions: exactly the recents",
      [devOlder, devNewest, devUnknown, contestedOld],
      new Set(),
      [5173, 3000, 9335, 7777],
    ],
    [
      "a contested port that is not listed changes nothing",
      [devOlder, devNewest],
      new Set([3000]),
      [5173, 9335],
    ],
    ["nothing listed", [], contested, []],
  ];

  it.each(table)("%s", (_name, entries, collisions, expected) => {
    expect(preselect(entries, collisions, 10).map((e) => e.port)).toEqual(expected);
  });

  it("ties inside a tier go by port, then pid; the limit still applies", () => {
    const entries = [
      entry({ port: 2, pid: 9, startedAt: 10, orphan: true }),
      entry({ port: 1, pid: 8, startedAt: 10, orphan: true }),
      entry({ port: 1, pid: 7, startedAt: 10, orphan: true }),
      entry({ port: 3, pid: 6, startedAt: 10 }),
    ];
    expect(preselect(entries, new Set()).map((e) => [e.port, e.pid])).toEqual([
      [1, 7],
      [1, 8],
      [2, 9],
      [3, 6],
    ]);
    expect(preselect(entries, new Set(), 2).map((e) => e.pid)).toEqual([7, 8]);
  });

  it("without zombies or collisions it is recents(), so the ranking did not change", () => {
    const plain = MOCK_ENTRIES.filter((e) => !e.orphan);
    expect(preselect(plain, new Set())).toEqual(recents(plain));
  });

  it("on the mock: the lost-terminal :5174 then :4000 first, then the dev servers newest first", () => {
    expect(preselect(MOCK_ENTRIES, new Set()).map((e) => e.port)).toEqual([
      5174, 4000, 5173, 3000, 8080, 9335,
    ]);
    expect(preselect(MOCK_ENTRIES, new Set([8080])).map((e) => e.port)).toEqual([
      5174, 4000, 8080, 5173, 3000, 9335,
    ]);
  });

  it("isZombie: orphan and unprotected", () => {
    expect(isZombie(entry({ orphan: true }))).toBe(true);
    expect(isZombie(entry({ orphan: true, protected: true }))).toBe(false);
    expect(isZombie(entry({ orphan: false }))).toBe(false);
  });
});

describe("collisionPorts", () => {
  const event = (partial: Partial<TasklineEvent>): TasklineEvent => ({
    id: 1,
    atMs: 0,
    kind: "collisionResolved",
    port: 3000,
    protocol: "tcp",
    pid: 1,
    processName: "node",
    project: null,
    memoryBytes: 0,
    durationMs: 0,
    message: "",
    relaunchable: false,
    ...partial,
  });

  it("names the ports of collisionResolved events inside the window, and nothing else", () => {
    const now = 1_000_000;
    const events = [
      event({ id: 1, port: 3000, atMs: now - 1_000 }),
      event({ id: 2, port: 8080, atMs: now - 60_000 }),
      event({ id: 3, port: 5173, atMs: now - 60_001 }),
      event({ id: 4, port: 4200, atMs: now - 1_000, kind: "portFreed" }),
      event({ id: 5, port: 9000, atMs: now - 1_000, kind: "zombieReaped" }),
      event({ id: 6, port: 3000, atMs: now - 2_000 }),
    ];
    expect([...collisionPorts(events, now)].sort()).toEqual([3000, 8080]);
    expect([...collisionPorts(events, now, 1_500)]).toEqual([3000]);
    expect(collisionPorts([], now).size).toBe(0);
  });
});

describe("helpers", () => {
  it("isNumericQuery", () => {
    expect(isNumericQuery("3000")).toBe(true);
    expect(isNumericQuery(" 30 ")).toBe(true);
    expect(isNumericQuery("")).toBe(false);
    expect(isNumericQuery("vite")).toBe(false);
    expect(isNumericQuery("30a")).toBe(false);
  });

  it("quickKey tells a pid's ports apart", () => {
    expect(quickKey(entry({ pid: 7, port: 80 }))).toBe("7:80:tcp");
    expect(quickKey(entry({ pid: 7, port: 81, protocol: "udp" }))).toBe("7:81:udp");
  });
});

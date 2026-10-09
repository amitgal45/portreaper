import { describe, expect, it } from "vitest";
import { MOCK_ENTRIES } from "../api/mock";
import type { PortEntry } from "../types";
import { isNumericQuery, quickKey, rankMatches, recents } from "./match";

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

  it("on the mock: the dev servers newest first, nothing protected", () => {
    expect(recents(MOCK_ENTRIES).map((e) => e.port)).toEqual([5173, 3000, 8080, 5174, 9335]);
    expect(recents(MOCK_ENTRIES, 2).map((e) => e.port)).toEqual([5173, 3000]);
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

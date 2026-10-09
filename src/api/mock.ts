import type { KillOutcome, KillRequest, PortApi, PortEntry } from "../types";

/**
 * A believable machine for building the UI in a plain browser (`pnpm dev`) and in tests, with no
 * Tauri core behind it. Kills are simulated: a killed pid disappears on the next list.
 */
const now = Math.floor(Date.now() / 1000);

function entry(partial: Partial<PortEntry> & Pick<PortEntry, "port" | "pid" | "processName">): PortEntry {
  return {
    protocol: "tcp",
    bind: "loopback",
    address: "127.0.0.1",
    command: partial.processName,
    cwd: null,
    exe: null,
    user: "amit",
    memoryBytes: 48 * 1024 * 1024,
    startedAt: now - 3600,
    parentPid: 900,
    orphan: false,
    project: null,
    protected: false,
    ...partial,
  };
}

export const MOCK_ENTRIES: PortEntry[] = [
  entry({
    port: 3000,
    pid: 48213,
    processName: "node",
    command: "node /Users/amit/work/shop-api/node_modules/.bin/next dev",
    cwd: "/Users/amit/work/shop-api",
    memoryBytes: 412 * 1024 * 1024,
    startedAt: now - 2 * 3600,
    project: {
      name: "shop-api",
      root: "/Users/amit/work/shop-api",
      kind: "node",
      branch: "feature/cart",
      tool: "next",
    },
  }),
  entry({
    port: 5173,
    pid: 51022,
    processName: "node",
    command: "node /Users/amit/work/portreaper/node_modules/.bin/vite",
    cwd: "/Users/amit/work/portreaper",
    memoryBytes: 180 * 1024 * 1024,
    startedAt: now - 20 * 60,
    project: {
      name: "portreaper",
      root: "/Users/amit/work/portreaper",
      kind: "node",
      branch: "main",
      tool: "vite",
    },
  }),
  entry({
    port: 5174,
    pid: 39871,
    processName: "node",
    command: "node /Users/amit/work/tinyrecipe/repos/tinyrecipe-lp/node_modules/.bin/vite",
    cwd: "/Users/amit/work/tinyrecipe/repos/tinyrecipe-lp",
    memoryBytes: 220 * 1024 * 1024,
    startedAt: now - 26 * 3600,
    parentPid: 1,
    orphan: true,
    project: {
      name: "tinyrecipe-lp",
      root: "/Users/amit/work/tinyrecipe/repos/tinyrecipe-lp",
      kind: "node",
      branch: "amit/TR-120-hero",
      tool: "vite",
    },
  }),
  entry({
    port: 8080,
    pid: 22104,
    processName: "node",
    bind: "any",
    address: "0.0.0.0",
    command: "node dist/main.js",
    cwd: "/Users/amit/Desktop/AiProjects/SpecMate/apps/api",
    memoryBytes: 610 * 1024 * 1024,
    startedAt: now - 5 * 3600,
    project: {
      name: "@specmate/api",
      root: "/Users/amit/Desktop/AiProjects/SpecMate",
      kind: "node",
      branch: "main",
      tool: "nest",
    },
  }),
  entry({
    port: 5432,
    pid: 11710,
    processName: "com.docker.backend",
    bind: "any",
    address: "*",
    command: "/Applications/Docker.app/Contents/MacOS/com.docker.backend",
    memoryBytes: 1200 * 1024 * 1024,
    startedAt: now - 3 * 24 * 3600,
    protected: true,
    project: { name: "postgres:16", root: "", kind: "unknown", branch: null, tool: "docker" },
  }),
  entry({
    port: 6379,
    pid: 11710,
    processName: "com.docker.backend",
    bind: "any",
    address: "*",
    command: "/Applications/Docker.app/Contents/MacOS/com.docker.backend",
    memoryBytes: 1200 * 1024 * 1024,
    startedAt: now - 3 * 24 * 3600,
    protected: true,
    project: { name: "redis:7", root: "", kind: "unknown", branch: null, tool: "docker" },
  }),
  entry({
    port: 7000,
    pid: 635,
    processName: "ControlCenter",
    bind: "any",
    address: "*",
    command: "/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter",
    memoryBytes: 90 * 1024 * 1024,
    startedAt: now - 9 * 24 * 3600,
    parentPid: 1,
    protected: true,
  }),
  entry({
    port: 9335,
    pid: 1824,
    processName: "chrome-helper",
    command:
      "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/chrome_crashpad_handler",
    memoryBytes: 30 * 1024 * 1024,
    startedAt: now - 9 * 24 * 3600,
  }),
  entry({
    port: 53,
    pid: 4102,
    processName: "mDNSResponder",
    protocol: "udp",
    bind: "any",
    address: "*",
    command: "/usr/sbin/mDNSResponder",
    user: "_mdnsresponder",
    memoryBytes: 12 * 1024 * 1024,
    startedAt: now - 9 * 24 * 3600,
    parentPid: 1,
    protected: true,
  }),
];

export function createMockApi(seed: PortEntry[] = MOCK_ENTRIES): PortApi {
  let entries = seed.map((e) => ({ ...e }));
  const kill = (request: KillRequest): KillOutcome => {
    const victim = entries.find((e) => e.pid === request.pid);
    if (!victim) return { status: "notFound", pid: request.pid };
    if (victim.pid <= 1) return { status: "refused", pid: request.pid, reason: "launchd" };
    entries = entries.filter((e) => e.pid !== request.pid);
    return {
      status: "killed",
      pid: request.pid,
      graceful: !request.force,
      waitedMs: request.force ? 0 : 180,
    };
  };
  return {
    listPorts: async () => entries.map((e) => ({ ...e })),
    killProcess: async (request) => kill(request),
    freePort: async (port, force) => {
      const pids = [...new Set(entries.filter((e) => e.port === port).map((e) => e.pid))];
      return pids.map((pid) => kill({ pid, force }));
    },
    appVersion: async () => "0.1.0-mock",
  };
}

export const mockApi: PortApi = createMockApi();

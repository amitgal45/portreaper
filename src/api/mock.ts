import {
  type Category,
  DEFAULT_SETTINGS,
  type EventKind,
  type KillOutcome,
  type KillRequest,
  MAX_HIDDEN_PORTS,
  type PortApi,
  type PortEntry,
  type ProcessNode,
  type Protocol,
  type RelaunchOutcome,
  type Settings,
  type TasklineEvent,
  type UpdateInfo,
  type WatchedPort,
} from "../types";

/**
 * A believable machine for building the UI in a plain browser (`pnpm dev`) and in tests, with no
 * Tauri core behind it. Kills are simulated: a killed pid disappears on the next list.
 */
const now = Math.floor(Date.now() / 1000);

/**
 * The update the sidebar banner shows in a browser with `?update=1` in the URL (`demoUpdate` in
 * `composables/useUpdate.ts`), so `pnpm dev` and the e2e can see the banner without a release.
 * Inside Tauri the seam does nothing: there the core's `update:available` is the only source.
 */
export const MOCK_UPDATE: UpdateInfo = {
  version: "0.3.0",
  notes: "- Auto-update from GitHub Releases\n- The Board: sidebar, cards, inspector",
  date: "2026-10-15T20:00:00Z",
};

/** How long the mock's "download" takes, so the banner's progress state is visible in `pnpm dev`. */
export const MOCK_INSTALL_MS = 600;

/** The v0.2 taxonomy, by port convention, the way the core's `classify` does it. */
function classifyMock(port: number): { category: Category; framework: string | null } {
  const table: Record<number, [Category, string | null]> = {
    3000: ["web", "Next.js"],
    5173: ["web", "Vite"],
    5174: ["web", "Vite"],
    4200: ["web", "Angular"],
    8080: ["api", "NestJS"],
    8000: ["api", "FastAPI"],
    5000: ["api", null],
    4000: ["api", null],
    5432: ["db", "PostgreSQL 16"],
    5433: ["db", "PostgreSQL 16"],
    6379: ["db", "Redis 7"],
    27017: ["db", "MongoDB"],
    11434: ["ai", "Ollama"],
    1234: ["ai", "LM Studio"],
    53: ["system", "mDNSResponder"],
    7000: ["system", "AirPlay"],
    631: ["system", "CUPS"],
  };
  const hit = table[port];
  return hit ? { category: hit[0], framework: hit[1] } : { category: "other", framework: null };
}

/**
 * `hidden::normalize` in the core: whole port numbers 1–65535 only (the core's `u16` refuses the
 * rest, and port 0 is a portless entry, never hidden), sorted, once each, the lowest
 * `MAX_HIDDEN_PORTS` kept.
 */
function normalizeHiddenPorts(ports: readonly number[]): number[] {
  const valid = ports.filter((port) => Number.isInteger(port) && port >= 1 && port <= 65_535);
  return [...new Set(valid)].sort((a, b) => a - b).slice(0, MAX_HIDDEN_PORTS);
}

/**
 * `ports::protect_whole_pids` in the core: a kill takes the whole pid, so every entry of a pid that
 * is protected on any of its sockets is protected. New objects; `list` is left as it is.
 */
function protectWholePids(list: readonly PortEntry[]): PortEntry[] {
  const guarded = new Set(list.filter((e) => e.protected).map((e) => e.pid));
  return list.map((e) => ({ ...e, protected: e.protected || guarded.has(e.pid) }));
}

function entry(partial: Partial<PortEntry> & Pick<PortEntry, "port" | "pid" | "processName">): PortEntry {
  return {
    ...classifyMock(partial.port),
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
    container: null,
    launchd: null,
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
  // The one container the mock names (WP-20), on its own port and under a second backend
  // process, so the Docker rows above and the counts the earlier specs assert stay as they are.
  entry({
    port: 5433,
    pid: 11712,
    processName: "com.docker.backend",
    command: "/Applications/Docker.app/Contents/MacOS/com.docker.backend",
    memoryBytes: 1200 * 1024 * 1024,
    startedAt: now - 3 * 24 * 3600,
    protected: true,
    container: "shop-db",
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
  // The v0.2 demo entries: a local model server, and a second lost-terminal server that Reap takes.
  // The model server is a `brew services` job: launchd is its parent on purpose (so it is no
  // zombie) and starts it again after a kill (KeepAlive), so the core protects it.
  entry({
    port: 11434,
    pid: 32014,
    processName: "ollama",
    command: "/usr/local/bin/ollama serve",
    cwd: "/Users/amit",
    exe: "/usr/local/bin/ollama",
    memoryBytes: Math.ceil(4.85 * 1024 * 1024 * 1024),
    startedAt: now - 12 * 24 * 3600,
    parentPid: 1,
    protected: true,
    launchd: {
      label: "homebrew.mxcl.ollama",
      restarts: true,
      brew: "ollama",
      stopCommand: "brew services stop ollama",
      system: false,
    },
  }),
  entry({
    port: 4000,
    pid: 18402,
    processName: "ruby",
    framework: "Jekyll",
    command: "bundle exec jekyll serve --port 4000",
    cwd: "/Users/amit/work/legacy-docs",
    memoryBytes: 420 * 1024 * 1024,
    startedAt: now - 10 * 24 * 3600,
    parentPid: 1,
    orphan: true,
    protected: false,
    project: {
      name: "legacy-docs",
      root: "/Users/amit/work/legacy-docs",
      kind: "git",
      branch: "v1.0",
      tool: "jekyll",
    },
  }),
];

/**
 * Portless (`stdio`) agent & browser zombies (`WP-23`), added to `mockApi` when `?stdio=1` is in
 * the URL so default `MOCK_ENTRIES` counts stay unchanged for existing specs.
 */
export const MOCK_STDIO_ZOMBIES: PortEntry[] = [
  entry({
    port: 0,
    pid: 74910,
    processName: "node",
    category: "ai",
    framework: "MCP",
    address: "stdio",
    command: "npx -y @modelcontextprotocol/server-filesystem /Users/amit/work/shop-api",
    cwd: "/Users/amit/work/shop-api",
    memoryBytes: 640 * 1024 * 1024,
    startedAt: now - 18 * 3600,
    parentPid: 1,
    orphan: true,
    protected: false,
    project: {
      name: "shop-api",
      root: "/Users/amit/work/shop-api",
      kind: "node",
      branch: "feature/cart",
      tool: "mcp",
    },
  }),
  entry({
    port: 0,
    pid: 74911,
    processName: "chrome-headless-shell",
    category: "web",
    framework: "Playwright",
    address: "stdio",
    command:
      "/Users/amit/Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell --headless",
    cwd: "/Users/amit/work/portreaper",
    memoryBytes: 920 * 1024 * 1024,
    startedAt: now - 8 * 3600,
    parentPid: 1,
    orphan: true,
    protected: false,
    project: {
      name: "portreaper",
      root: "/Users/amit/work/portreaper",
      kind: "node",
      branch: "main",
      tool: "playwright",
    },
  }),
];

/**
 * The core's start-time check (`kill::kill`, #30): a request that names a start time reaches only
 * the process that started then. Refused, with the core's words, when the pid's process started at
 * another time or its start time is unknown. `null`, or missing as from an older caller (serde's
 * default in the core), checks nothing.
 */
function startTimeRefusal(request: KillRequest, victim: PortEntry): KillOutcome | null {
  const pid = request.pid;
  const expected = request.startedAt ?? null;
  if (expected === null) return null;
  if (victim.startedAt === null) {
    return {
      status: "refused",
      pid,
      reason: `could not confirm pid ${pid} is the process you chose; refresh and try again`,
    };
  }
  if (victim.startedAt === expected) return null;
  const ago = Math.max(0, Math.floor(Date.now() / 1000) - victim.startedAt);
  return {
    status: "refused",
    pid,
    reason: `pid ${pid} is now another process (started ${ago} s ago), not the one you chose; refresh and try again`,
  };
}

export function createMockApi(seed: PortEntry[] = MOCK_ENTRIES): PortApi {
  let entries = seed.map((e) => ({ ...e }));
  const events: TasklineEvent[] = [];
  let nextEventId = 1;
  let nextPid = 60000;
  // The preferences live for the page: the view (WP-17b) is testable without the core. The card
  // is dismissed by default so the existing flows see no card; `?onboarding=1` brings it back.
  let settings: Settings = { ...DEFAULT_SETTINGS, onboardingDone: true, hiddenPorts: [] };
  // A copy out, so a caller that changes the array changes nothing here.
  const copySettings = (): Settings => ({ ...settings, hiddenPorts: [...settings.hiddenPorts] });
  // Hidden ports, as the core hides them: by number, TCP and UDP alike; port 0 never.
  const hidden = (port: number) => port !== 0 && settings.hiddenPorts.includes(port);
  // What the core's listing hands every caller: protection pid-wide, before any hidden port is left out.
  const listed = (): PortEntry[] => protectWholePids(entries);
  // Watches (WP-18): a set of port+protocol; the state is read off the entries when asked. A
  // watch on a hidden port stays in the set and is left out of every answer, as in the core.
  const watches = new Map<string, { port: number; protocol: Protocol; sinceMs: number }>();
  const watchKey = (port: number, protocol: Protocol) => `${protocol}:${port}`;
  const watched = (): WatchedPort[] =>
    [...watches.values()]
      .filter((w) => !hidden(w.port))
      .sort((a, b) => a.port - b.port)
      .map((w) => {
        const holder = entries.find((e) => e.port === w.port && e.protocol === w.protocol);
        return holder
          ? {
              port: w.port,
              protocol: w.protocol,
              state: "listening",
              pid: holder.pid,
              processName: holder.processName,
              project: holder.project?.name ?? null,
              sinceMs: w.sinceMs,
            }
          : {
              port: w.port,
              protocol: w.protocol,
              state: "free",
              pid: null,
              processName: null,
              project: null,
              sinceMs: w.sinceMs,
            };
      });
  const record = (
    kind: EventKind,
    e: PortEntry,
    durationMs: number,
    message: string,
    relaunchable: boolean,
  ) => {
    events.unshift({
      id: nextEventId++,
      atMs: Date.now(),
      kind,
      port: e.port,
      protocol: e.protocol,
      pid: e.pid,
      processName: e.processName,
      project: e.project?.name ?? null,
      memoryBytes: e.memoryBytes,
      durationMs,
      message,
      relaunchable,
    });
  };
  const kill = (request: KillRequest): KillOutcome => {
    // Looked up in the listing, as the core does: a pid protected anywhere is never relaunchable.
    const victim = listed().find((e) => e.pid === request.pid);
    if (!victim) return { status: "notFound", pid: request.pid };
    if (victim.pid <= 1) return { status: "refused", pid: request.pid, reason: "launchd" };
    const waitedMs = request.force ? 0 : 180;
    if (victim.container) {
      // The core stops the container and leaves Docker's backend alone (WP-20): only that port
      // goes, nothing comes back to relaunch, and the sentence names the container.
      entries = entries.filter((e) => !(e.pid === victim.pid && e.container === victim.container));
      record(
        request.force ? "forceKilled" : "portFreed",
        // The backend keeps its memory: nothing came back that the feed could count.
        { ...victim, memoryBytes: 0 },
        waitedMs,
        `${request.force ? "Killed" : "Stopped"} container ${victim.container}. Port ${victim.port} is free.`,
        false,
      );
      return { status: "killed", pid: request.pid, graceful: !request.force, waitedMs };
    }
    // As `kill::kill` before its first signal. Not for a container above: the core stops it by
    // name (`stop_recorded`) and checks no start time.
    const refusal = startTimeRefusal(request, victim);
    if (refusal) return refusal;
    entries = entries.filter((e) => e.pid !== request.pid);
    const verb = request.force ? "Force-killed" : "Killed";
    record(
      request.force ? "forceKilled" : "portFreed",
      victim,
      waitedMs,
      victim.port === 0
        ? `${verb} ${victim.processName} (${victim.pid}).`
        : `${verb} ${victim.processName} (${victim.pid}). Port ${victim.port} is free.`,
      !victim.protected && victim.command !== "" && victim.cwd !== null,
    );
    return { status: "killed", pid: request.pid, graceful: !request.force, waitedMs };
  };
  return {
    listPorts: async () => listed().filter((e) => !hidden(e.port)),
    killProcess: async (request) => kill(request),
    freePort: async (port, force, expected) => {
      // As `commands::free_plan`: only the processes the caller chose are killed. A pid it did not
      // name, or one that started at another time, took the port since; a protected one needs
      // `confirmed`. Protection is pid-wide (`listed()`).
      const all = listed();
      const pids = [...new Set(all.filter((e) => e.port === port).map((e) => e.pid))].sort((x, y) => x - y);
      return pids.map((pid): KillOutcome => {
        const mine = all.filter((e) => e.pid === pid);
        const name = mine.find((e) => e.port === port)?.processName ?? "";
        const listedAt = mine.find((e) => e.startedAt !== null)?.startedAt ?? null;
        const target = expected.find((t) => t.pid === pid);
        if (!target || (target.startedAt !== null && listedAt !== null && target.startedAt !== listedAt)) {
          const reason = `port ${port} is now held by ${name} (${pid}), not the process you chose; refresh and try again`;
          return { status: "refused", pid, reason };
        }
        if (mine.some((e) => e.protected) && !target.confirmed) {
          const reason = `${name} (${pid}) is protected and was not confirmed; refresh and try again`;
          return { status: "refused", pid, reason };
        }
        return kill({ pid, force, startedAt: target.startedAt ?? listedAt });
      });
    },
    appVersion: async () => "0.2.0-mock",
    processTree: async (pid): Promise<ProcessNode[]> => {
      const e = entries.find((x) => x.pid === pid);
      if (!e) return [];
      if (e.parentPid === 1)
        return [
          { pid: 1, name: "launchd" },
          { pid, name: e.processName },
        ];
      return [
        { pid: 1, name: "launchd" },
        { pid: 948, name: "iTerm2" },
        { pid: e.parentPid ?? 900, name: "zsh" },
        { pid, name: e.processName },
      ];
    },
    tasklineEvents: async () => events.map((e) => ({ ...e })),
    clearTaskline: async () => {
      events.length = 0;
    },
    reapZombies: async () => {
      // As `commands::reap_targets`: a pid protected on any socket is spared, and a bulk kill never
      // reaches what the user cannot see, so a hidden zombie is left running.
      const zombies = listed().filter((e) => e.orphan && !e.protected && !hidden(e.port));
      return zombies.map((z) => {
        const outcome = kill({ pid: z.pid, force: false, startedAt: z.startedAt });
        const ev = events[0];
        if (outcome.status === "killed" && ev && ev.pid === z.pid) {
          ev.kind = "zombieReaped";
          ev.message =
            z.port === 0
              ? `Reaped ${z.processName} (${z.pid}), an orphaned background process.`
              : `Reaped ${z.processName} (${z.pid}), a lost-terminal server on port ${z.port}.`;
        }
        return outcome;
      });
    },
    relaunch: async (eventId): Promise<RelaunchOutcome> => {
      const ev = events.find((e) => e.id === eventId);
      if (!ev) return { status: "notFound", eventId };
      const original = seed.find((s) => s.pid === ev.pid);
      if (!ev.relaunchable || !original) return { status: "failed", eventId, error: "nothing to relaunch" };
      const pid = nextPid++;
      const back = {
        ...original,
        pid,
        startedAt: Math.floor(Date.now() / 1000),
        orphan: false,
        parentPid: 900,
      };
      entries.push(back);
      record(
        "relaunched",
        back,
        0,
        back.port === 0
          ? `Relaunched ${back.processName} (new pid ${pid}).`
          : `Relaunched ${back.processName} on port ${back.port} (new pid ${pid}).`,
        false,
      );
      return { status: "started", pid };
    },
    // No GitHub behind the mock: a check finds nothing and says nothing; an install "succeeds"
    // after a moment, and the banner reads "Restarting…" because nothing restarts here.
    checkForUpdates: async () => {},
    installUpdate: () => new Promise<void>((resolve) => setTimeout(resolve, MOCK_INSTALL_MS)),
    getSettings: async () => copySettings(),
    setSettings: async (next) => {
      settings = {
        ...next,
        refreshMs: Math.min(30_000, Math.max(1_000, next.refreshMs)),
        hiddenPorts: normalizeHiddenPorts(next.hiddenPorts),
      };
      return copySettings();
    },
    watchedPorts: async () => watched(),
    watchPort: async (port, protocol) => {
      const key = watchKey(port, protocol);
      if (!watches.has(key)) watches.set(key, { port, protocol, sinceMs: Date.now() });
      return watched();
    },
    unwatchPort: async (port, protocol) => {
      watches.delete(watchKey(port, protocol));
      return watched();
    },
  };
}

const stdioDemo =
  typeof window !== "undefined" &&
  typeof window.location?.search === "string" &&
  new URLSearchParams(window.location.search).get("stdio") === "1";

export const mockApi: PortApi = createMockApi(
  stdioDemo ? [...MOCK_ENTRIES, ...MOCK_STDIO_ZOMBIES] : MOCK_ENTRIES,
);

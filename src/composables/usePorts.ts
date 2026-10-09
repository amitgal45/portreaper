import { computed, getCurrentScope, onScopeDispose, reactive, ref, watch } from "vue";
import { guessCurrentUser, protectionReason } from "../lib/protection";
import type { KillOutcome, PortApi, PortEntry } from "../types";

/** One row of the table is identified by pid + port + protocol (a pid can hold several ports). */
export function entryKey(e: PortEntry): string {
  return `${e.pid}:${e.port}:${e.protocol}`;
}

export interface PortGroup {
  /** `p:<project name>` or `n:<process name>`, so a project called "node" never merges with the node processes. */
  key: string;
  name: string;
  /** The branch when every entry in the group agrees on one. */
  branch: string | null;
  /** The tool when every entry agrees on one. */
  tool: string | null;
  /** The project root when every entry agrees (`""` for containers). */
  root: string | null;
  hasProject: boolean;
  /** True when any entry is protected: "Kill all" then asks first. */
  protected: boolean;
  /** Sorted by port. */
  entries: PortEntry[];
  /** Distinct pids, in port order. */
  pids: number[];
}

/** A kill outcome, or the transport failing before the core could answer. */
export type KillResult = KillOutcome | { status: "transport"; pid: number; error: string };

export interface KillReport {
  entry: PortEntry;
  /** Every port that pid held when the kill was requested. */
  ports: number[];
  outcome: KillResult;
}

export interface UsePortsOptions {
  intervalMs?: number;
  /** Polls only while this is true. Defaults to `document.visibilityState === "visible"`. */
  isVisible?: () => boolean;
  /** Where collapsed groups are remembered. `null` forgets them. Defaults to `localStorage`. */
  storage?: Storage | null;
  /** How long a pid reported `killed` stays hidden even if a stale poll still lists it. */
  tombstoneMs?: number;
}

const COLLAPSED_KEY = "portreaper.collapsed";

function uniform<T>(values: T[]): T | null {
  const first = values[0];
  return values.every((v) => v === first) ? (first ?? null) : null;
}

function matches(e: PortEntry, q: string): boolean {
  if (String(e.port).startsWith(q)) return true;
  if (String(e.pid) === q) return true;
  const haystacks = [e.processName, e.project?.name ?? "", e.project?.branch ?? "", e.command];
  return haystacks.some((h) => h.toLowerCase().includes(q));
}

export function groupEntries(entries: PortEntry[]): PortGroup[] {
  const buckets = new Map<string, PortEntry[]>();
  for (const e of entries) {
    const key = e.project ? `p:${e.project.name}` : `n:${e.processName}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(e);
    else buckets.set(key, [e]);
  }
  const groups: PortGroup[] = [];
  for (const [key, bucket] of buckets) {
    bucket.sort((a, b) => a.port - b.port || a.pid - b.pid);
    const first = bucket[0] as PortEntry;
    groups.push({
      key,
      name: first.project?.name ?? first.processName,
      branch: uniform(bucket.map((e) => e.project?.branch ?? null)),
      tool: uniform(bucket.map((e) => e.project?.tool ?? null)),
      root: uniform(bucket.map((e) => e.project?.root ?? null)),
      hasProject: first.project !== null,
      protected: bucket.some((e) => e.protected),
      entries: bucket,
      pids: [...new Set(bucket.map((e) => e.pid))],
    });
  }
  // The user's own dev servers first, then anything else of theirs, then the protected groups.
  const rank = (g: PortGroup) => (g.protected ? 2 : g.hasProject ? 0 : 1);
  groups.sort((a, b) => rank(a) - rank(b) || (a.entries[0]?.port ?? 0) - (b.entries[0]?.port ?? 0));
  return groups;
}

function readCollapsed(storage: Storage | null): string[] {
  try {
    const raw = storage?.getItem(COLLAPSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

function writeCollapsed(storage: Storage | null, keys: Iterable<string>) {
  try {
    storage?.setItem(COLLAPSED_KEY, JSON.stringify([...keys]));
  } catch {
    // Storage can be full or blocked; the collapsed state is a convenience, not data.
  }
}

/**
 * All the state behind the table: polling, search, grouping, selection, and killing with
 * optimistic removal. No DOM: components render it, tests drive it with `createMockApi()`.
 * Call `start()` on mount and `stop()` on unmount.
 */
export function usePorts(api: PortApi, options: UsePortsOptions = {}) {
  const intervalMs = options.intervalMs ?? 2000;
  const tombstoneMs = options.tombstoneMs ?? 3000;
  const isVisible =
    options.isVisible ??
    (() => (typeof document === "undefined" ? true : document.visibilityState === "visible"));
  const storage =
    options.storage === undefined
      ? typeof localStorage === "undefined"
        ? null
        : localStorage
      : options.storage;

  const entries = ref<PortEntry[]>([]);
  const query = ref("");
  const selectedKey = ref<string | null>(null);
  const error = ref<string | null>(null);
  const lastRefresh = ref<number | null>(null);
  const loaded = ref(false);
  const version = ref("");
  /** Pids with a kill in flight: the row shows a spinner and refuses clicks. */
  const pending = reactive(new Set<number>());
  const collapsed = reactive(new Set<string>(readCollapsed(storage)));
  /** pid → when it was reported killed; a poll started before that may still list it. */
  const tombstones = new Map<number, number>();

  const normalizedQuery = computed(() => query.value.trim().toLowerCase());
  const filtered = computed(() => {
    const q = normalizedQuery.value;
    return q ? entries.value.filter((e) => matches(e, q)) : entries.value;
  });
  const groups = computed(() => groupEntries(filtered.value));
  /** The rows on screen, top to bottom, skipping collapsed groups. Selection moves through this. */
  const visibleEntries = computed(() => groups.value.flatMap((g) => (collapsed.has(g.key) ? [] : g.entries)));
  const selected = computed(
    () => visibleEntries.value.find((e) => entryKey(e) === selectedKey.value) ?? null,
  );
  const total = computed(() => entries.value.length);
  const projectCount = computed(
    () => new Set(entries.value.flatMap((e) => (e.project ? [e.project.name] : []))).size,
  );
  const currentUser = computed(() => guessCurrentUser(entries.value));

  // Polling
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  let started = false;

  async function refresh(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const list = await api.listPorts();
      const now = Date.now();
      for (const [pid, at] of tombstones) if (now - at > tombstoneMs) tombstones.delete(pid);
      entries.value = tombstones.size ? list.filter((e) => !tombstones.has(e.pid)) : list;
      error.value = null;
      lastRefresh.value = now;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      console.error("listPorts failed", err);
    } finally {
      inFlight = false;
      loaded.value = true;
    }
  }

  function startTimer() {
    if (timer !== null) return;
    timer = setInterval(() => {
      if (isVisible()) void refresh();
    }, intervalMs);
  }

  function stopTimer() {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  function onVisibility() {
    if (isVisible()) {
      void refresh();
      startTimer();
    } else {
      stopTimer();
    }
  }

  function start() {
    if (started) return;
    started = true;
    void refresh();
    api
      .appVersion()
      .then((v) => {
        version.value = v;
      })
      .catch(() => {
        version.value = "";
      });
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
    if (isVisible()) startTimer();
  }

  function stop() {
    if (!started) return;
    started = false;
    stopTimer();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
  }

  // Inside a component the polling dies with it; outside (plain tests) callers stop() themselves.
  if (getCurrentScope()) onScopeDispose(stop);

  // Selection
  function select(target: PortEntry | string | null) {
    selectedKey.value = target === null ? null : typeof target === "string" ? target : entryKey(target);
  }

  function selectNext() {
    const list = visibleEntries.value;
    if (list.length === 0) return;
    const idx = list.findIndex((e) => entryKey(e) === selectedKey.value);
    select(list[Math.min(idx + 1, list.length - 1)] ?? null);
  }

  function selectPrev() {
    const list = visibleEntries.value;
    if (list.length === 0) return;
    const idx = list.findIndex((e) => entryKey(e) === selectedKey.value);
    select(list[idx < 0 ? list.length - 1 : Math.max(idx - 1, 0)] ?? null);
  }

  // A search always has a visible target for Enter: the first match. An empty search has none.
  watch(normalizedQuery, (q) => {
    select(q ? (visibleEntries.value[0] ?? null) : null);
  });

  // When the selected row leaves (killed, filtered out, collapsed), move to its neighbour so a
  // second Enter clears the next port; with nothing to stand on, drop the selection.
  watch(visibleEntries, (now, before) => {
    const key = selectedKey.value;
    if (key === null || now.some((e) => entryKey(e) === key)) return;
    const prevIdx = before.findIndex((e) => entryKey(e) === key);
    if (prevIdx >= 0 && now.length > 0) select(now[Math.min(prevIdx, now.length - 1)] ?? null);
    else select(normalizedQuery.value ? (now[0] ?? null) : null);
  });

  function clearSearch() {
    query.value = "";
  }

  function clearSelection() {
    select(null);
  }

  // Groups
  function toggleGroup(key: string) {
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    writeCollapsed(storage, collapsed);
  }

  // Killing
  function portsOf(pid: number): number[] {
    return [...new Set(entries.value.filter((e) => e.pid === pid).map((e) => e.port))].sort((a, b) => a - b);
  }

  function reasonFor(entry: PortEntry): string {
    return protectionReason(entry, currentUser.value);
  }

  async function kill(entry: PortEntry, force = false): Promise<KillReport> {
    const ports = portsOf(entry.pid);
    if (pending.has(entry.pid)) {
      return { entry, ports, outcome: { status: "failed", pid: entry.pid, error: "already being killed" } };
    }
    pending.add(entry.pid);
    let outcome: KillResult;
    try {
      outcome = await api.killProcess({ pid: entry.pid, force });
    } catch (err) {
      console.error("killProcess failed", err);
      outcome = {
        status: "transport",
        pid: entry.pid,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      pending.delete(entry.pid);
    }
    if (outcome.status === "killed") {
      tombstones.set(entry.pid, Date.now());
      entries.value = entries.value.filter((e) => e.pid !== entry.pid);
    }
    return { entry, ports, outcome };
  }

  /** Kills every distinct pid of the group, one after the other. */
  async function killGroup(group: PortGroup, force = false): Promise<KillReport[]> {
    const reports: KillReport[] = [];
    const targets = group.pids.flatMap((pid) => {
      const first = group.entries.find((e) => e.pid === pid);
      return first ? [first] : [];
    });
    // Every row of the group spins from the first click; kill() takes each pid over in turn.
    for (const t of targets) pending.add(t.pid);
    try {
      for (const t of targets) {
        pending.delete(t.pid);
        reports.push(await kill(t, force));
      }
    } finally {
      for (const t of targets) pending.delete(t.pid);
    }
    return reports;
  }

  return {
    // state
    entries,
    query,
    groups,
    visibleEntries,
    selectedKey,
    selected,
    pending,
    collapsed,
    error,
    lastRefresh,
    loaded,
    version,
    total,
    projectCount,
    currentUser,
    // lifecycle
    start,
    stop,
    refresh,
    // selection and search
    select,
    selectNext,
    selectPrev,
    clearSelection,
    clearSearch,
    toggleGroup,
    // kill
    kill,
    killGroup,
    portsOf,
    reasonFor,
  };
}

export type PortsStore = ReturnType<typeof usePorts>;

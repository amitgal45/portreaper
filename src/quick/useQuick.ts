import { computed, getCurrentScope, onScopeDispose, ref, watch } from "vue";
import { onSettingsChanged } from "../api/events";
import { hideCurrentWindow } from "../api/window";
import { guessCurrentUser, protectionReason } from "../lib/protection";
import type { KillOutcome, KillTarget, PortApi, PortEntry } from "../types";
import {
  COLLISION_WINDOW_MS,
  collisionPorts,
  isNumericQuery,
  normalizeQuery,
  preselect,
  QUICK_LIMIT,
  quickKey,
  rankMatches,
} from "./match";

export interface UseQuickOptions {
  /** Poll interval while visible. */
  intervalMs?: number;
  /** How long a protected row stays armed after the first Enter. */
  armMs?: number;
  /** How long a successful result shows before the strip clears and hides. */
  resultMs?: number;
  /** How long a refusal, a failure or "Could not reach the core" shows. Nothing is hidden afterwards. */
  failureMs?: number;
  /** How long a killed pid stays hidden even if a stale poll still lists it. */
  tombstoneMs?: number;
  /** How long after a `collisionResolved` event its port is still pre-selected. */
  collisionWindowMs?: number;
  limit?: number;
  /** Polls only while this is true. Defaults to `document.visibilityState === "visible"`. */
  isVisible?: () => boolean;
  /** Where the key and focus listeners go. Defaults to `window`. */
  target?: Pick<Window, "addEventListener" | "removeEventListener">;
  /** Called on every window focus, after the refresh: the page puts the caret in the input. */
  onFocus?: () => void;
  /** Where the last list is kept between loads. Defaults to `sessionStorage`; `null` disables it. */
  cache?: QuickCache | null;
}

/**
 * The last list, so a freshly loaded strip paints rows before its first poll answers and
 * refreshes behind them. Rows can be a few seconds stale for that moment; the first poll
 * replaces them, and a kill rewrites the cache so a dead row never comes back.
 */
export interface QuickCache {
  read(): PortEntry[] | null;
  write(entries: PortEntry[]): void;
}

export const QUICK_CACHE_KEY = "portreaper.quick.entries";

/**
 * The default cache: `sessionStorage`, which lives as long as the window and dies with the
 * app, so a previous session's processes (and their command lines) are never shown or kept on
 * disk. Anything that goes wrong (no storage, quota, a bad value) reads as "no cache".
 */
function storageCache(): QuickCache | null {
  if (typeof sessionStorage === "undefined") return null;
  return {
    read() {
      try {
        const raw = sessionStorage.getItem(QUICK_CACHE_KEY);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as PortEntry[]) : null;
      } catch {
        return null;
      }
    },
    write(entries) {
      try {
        sessionStorage.setItem(QUICK_CACHE_KEY, JSON.stringify(entries));
      } catch {
        // Nothing to do: the next load polls as if there were no cache.
      }
    },
  };
}

/**
 * A protected row after its first Enter. The row shows `text` ("This is Docker (com.docker.backend).")
 * and `hint` ("Press Enter again to kill it.") until the second Enter or any other key. The hint
 * never wraps, so it stays short: for a launchd job it is only the command that stops it.
 */
export interface Armed {
  key: string;
  text: string;
  hint: string;
}

/**
 * What an armed row says. A launchd job that launchd starts again after a kill says so and names
 * the core's stop command when there is one, copied as it came (`?.`: a cached entry from an older
 * core has no `launchd`): "ollama restarts after a kill (launchd). Enter again to kill it anyway;
 * brew services stop ollama stops it." One that nobody can tell about (`restarts` null, which the
 * core protects too) says it "may restart". A system job (a piece of macOS: ControlCenter on :5000)
 * is none of these: it gets the ordinary protected text, "This is a system process (ControlCenter)."
 * (`?.system`: a cached entry may lack the field). Anything else names why it is protected.
 */
export function armedText(entry: PortEntry, currentUser: string | null): Omit<Armed, "key"> {
  const job = entry.launchd;
  const restarts = job?.restarts;
  if (job && !job.system && restarts !== false) {
    const verb = restarts === true ? "restarts" : "may restart";
    const statement = `${entry.processName} ${verb} after a kill (launchd).`;
    return job.stopCommand
      ? { text: `${statement} Enter again to kill it anyway;`, hint: `${job.stopCommand} stops it.` }
      : { text: statement, hint: "Enter again to kill it anyway." };
  }
  return {
    text: `This is ${protectionReason(entry, currentUser)} (${entry.processName}).`,
    hint: "Press Enter again to kill it.",
  };
}

/** What replaces a row after Enter: "Freed :3000 · node (48213)", a refusal, or the transport failure. */
export interface QuickResult {
  key: string;
  text: string;
  ok: boolean;
}

/** Keys that are modifiers on their own. Pressing ⌥ before ⌥Enter must not disarm a protected row. */
const MODIFIER_KEYS = new Set(["Alt", "Shift", "Meta", "Control", "CapsLock", "Fn", "AltGraph"]);

function who(entries: PortEntry[], pid: number): string {
  const name = entries.find((e) => e.pid === pid)?.processName ?? "pid";
  return `${name} (${pid})`;
}

/** One line for what `freePort` answered. Every outcome named; the first bad one wins. */
export function describeOutcomes(
  port: number,
  entries: PortEntry[],
  outcomes: KillOutcome[],
): QuickResult["text"] {
  if (outcomes.length === 0) return port === 0 ? "Already gone" : `:${port} is already free`;
  const bad = outcomes.find((o) => o.status !== "killed");
  if (!bad) {
    const names = outcomes.map((o) => who(entries, o.pid)).join(", ");
    return port === 0 ? `Killed ${names}` : `Freed :${port} · ${names}`;
  }
  switch (bad.status) {
    case "refused":
      return `Did not kill ${who(entries, bad.pid)}: ${bad.reason}`;
    case "failed":
      return `Could not kill ${who(entries, bad.pid)}: ${bad.error}`;
    case "notFound":
      return `${who(entries, bad.pid)} is already gone`;
    default:
      return port === 0 ? "Could not kill process" : `Could not free :${port}`;
  }
}

/**
 * Everything behind the Quick strip: the list and its polling, the query and the ranked
 * matches, the pre-selection on an empty query, the selection, the two-step Enter on a
 * protected row, and what happens after a kill. No DOM of its own beyond the window listeners;
 * `QuickApp.vue` renders it, tests drive it through `handleKey()` with `createMockApi()`. Call
 * `start()` on mount and `stop()` on unmount.
 *
 * Timing: the cached list paints at once; the first poll replaces it. The ports hidden in
 * Preferences are read on start and followed after: their rows leave the strip, the cached ones
 * included, as soon as the list is known or changes. After a successful kill
 * the result row shows for `resultMs` (180 ms), then the strip clears and hides, which is what
 * gives the terminal its focus back. A refusal or failure stays `failureMs` (2 s) and hides
 * nothing, so the user can read it and try ⌥Enter.
 */
export function useQuick(api: PortApi, options: UseQuickOptions = {}) {
  const intervalMs = options.intervalMs ?? 2000;
  const armMs = options.armMs ?? 5000;
  const resultMs = options.resultMs ?? 180;
  const failureMs = options.failureMs ?? 2000;
  const tombstoneMs = options.tombstoneMs ?? 3000;
  const collisionWindowMs = options.collisionWindowMs ?? COLLISION_WINDOW_MS;
  const limit = options.limit ?? QUICK_LIMIT;
  const isVisible =
    options.isVisible ??
    (() => (typeof document === "undefined" ? true : document.visibilityState === "visible"));
  const target = options.target ?? (typeof window === "undefined" ? null : window);
  const cache = options.cache === undefined ? storageCache() : options.cache;

  const entries = ref<PortEntry[]>([]);
  const query = ref("");
  const selectedKey = ref<string | null>(null);
  const loaded = ref(false);
  const error = ref<string | null>(null);
  const armed = ref<Armed | null>(null);
  const result = ref<QuickResult | null>(null);
  /** A `freePort` call is in flight: Enter and the polls wait. */
  const busy = ref(false);
  /** Ports a `collisionResolved` event named recently, read from the Taskline once per show. */
  const collisions = ref<ReadonlySet<number>>(new Set());
  /** pid → when it was reported killed; a poll started before that may still list it. */
  const tombstones = new Map<number, number>();
  /**
   * The ports hidden in Preferences, port 0 never: read once on start and followed through
   * `settings:changed`. Until the first answer nothing is hidden, as with an unreadable store.
   */
  const hidden = ref<ReadonlySet<number>>(new Set());

  /** `list` without the rows on a hidden port; `list` itself when nothing is hidden. */
  function withoutHidden(list: PortEntry[]): PortEntry[] {
    const ports = hidden.value;
    if (ports.size === 0) return list;
    return list.filter((e) => e.port === 0 || !ports.has(e.port));
  }

  /** Every change to the list goes through here, so the cache never lags behind the screen. */
  function setEntries(list: PortEntry[]) {
    entries.value = list;
    cache?.write(list);
  }

  /**
   * A new hidden list: its rows leave the strip and the cache at once, so neither the rows on
   * screen nor the next strip painted from the cache shows them before a poll.
   */
  function followHidden(ports: readonly number[]) {
    hidden.value = new Set(ports.filter((port) => port !== 0));
    const shown = withoutHidden(entries.value);
    if (shown.length !== entries.value.length) setEntries(shown);
  }

  // The last list paints before the first poll answers.
  const cached = cache?.read();
  if (cached) {
    entries.value = cached;
    loaded.value = true;
  }

  const matches = computed(() =>
    normalizeQuery(query.value)
      ? rankMatches(entries.value, query.value, limit)
      : preselect(entries.value, collisions.value, limit),
  );
  /** The selected row, else the first match: Enter always has a target when there is one. */
  const selected = computed(
    () => matches.value.find((e) => quickKey(e) === selectedKey.value) ?? matches.value[0] ?? null,
  );
  const numeric = computed(() => isNumericQuery(query.value));
  const emptyText = computed(() => {
    if (!loaded.value || matches.value.length > 0) return null;
    const q = normalizeQuery(query.value);
    if (!q) return "No listening ports.";
    return numeric.value ? `Nothing on :${q}` : "Nothing matches";
  });
  const currentUser = computed(() => guessCurrentUser(entries.value));

  // Polling
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  let started = false;

  async function refresh(): Promise<void> {
    // A kill in flight, or its result on screen, owns the list for the moment.
    if (inFlight || busy.value || result.value) return;
    inFlight = true;
    try {
      const list = await api.listPorts();
      const now = Date.now();
      for (const [pid, at] of tombstones) if (now - at > tombstoneMs) tombstones.delete(pid);
      setEntries(withoutHidden(tombstones.size ? list.filter((e) => !tombstones.has(e.pid)) : list));
      error.value = null;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      console.error("listPorts failed", err);
    } finally {
      inFlight = false;
      loaded.value = true;
    }
  }

  // A `settings:changed` that lands while `getSettings` is out is newer than its answer.
  let heardSettings = false;

  /** Once per start: the hidden ports as the core has them. A failure hides nothing. */
  async function readHidden(): Promise<void> {
    try {
      const settings = await api.getSettings();
      if (!heardSettings) followHidden(settings.hiddenPorts);
    } catch (err) {
      console.error("getSettings failed", err);
    }
  }

  /**
   * Once per show: which ports PortReaper freed lately that something else took. When the
   * Taskline cannot be read the pre-selection falls back to zombies, then newest; the strip
   * itself is not in error.
   */
  async function refreshCollisions(): Promise<void> {
    try {
      const events = await api.tasklineEvents();
      collisions.value = collisionPorts(events, Date.now(), collisionWindowMs);
    } catch (err) {
      collisions.value = new Set();
      console.error("tasklineEvents failed", err);
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

  // Rust shows and focuses the window together, so a focus is a show: the list and the
  // Taskline refresh behind the rows already on screen.
  function onFocus() {
    void refresh();
    void refreshCollisions();
    options.onFocus?.();
  }

  // Selection
  function move(step: 1 | -1) {
    const list = matches.value;
    if (list.length === 0) return;
    const current = selected.value;
    const idx = current ? list.findIndex((e) => quickKey(e) === quickKey(current)) : -1;
    const next = list[Math.min(Math.max(idx + step, 0), list.length - 1)];
    if (next) selectedKey.value = quickKey(next);
  }

  function select(entry: PortEntry) {
    selectedKey.value = quickKey(entry);
  }

  // A new query starts from its first match, and cancels a pending second Enter.
  watch(query, () => {
    selectedKey.value = null;
    disarm();
  });

  // The armed row left the list (a poll, or the query): nothing to confirm any more.
  watch(matches, (list) => {
    const a = armed.value;
    if (a && !list.some((e) => quickKey(e) === a.key)) disarm();
  });

  // The two-step Enter
  let armTimer: ReturnType<typeof setTimeout> | null = null;

  function arm(entry: PortEntry) {
    disarm();
    armed.value = { key: quickKey(entry), ...armedText(entry, currentUser.value) };
    armTimer = setTimeout(disarm, armMs);
  }

  function disarm() {
    if (armTimer !== null) {
      clearTimeout(armTimer);
      armTimer = null;
    }
    if (armed.value) armed.value = null;
  }

  // After a kill
  let resultTimer: ReturnType<typeof setTimeout> | null = null;

  function clearResultTimer() {
    if (resultTimer !== null) {
      clearTimeout(resultTimer);
      resultTimer = null;
    }
  }

  /**
   * The processes the strip has on `entry`'s port: what `freePort` may kill. A process that takes
   * the port after this is not in it, and the core refuses it. `confirmed` goes only to the pid of
   * the row the user pressed Enter on twice.
   */
  function targetsOf(entry: PortEntry, confirmed: boolean): KillTarget[] {
    const targets = new Map<number, KillTarget>();
    for (const e of entries.value) {
      if (e.port !== entry.port || targets.has(e.pid)) continue;
      targets.set(e.pid, { pid: e.pid, startedAt: e.startedAt, confirmed: confirmed && e.pid === entry.pid });
    }
    if (!targets.has(entry.pid))
      targets.set(entry.pid, { pid: entry.pid, startedAt: entry.startedAt, confirmed });
    return [...targets.values()];
  }

  async function free(entry: PortEntry, force: boolean, confirmed: boolean): Promise<void> {
    const key = quickKey(entry);
    busy.value = true;
    let outcomes: KillOutcome[] | null = null;
    try {
      outcomes =
        entry.port === 0
          ? [await api.killProcess({ pid: entry.pid, force, startedAt: entry.startedAt })]
          : await api.freePort(entry.port, force, targetsOf(entry, confirmed));
    } catch (err) {
      console.error("freePort failed", err);
    } finally {
      busy.value = false;
    }
    clearResultTimer();
    if (outcomes === null) {
      // The transport failed: say so, keep the strip, let the user try again.
      result.value = { key, text: "Could not reach the core", ok: false };
      resultTimer = setTimeout(() => {
        resultTimer = null;
        result.value = null;
      }, failureMs);
      return;
    }
    const killed = outcomes.filter((o) => o.status === "killed").map((o) => o.pid);
    const now = Date.now();
    for (const pid of killed) tombstones.set(pid, now);
    const ok = killed.length === outcomes.length;
    result.value = { key, text: describeOutcomes(entry.port, entries.value, outcomes), ok };
    const dropKilled = () => {
      if (killed.length) setEntries(entries.value.filter((e) => !killed.includes(e.pid)));
    };
    if (!ok) {
      // A refusal or a failure stays long enough to read; the strip and the query stay too, so
      // ⌥Enter is one key away. Whatever did die leaves the list when the line clears.
      resultTimer = setTimeout(() => {
        resultTimer = null;
        result.value = null;
        dropKilled();
      }, failureMs);
      return;
    }
    // The row is the answer for an instant; then the strip is done: clear, hide, and the
    // terminal has its focus back.
    resultTimer = setTimeout(() => {
      resultTimer = null;
      result.value = null;
      dropKilled();
      query.value = "";
      selectedKey.value = null;
      void hideCurrentWindow();
    }, resultMs);
  }

  /** Enter: free the selection; a protected row needs it twice. ⌥ forces. */
  function enter(force = false) {
    if (busy.value || result.value) return;
    const entry = selected.value;
    if (!entry) return;
    const key = quickKey(entry);
    if (entry.protected && armed.value?.key !== key) {
      arm(entry);
      return;
    }
    disarm();
    // Reaching here on a protected row means it was armed: this Enter is the confirmation.
    void free(entry, force, entry.protected);
  }

  /** Esc: back out one step. An armed row disarms; a query clears; an empty strip hides. */
  function back() {
    if (armed.value) {
      disarm();
      return;
    }
    if (query.value) {
      query.value = "";
      return;
    }
    void hideCurrentWindow();
  }

  function handleKey(event: KeyboardEvent) {
    if (event.defaultPrevented) return;
    switch (event.key) {
      case "Enter":
        event.preventDefault();
        enter(event.altKey);
        return;
      case "Escape":
        event.preventDefault();
        back();
        return;
      case "ArrowDown":
        event.preventDefault();
        disarm();
        move(1);
        return;
      case "ArrowUp":
        event.preventDefault();
        disarm();
        move(-1);
        return;
      default:
        // Any other key cancels a pending second Enter, except a modifier on its own (⌥ before ⌥Enter).
        if (!MODIFIER_KEYS.has(event.key)) disarm();
    }
  }

  // Lifecycle
  const keyListener = handleKey as EventListener;
  let offSettings: () => void = () => {};

  function start() {
    if (started) return;
    started = true;
    heardSettings = false;
    offSettings = onSettingsChanged((settings) => {
      heardSettings = true;
      followHidden(settings.hiddenPorts);
    });
    // The list first: the strip's first rows wait on nothing else.
    void refresh();
    void readHidden();
    void refreshCollisions();
    target?.addEventListener("keydown", keyListener);
    target?.addEventListener("focus", onFocus);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
    if (isVisible()) startTimer();
  }

  function stop() {
    if (!started) return;
    started = false;
    offSettings();
    offSettings = () => {};
    stopTimer();
    disarm();
    clearResultTimer();
    target?.removeEventListener("keydown", keyListener);
    target?.removeEventListener("focus", onFocus);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
  }

  // Inside a component the listeners die with it; outside (plain tests) callers stop() themselves.
  if (getCurrentScope()) onScopeDispose(stop);

  return {
    // state
    entries,
    query,
    matches,
    selected,
    selectedKey,
    numeric,
    emptyText,
    loaded,
    error,
    armed,
    result,
    busy,
    collisions,
    // lifecycle
    start,
    stop,
    refresh,
    refreshCollisions,
    // keys
    handleKey,
    enter,
    back,
    select,
    moveDown: () => move(1),
    moveUp: () => move(-1),
  };
}

export type QuickStore = ReturnType<typeof useQuick>;

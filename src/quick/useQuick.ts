import { computed, getCurrentScope, onScopeDispose, ref, watch } from "vue";
import { hideCurrentWindow } from "../api/window";
import { guessCurrentUser, protectionReason } from "../lib/protection";
import type { KillOutcome, PortApi, PortEntry } from "../types";
import { isNumericQuery, normalizeQuery, QUICK_LIMIT, quickKey, rankMatches } from "./match";

export interface UseQuickOptions {
  /** Poll interval while visible. */
  intervalMs?: number;
  /** How long a protected row stays armed after the first Enter. */
  armMs?: number;
  /** How long the result line shows before the strip clears and hides. */
  resultMs?: number;
  /** How long "Could not reach the core" shows. Nothing is hidden afterwards. */
  transportMs?: number;
  /** How long a killed pid stays hidden even if a stale poll still lists it. */
  tombstoneMs?: number;
  limit?: number;
  /** Polls only while this is true. Defaults to `document.visibilityState === "visible"`. */
  isVisible?: () => boolean;
  /** Where the key and focus listeners go. Defaults to `window`. */
  target?: Pick<Window, "addEventListener" | "removeEventListener">;
  /** Called on every window focus, after the refresh: the page puts the caret in the input. */
  onFocus?: () => void;
}

/** A protected row after its first Enter: the row shows `text` until the second Enter or any other key. */
export interface Armed {
  key: string;
  text: string;
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
  if (outcomes.length === 0) return `:${port} is already free`;
  const bad = outcomes.find((o) => o.status !== "killed");
  if (!bad) return `Freed :${port} · ${outcomes.map((o) => who(entries, o.pid)).join(", ")}`;
  switch (bad.status) {
    case "refused":
      return `Did not kill ${who(entries, bad.pid)}: ${bad.reason}`;
    case "failed":
      return `Could not kill ${who(entries, bad.pid)}: ${bad.error}`;
    case "notFound":
      return `${who(entries, bad.pid)} is already gone`;
    default:
      return `Could not free :${port}`;
  }
}

/**
 * Everything behind the Quick strip: the list and its polling, the query and the ranked
 * matches, the selection, the two-step Enter on a protected row, and what happens after a kill.
 * No DOM of its own beyond the window listeners; `QuickApp.vue` renders it, tests drive it
 * through `handleKey()` with `createMockApi()`. Call `start()` on mount and `stop()` on unmount.
 */
export function useQuick(api: PortApi, options: UseQuickOptions = {}) {
  const intervalMs = options.intervalMs ?? 2000;
  const armMs = options.armMs ?? 5000;
  const resultMs = options.resultMs ?? 1200;
  const transportMs = options.transportMs ?? 2000;
  const tombstoneMs = options.tombstoneMs ?? 3000;
  const limit = options.limit ?? QUICK_LIMIT;
  const isVisible =
    options.isVisible ??
    (() => (typeof document === "undefined" ? true : document.visibilityState === "visible"));
  const target = options.target ?? (typeof window === "undefined" ? null : window);

  const entries = ref<PortEntry[]>([]);
  const query = ref("");
  const selectedKey = ref<string | null>(null);
  const loaded = ref(false);
  const error = ref<string | null>(null);
  const armed = ref<Armed | null>(null);
  const result = ref<QuickResult | null>(null);
  /** A `freePort` call is in flight: Enter and the polls wait. */
  const busy = ref(false);
  /** pid → when it was reported killed; a poll started before that may still list it. */
  const tombstones = new Map<number, number>();

  const matches = computed(() => rankMatches(entries.value, query.value, limit));
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
      entries.value = tombstones.size ? list.filter((e) => !tombstones.has(e.pid)) : list;
      error.value = null;
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

  function onFocus() {
    void refresh();
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
    const reason = protectionReason(entry, currentUser.value);
    armed.value = {
      key: quickKey(entry),
      text: `This is ${reason} (${entry.processName}). Press Enter again to kill it.`,
    };
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

  async function free(entry: PortEntry, force: boolean): Promise<void> {
    const key = quickKey(entry);
    busy.value = true;
    let outcomes: KillOutcome[] | null = null;
    try {
      outcomes = await api.freePort(entry.port, force);
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
      }, transportMs);
      return;
    }
    const killed = outcomes.filter((o) => o.status === "killed").map((o) => o.pid);
    const now = Date.now();
    for (const pid of killed) tombstones.set(pid, now);
    result.value = {
      key,
      text: describeOutcomes(entry.port, entries.value, outcomes),
      ok: killed.length === outcomes.length,
    };
    // The row shows the result in place for a moment; then the strip is done: clear, hide.
    resultTimer = setTimeout(() => {
      resultTimer = null;
      result.value = null;
      if (killed.length) entries.value = entries.value.filter((e) => !killed.includes(e.pid));
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
    void free(entry, force);
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

  function start() {
    if (started) return;
    started = true;
    void refresh();
    target?.addEventListener("keydown", keyListener);
    target?.addEventListener("focus", onFocus);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
    if (isVisible()) startTimer();
  }

  function stop() {
    if (!started) return;
    started = false;
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
    // lifecycle
    start,
    stop,
    refresh,
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

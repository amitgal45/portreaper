import { computed, getCurrentScope, onScopeDispose, ref, watch } from "vue";
import type { PortEntry } from "../types";
import type { KillFlow } from "./useKillFlow";
import { entryKey, type PortsStore } from "./usePorts";

/** From this window width the inspector is a third column; below it, a slide-over. */
export const INSPECTOR_COLUMN_MIN_WIDTH = 900;

type MediaQuery = Pick<MediaQueryList, "matches" | "addEventListener" | "removeEventListener">;

export interface UseInspectorOptions {
  /** Where the window width is read. Defaults to `window.matchMedia`; tests inject a fake. */
  matchMedia?: (query: string) => MediaQuery;
}

/**
 * What the inspector shows and how. `inspecting` is a snapshot of the row; `entry` prefers the
 * live row with the same key, so a poll's fresh numbers show. In a wide window the inspector is
 * a column that follows the selection (↑↓ or a click); in a narrow one it is a slide-over that a
 * click opens and Esc closes, and the list's keys are off while it is up. A row that leaves the
 * list closes its inspector, unless a Restart is telling its story there: then the snapshot
 * stays until the relaunched row takes over.
 */
export function useInspector(ports: PortsStore, flow: KillFlow, options: UseInspectorOptions = {}) {
  const matchMedia =
    options.matchMedia ??
    (typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia.bind(window)
      : null);
  const query = matchMedia?.(`(min-width: ${INSPECTOR_COLUMN_MIN_WIDTH}px)`) ?? null;
  const wide = ref(query?.matches ?? true);
  const onChange = (event: MediaQueryListEvent) => {
    wide.value = event.matches;
  };
  query?.addEventListener("change", onChange);
  if (getCurrentScope()) onScopeDispose(() => query?.removeEventListener("change", onChange));

  const inspecting = ref<PortEntry | null>(null);
  const entry = computed(() => {
    const snap = inspecting.value;
    if (!snap) return null;
    const key = entryKey(snap);
    return ports.entries.value.find((e) => entryKey(e) === key) ?? snap;
  });
  /** The column is on screen. */
  const column = computed(() => wide.value && entry.value !== null);
  /** The slide-over is on screen: the list's keys belong to it. */
  const overlay = computed(() => !wide.value && entry.value !== null);

  const restartBusy = () => {
    const phase = flow.restarting.value?.phase;
    return phase === "killing" || phase === "relaunching";
  };

  /** Show a row. The last Restart's story is forgotten when the row changes. */
  function open(target: PortEntry) {
    const changed = inspecting.value === null || entryKey(inspecting.value) !== entryKey(target);
    inspecting.value = target;
    if (changed) flow.clearRestart();
  }

  function close() {
    inspecting.value = null;
    flow.clearRestart();
  }

  // Wide: the column follows the selection. By key, not by row object: a poll replaces every
  // object and must not count as a move. Not while a Restart is between kill and relaunch: the
  // selection slides to the neighbour then, and the story stays on the restarting row.
  watch(
    () => ports.selectedKey.value,
    () => {
      if (!wide.value || restartBusy()) return;
      const selected = ports.selected.value;
      if (selected) open(selected);
      else close();
    },
  );

  // A row that left the list (killed, or gone on a poll) closes its inspector.
  watch(
    () => ports.entries.value,
    (entries) => {
      const snap = inspecting.value;
      if (!snap || flow.restarting.value) return;
      const key = entryKey(snap);
      if (!entries.some((e) => entryKey(e) === key)) close();
    },
  );

  // Resized across the threshold: a slide-over must not pop up on its own, and a column
  // takes the selection.
  watch(wide, (isWide) => {
    if (!isWide) close();
    else if (ports.selected.value) open(ports.selected.value);
  });

  return { wide, inspecting, entry, column, overlay, open, close };
}

export type Inspector = ReturnType<typeof useInspector>;

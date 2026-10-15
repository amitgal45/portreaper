<script setup lang="ts">
// The one window: title strip with the two views, the Studio (tiles, filter strip, the list) or
// the Taskline, the toast band, the status line, and the drawer over it all. State lives in the
// composables; the components only render it and ask for actions through provide/inject.
import { TooltipProvider } from "reka-ui";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { provideApi } from "./api";
import { copyText, openInBrowser, revealFolder } from "./api/system";
import FilterStrip from "./components/FilterStrip.vue";
import KillConfirm from "./components/KillConfirm.vue";
import PortTable from "./components/PortTable.vue";
import ProcessDrawer from "./components/ProcessDrawer.vue";
import StatsBar from "./components/StatsBar.vue";
import StatusLine from "./components/StatusLine.vue";
import TasklineView from "./components/TasklineView.vue";
import TitleBar, { type View } from "./components/TitleBar.vue";
import ToastList from "./components/ToastList.vue";
import { provideActions } from "./composables/useActions";
import { useKeyboard } from "./composables/useKeyboard";
import { useKillFlow } from "./composables/useKillFlow";
import { entryKey, usePorts } from "./composables/usePorts";
import { useTaskline } from "./composables/useTaskline";
import { useToasts } from "./composables/useToasts";
import { selectFromTray, useTrayListener } from "./composables/useTray";
import type { PortEntry } from "./types";

const api = provideApi();
const ports = usePorts(api);
const toasts = useToasts();
const taskline = useTaskline(api, toasts);
const flow = useKillFlow(ports, toasts, taskline);
const {
  query,
  category,
  counts,
  devMemoryBytes,
  zombieMemoryBytes,
  scanMs,
  groups,
  collapsed,
  selectedKey,
  pending,
  loaded,
  total,
  projectCount,
  lastRefresh,
  version,
  error,
} = ports;

const view = ref<View>("studio");
const filterStrip = ref<{ focus(mode?: "all" | "end"): Promise<void> } | null>(null);
/** Rows that match the search and the pill; the status line says "N of M ports" while fewer than M. */
const shown = computed(() => groups.value.reduce((n, g) => n + g.entries.length, 0));

// The drawer. `inspecting` is a snapshot of the row; `drawerEntry` prefers the live row with the
// same key, so a poll's fresh numbers show. During a Restart the key moves to the new pid.
const inspecting = ref<PortEntry | null>(null);
const drawerEntry = computed(() => {
  const snap = inspecting.value;
  if (!snap) return null;
  const key = entryKey(snap);
  return ports.entries.value.find((e) => entryKey(e) === key) ?? snap;
});

function inspect(entry: PortEntry) {
  ports.select(entry);
  flow.clearRestart();
  inspecting.value = entry;
}

function closeDrawer() {
  inspecting.value = null;
  flow.clearRestart();
}

// A row that left the list (killed, or gone on a poll) closes its drawer, unless a Restart is
// telling its story there.
watch(
  () => ports.entries.value,
  (entries) => {
    const snap = inspecting.value;
    if (!snap || flow.restarting.value) return;
    const key = entryKey(snap);
    if (!entries.some((e) => entryKey(e) === key)) closeDrawer();
  },
);

async function restart(entry: PortEntry) {
  const outcome = await flow.restart(entry);
  if (outcome.status === "started" && inspecting.value?.pid === entry.pid) {
    const back = { ...entry, pid: outcome.pid, startedAt: Math.floor(Date.now() / 1000), orphan: false };
    inspecting.value = back;
    // The selection follows the relaunched row instead of sliding to its neighbour.
    ports.select(back);
  }
}

/** Runs a row action that leaves the webview and tells the user what happened. */
async function leave(action: Promise<boolean>, done: string | null) {
  try {
    const ok = await action;
    if (!ok) toasts.push("Not available in the browser");
    else if (done) toasts.push(done);
  } catch (err) {
    console.error(err);
    toasts.push(err instanceof Error ? err.message : String(err), "error");
  }
}

/** After a kill or a reap the feed has news: show it before the next poll. */
async function thenRefreshTaskline(action: Promise<void>) {
  await action;
  await taskline.refresh();
}

provideActions({
  select: (entry) => ports.select(entry),
  inspect,
  kill: (entry, force) => void thenRefreshTaskline(flow.request({ kind: "entry", entry, force })),
  killGroup: (group, force) => void thenRefreshTaskline(flow.request({ kind: "group", group, force })),
  restart: (entry) => void restart(entry),
  reap: () => void thenRefreshTaskline(flow.reap()),
  toggleGroup: (key) => ports.toggleGroup(key),
  openInBrowser: (entry) => void leave(openInBrowser(entry.port), null),
  copyKill: (entry) => void leave(copyText(`kill -9 ${entry.pid}`), `Copied kill -9 ${entry.pid}`),
  copyCommand: (entry) => void leave(copyText(entry.command), "Copied the command line"),
  revealFolder: (entry) => void leave(revealFolder(entry.project?.root ?? ""), null),
});

const keyboard = useKeyboard(
  {
    up: () => ports.selectPrev(),
    down: () => ports.selectNext(),
    enter: () => {
      const entry = ports.selected.value;
      if (entry) void thenRefreshTaskline(flow.request({ kind: "entry", entry, force: false }));
    },
    forceKill: () => {
      const entry = ports.selected.value;
      if (!entry) return false;
      void thenRefreshTaskline(flow.request({ kind: "entry", entry, force: true }));
      return true;
    },
    escape: () => {
      if (query.value) ports.clearSearch();
      else if (category.value !== "all") ports.setCategory("all");
      else ports.clearSelection();
    },
    focusSearch: () => {
      view.value = "studio";
      void filterStrip.value?.focus("all");
    },
    refresh: () => {
      void ports.refresh();
      void taskline.refresh();
    },
    digit: (digit) => {
      view.value = "studio";
      query.value = digit;
      void filterStrip.value?.focus("end");
    },
  },
  { enabled: () => !flow.confirming.value && inspecting.value === null },
);

// The tray (WP-4) hands over a protected port: show it and ask. A no-op outside Tauri.
const tray = useTrayListener((payload) => {
  view.value = "studio";
  void selectFromTray(ports, flow, payload);
});

async function confirmed() {
  await flow.confirmed();
  await taskline.refresh();
}

onMounted(() => {
  ports.start();
  taskline.start();
  keyboard.start();
  void tray.start();
});
onUnmounted(() => {
  tray.stop();
  keyboard.stop();
  taskline.stop();
  ports.stop();
});
</script>

<template>
  <TooltipProvider :delay-duration="500" :skip-delay-duration="300">
    <main class="flex h-full flex-col overflow-hidden bg-void text-[13px] text-ink">
      <TitleBar v-model:view="view" :taskline-count="taskline.count.value" :total="total" />
      <template v-if="view === 'studio'">
        <StatsBar
          :total="total"
          :projects="projectCount"
          :dev-memory-bytes="devMemoryBytes"
          :zombies="counts.zombie"
          :zombie-memory-bytes="zombieMemoryBytes"
          :public-count="counts.public"
          :category="category"
          @filter="ports.toggleCategory"
        />
        <FilterStrip
          ref="filterStrip"
          v-model:query="query"
          :category="category"
          :counts="counts"
          :zombie-memory-bytes="zombieMemoryBytes"
          @update:category="ports.setCategory"
          @reap="thenRefreshTaskline(flow.reap())"
        />
        <PortTable
          :groups="groups"
          :collapsed="collapsed"
          :selected-key="selectedKey"
          :pending="pending"
          :loaded="loaded"
          :query="query"
          :category="category"
          :reason-for="ports.reasonFor"
          :collisions="taskline.recentCollisions.value"
        />
      </template>
      <TasklineView
        v-else
        :events="taskline.events.value"
        :loaded="taskline.loaded.value"
        :relaunching="taskline.relaunching"
        :can-relaunch="taskline.canRelaunch"
        @relaunch="(id) => void taskline.relaunch(id).then(() => ports.refresh())"
        @clear="taskline.clear()"
      />
      <!-- In the flow, between the list and the status line: the list shrinks while toasts are up. -->
      <ToastList :toasts="toasts.toasts.value" @dismiss="toasts.dismiss" />
      <StatusLine
        :shown="shown"
        :total="total"
        :projects="projectCount"
        :last-refresh="lastRefresh"
        :scan-ms="scanMs"
        :version="version"
        :error="error"
      />
      <KillConfirm :target="flow.confirm.value" :reason-for="ports.reasonFor" :ports-of="ports.portsOf" @confirm="confirmed()" @cancel="flow.cancel()" />
      <ProcessDrawer
        :entry="drawerEntry"
        :reason="drawerEntry?.protected ? ports.reasonFor(drawerEntry) : null"
        :restart="flow.restarting.value"
        @close="closeDrawer"
      />
    </main>
  </TooltipProvider>
</template>

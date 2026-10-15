<script setup lang="ts">
// The Board: a sidebar, the main column (toolbar, cards, the table or the Taskline, the toast
// band, the status line) and, when a row is selected, the inspector as a third column in a wide
// window or a slide-over in a narrow one. State lives in the composables; the components only
// render it and ask for actions through provide/inject.
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  TooltipProvider,
} from "reka-ui";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { provideApi } from "./api";
import { onOpenPreferences } from "./api/events";
import { copyText, openInBrowser, revealFolder } from "./api/system";
import Inspector from "./components/Inspector.vue";
import KillConfirm from "./components/KillConfirm.vue";
import Onboarding from "./components/Onboarding.vue";
import PortTable from "./components/PortTable.vue";
import SettingsView from "./components/SettingsView.vue";
import Sidebar, { type View } from "./components/Sidebar.vue";
import StatsBar from "./components/StatsBar.vue";
import StatusLine from "./components/StatusLine.vue";
import TasklineView from "./components/TasklineView.vue";
import ToastList from "./components/ToastList.vue";
import Toolbar from "./components/Toolbar.vue";
import { provideActions } from "./composables/useActions";
import { useInspector } from "./composables/useInspector";
import { useKeyboard } from "./composables/useKeyboard";
import { useKillFlow } from "./composables/useKillFlow";
import { usePorts } from "./composables/usePorts";
import { demoOnboarding, useSettings } from "./composables/useSettings";
import { useTaskline } from "./composables/useTaskline";
import { useToasts } from "./composables/useToasts";
import { selectFromTray, useTrayListener } from "./composables/useTray";
import { demoUpdate, useUpdate } from "./composables/useUpdate";
import type { PortEntry } from "./types";

const api = provideApi();
// The preferences (WP-17b): the poll interval and the Kill base read from them; in a browser,
// `?onboarding=1` shows the first-run card over the mock's dismissed flag.
const settings = useSettings(api, { onboarding: demoOnboarding(location.search) });
const prefs = settings.settings;
const ports = usePorts(api, { intervalMs: () => prefs.value.refreshMs });
const toasts = useToasts();
const taskline = useTaskline(api, toasts);
const flow = useKillFlow(ports, toasts, taskline, { defaultForce: () => prefs.value.defaultForce });
const inspector = useInspector(ports, flow);
// The sidebar's update banner (WP-16): fed by the core's events; in a browser, `?update=1` shows the demo.
const update = useUpdate(api, { seed: demoUpdate(location.search) });
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
// Preferences re-reads the core each time it opens: a change made elsewhere (the tray) shows even
// if its event was missed, and in a browser a second read proves the mock kept the value.
watch(view, (now) => {
  if (now === "settings") void settings.load();
});
const toolbar = ref<{ focus(mode?: "all" | "end"): Promise<void> } | null>(null);
/** Rows that match the search and the filter; the status line says "N of M ports" while fewer than M. */
const shown = computed(() => groups.value.reduce((n, g) => n + g.entries.length, 0));
const inspected = computed(() => inspector.entry.value);
const inspectedReason = computed(() =>
  inspected.value?.protected ? ports.reasonFor(inspected.value) : null,
);

/** A row click: select it and show it. In a wide window the column follows the selection anyway. */
function inspect(entry: PortEntry) {
  ports.select(entry);
  inspector.open(entry);
}

/** The ✕ of the inspector. The column goes with its selection; the slide-over leaves it. */
function closeInspector() {
  inspector.close();
  if (inspector.wide.value) ports.clearSelection();
}

async function restart(entry: PortEntry) {
  const outcome = await flow.restart(entry);
  if (outcome.status === "started" && inspector.inspecting.value?.pid === entry.pid) {
    const back = { ...entry, pid: outcome.pid, startedAt: Math.floor(Date.now() / 1000), orphan: false };
    inspector.inspecting.value = back;
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

// A Kill button hands over its ⌥ state; the preference is the base and ⌥ flips it either way.
provideActions({
  select: (entry) => ports.select(entry),
  inspect,
  kill: (entry, alt) =>
    void thenRefreshTaskline(flow.request({ kind: "entry", entry, force: flow.forceFor(alt) })),
  killGroup: (group, alt) =>
    void thenRefreshTaskline(flow.request({ kind: "group", group, force: flow.forceFor(alt) })),
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
      if (entry)
        void thenRefreshTaskline(flow.request({ kind: "entry", entry, force: flow.forceFor(false) }));
    },
    forceKill: () => {
      const entry = ports.selected.value;
      if (!entry) return false;
      void thenRefreshTaskline(flow.request({ kind: "entry", entry, force: flow.forceFor(true) }));
      return true;
    },
    escape: () => {
      // From Preferences, Esc is the way back; the Studio's own Esc chain is untouched.
      if (view.value === "settings") view.value = "studio";
      else if (query.value) ports.clearSearch();
      else if (category.value !== "all") ports.setCategory("all");
      else ports.clearSelection();
    },
    focusSearch: () => {
      view.value = "studio";
      void toolbar.value?.focus("all");
    },
    refresh: () => {
      void ports.refresh();
      void taskline.refresh();
    },
    preferences: () => {
      view.value = "settings";
    },
    digit: (digit) => {
      view.value = "studio";
      query.value = digit;
      void toolbar.value?.focus("end");
    },
  },
  // The slide-over owns the keys while it is up; the column does not.
  { enabled: () => !flow.confirming.value && !inspector.overlay.value },
);

// The tray (WP-4) hands over a protected port: show it and ask. A no-op outside Tauri.
const tray = useTrayListener((payload) => {
  view.value = "studio";
  void selectFromTray(ports, flow, payload);
});
// The tray's Preferences… item (WP-17a) opens the view; a no-op outside Tauri.
let offOpenPreferences: () => void = () => {};

async function confirmed() {
  await flow.confirmed();
  await taskline.refresh();
}

function pickCategory(filter: Parameters<typeof ports.setCategory>[0]) {
  ports.setCategory(filter);
}

function onOverlayOpenChange(open: boolean) {
  if (!open) closeInspector();
}

onMounted(() => {
  void settings.load();
  settings.start();
  ports.start();
  taskline.start();
  keyboard.start();
  void tray.start();
  offOpenPreferences = onOpenPreferences(() => {
    view.value = "settings";
  });
  update.start();
});
onUnmounted(() => {
  update.stop();
  offOpenPreferences();
  tray.stop();
  keyboard.stop();
  taskline.stop();
  ports.stop();
  settings.stop();
});
</script>

<template>
  <TooltipProvider :delay-duration="500" :skip-delay-duration="300">
    <main
      class="grid h-full overflow-hidden bg-canvas text-[13px] text-ink"
      :class="inspector.column.value ? 'grid-cols-[200px_minmax(0,1fr)_320px]' : 'grid-cols-[200px_minmax(0,1fr)]'"
    >
      <Sidebar
        :view="view"
        :category="category"
        :counts="counts"
        :taskline-count="taskline.count.value"
        :update="update.state.value"
        @update:view="(v) => (view = v)"
        @update:category="pickCategory"
        @install="update.install()"
      />

      <section class="@container/main flex min-h-0 min-w-0 flex-col">
        <!-- Preferences brings its own strip; the toolbar stays mounted so the search keeps its text and focus target. -->
        <Toolbar
          v-show="view !== 'settings'"
          ref="toolbar"
          v-model:query="query"
          :view="view"
          :zombies="counts.zombie"
          :zombie-memory-bytes="zombieMemoryBytes"
          :event-count="taskline.count.value"
          @reap="thenRefreshTaskline(flow.reap())"
          @clear="taskline.clear()"
        />
        <template v-if="view === 'studio'">
          <!-- The first run (WP-17b): where the app lives and the one shortcut. Got it stores the flag. -->
          <Onboarding
            v-if="!prefs.onboardingDone"
            :start-at-login="prefs.startAtLogin"
            :quick-shortcut="prefs.quickShortcut"
            @update:start-at-login="(on) => settings.patch({ field: 'startAtLogin', value: on })"
            @done="settings.patch({ field: 'onboardingDone', value: true })"
          />
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
          v-else-if="view === 'taskline'"
          :events="taskline.events.value"
          :loaded="taskline.loaded.value"
          :relaunching="taskline.relaunching"
          :can-relaunch="taskline.canRelaunch"
          @relaunch="(id) => void taskline.relaunch(id).then(() => ports.refresh())"
        />
        <SettingsView
          v-else
          :settings="prefs"
          :error="settings.error"
          :saved="settings.saved"
          :version="version"
          @patch="(p) => settings.patch(p)"
        />
        <!-- In the flow, between the table and the status line: the table shrinks while toasts are up. -->
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
      </section>

      <!-- Wide: the third column. -->
      <div v-if="inspector.column.value && inspected" class="min-h-0 border-l border-line">
        <Inspector :entry="inspected" :reason="inspectedReason" :restart="flow.restarting.value" @close="closeInspector" />
      </div>

      <!-- Narrow: the same panel as a slide-over. Esc, ✕ and a click outside close it. -->
      <DialogRoot :open="inspector.overlay.value" @update:open="onOverlayOpenChange">
        <DialogPortal>
          <DialogOverlay class="fixed inset-0 z-30 bg-ink/20" />
          <DialogContent
            class="fixed inset-y-0 right-0 z-40 w-[320px] max-w-full border-l border-line bg-surface outline-none"
            @open-auto-focus.prevent
          >
            <DialogTitle class="sr-only">Inspector</DialogTitle>
            <DialogDescription class="sr-only">Everything about the selected port and its process.</DialogDescription>
            <Inspector
              v-if="inspected"
              :entry="inspected"
              :reason="inspectedReason"
              :restart="flow.restarting.value"
              @close="closeInspector"
            />
          </DialogContent>
        </DialogPortal>
      </DialogRoot>

      <KillConfirm :target="flow.confirm.value" :reason-for="ports.reasonFor" :ports-of="ports.portsOf" @confirm="confirmed()" @cancel="flow.cancel()" />
    </main>
  </TooltipProvider>
</template>

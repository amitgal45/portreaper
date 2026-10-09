<script setup lang="ts">
// The one window: title strip, the list, the status line. State lives in the composables; the
// components only render it and ask for actions through provide/inject.
import { TooltipProvider } from "reka-ui";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { provideApi } from "./api";
import { copyText, openInBrowser, revealFolder } from "./api/system";
import KillConfirm from "./components/KillConfirm.vue";
import PortTable from "./components/PortTable.vue";
import StatusLine from "./components/StatusLine.vue";
import TitleBar from "./components/TitleBar.vue";
import ToastList from "./components/ToastList.vue";
import { provideActions } from "./composables/useActions";
import { useKeyboard } from "./composables/useKeyboard";
import { useKillFlow } from "./composables/useKillFlow";
import { usePorts } from "./composables/usePorts";
import { useToasts } from "./composables/useToasts";
import { selectFromTray, useTrayListener } from "./composables/useTray";

const api = provideApi();
const ports = usePorts(api);
const toasts = useToasts();
const flow = useKillFlow(ports, toasts);
const {
  query,
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

const titleBar = ref<{ focus(mode?: "all" | "end"): Promise<void> } | null>(null);
/** Rows that match the search; the status line says "N of M ports" while that is fewer than M. */
const shown = computed(() => groups.value.reduce((n, g) => n + g.entries.length, 0));

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

provideActions({
  select: (entry) => ports.select(entry),
  kill: (entry, force) => void flow.request({ kind: "entry", entry, force }),
  killGroup: (group, force) => void flow.request({ kind: "group", group, force }),
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
      if (entry) void flow.request({ kind: "entry", entry, force: false });
    },
    forceKill: () => {
      const entry = ports.selected.value;
      if (!entry) return false;
      void flow.request({ kind: "entry", entry, force: true });
      return true;
    },
    escape: () => {
      if (query.value) ports.clearSearch();
      else ports.clearSelection();
    },
    focusSearch: () => void titleBar.value?.focus("all"),
    refresh: () => void ports.refresh(),
    digit: (digit) => {
      query.value = digit;
      void titleBar.value?.focus("end");
    },
  },
  { enabled: () => !flow.confirming.value },
);

// The tray (WP-4) hands over a protected port: show it and ask. A no-op outside Tauri.
const tray = useTrayListener((payload) => void selectFromTray(ports, flow, payload));

onMounted(() => {
  ports.start();
  keyboard.start();
  void tray.start();
});
onUnmounted(() => {
  tray.stop();
  keyboard.stop();
  ports.stop();
});
</script>

<template>
  <TooltipProvider :delay-duration="500" :skip-delay-duration="300">
    <main class="flex h-full flex-col overflow-hidden bg-white text-[13px] text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      <TitleBar ref="titleBar" v-model:query="query" />
      <PortTable
        :groups="groups"
        :collapsed="collapsed"
        :selected-key="selectedKey"
        :pending="pending"
        :loaded="loaded"
        :query="query"
        :reason-for="ports.reasonFor"
      />
      <!-- In the flow, between the list and the status line: the list shrinks while toasts are up. -->
      <ToastList :toasts="toasts.toasts.value" @dismiss="toasts.dismiss" />
      <StatusLine :shown="shown" :total="total" :projects="projectCount" :last-refresh="lastRefresh" :version="version" :error="error" />
      <KillConfirm :target="flow.confirm.value" :reason-for="ports.reasonFor" :ports-of="ports.portsOf" @confirm="flow.confirmed()" @cancel="flow.cancel()" />
    </main>
  </TooltipProvider>
</template>

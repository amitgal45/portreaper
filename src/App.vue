<script setup lang="ts">
// The one window: title strip, the list, the status line. State lives in the composables; the
// components only render it and ask for actions through provide/inject.
import { TooltipProvider } from "reka-ui";
import { onMounted, onUnmounted, ref } from "vue";
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
  visibleEntries,
  total,
  projectCount,
  lastRefresh,
  version,
  error,
} = ports;

const titleBar = ref<{ focus(mode?: "all" | "end"): Promise<void> } | null>(null);

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

onMounted(() => {
  ports.start();
  keyboard.start();
});
onUnmounted(() => {
  keyboard.stop();
  ports.stop();
});
</script>

<template>
  <TooltipProvider :delay-duration="500" :skip-delay-duration="300">
    <main class="flex h-full flex-col overflow-hidden bg-white text-[13px] text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      <TitleBar ref="titleBar" v-model:query="query" :shown="visibleEntries.length" :total="total" />
      <PortTable
        :groups="groups"
        :collapsed="collapsed"
        :selected-key="selectedKey"
        :pending="pending"
        :loaded="loaded"
        :query="query"
        :reason-for="ports.reasonFor"
      />
      <StatusLine :total="total" :projects="projectCount" :last-refresh="lastRefresh" :version="version" :error="error" />
      <KillConfirm :target="flow.confirm.value" :reason-for="ports.reasonFor" :ports-of="ports.portsOf" @confirm="flow.confirmed()" @cancel="flow.cancel()" />
      <ToastList :toasts="toasts.toasts.value" @dismiss="toasts.dismiss" />
    </main>
  </TooltipProvider>
</template>

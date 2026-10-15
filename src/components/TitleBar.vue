<script setup lang="ts">
// The 44 px strip under the hidden native title bar: the brand mark, the two view tabs, the live
// count and the HUD hint. It drags the window; the tabs do not. The left 78 px stay empty for the
// traffic lights. The search box lives in the filter strip below (v0.2).
import { Clock, LayoutList, Zap } from "lucide-vue-next";

export type View = "studio" | "taskline";

defineProps<{
  view: View;
  /** Events in the Taskline this session: the badge on its tab. */
  tasklineCount: number;
  /** Listening ports right now. */
  total: number;
}>();

const emit = defineEmits<{ "update:view": [view: View] }>();

const tab = (active: boolean) =>
  `flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-coral/40 ${
    active ? "bg-steel text-ink" : "text-ink-muted hover:text-ink"
  }`;
</script>

<template>
  <header
    data-tauri-drag-region
    class="flex h-11 shrink-0 items-center gap-3 border-b border-edge bg-obsidian pr-3 pl-[78px]"
  >
    <div data-tauri-drag-region class="flex select-none items-center gap-2">
      <span class="flex h-6 w-6 items-center justify-center rounded-md bg-coral text-void" aria-hidden="true">
        <Zap :size="13" :stroke-width="2.5" />
      </span>
      <span class="text-[13px] font-bold tracking-tight text-ink">PortReaper</span>
    </div>

    <div role="tablist" aria-label="Views" class="flex items-center gap-0.5 rounded-lg border border-edge bg-void p-0.5">
      <button type="button" role="tab" :aria-selected="view === 'studio'" :class="tab(view === 'studio')" @click="emit('update:view', 'studio')">
        <LayoutList :size="12" :stroke-width="2" class="text-coral" aria-hidden="true" />
        Studio
      </button>
      <button type="button" role="tab" :aria-selected="view === 'taskline'" :class="tab(view === 'taskline')" @click="emit('update:view', 'taskline')">
        <Clock :size="12" :stroke-width="2" class="text-azure" aria-hidden="true" />
        Taskline
        <span
          v-if="tasklineCount > 0"
          data-badge="taskline-count"
          class="flex h-4 min-w-4 items-center justify-center rounded-full bg-coral px-1 font-mono text-[10px] font-bold text-void"
        >
          {{ tasklineCount }}
        </span>
      </button>
    </div>

    <span data-tauri-drag-region class="min-w-0 flex-1" />

    <span data-live-count class="flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-ink-muted tabular-nums">
      <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-signal" aria-hidden="true" />
      {{ total }} {{ total === 1 ? "port" : "ports" }}
    </span>

    <span
      class="hidden shrink-0 items-center gap-1 rounded-md border border-edge bg-void px-1.5 py-0.5 text-[10px] text-ink-muted sm:flex"
      title="The HUD: press ⌘⇧K anywhere"
    >
      <kbd class="font-mono">⌘⇧K</kbd>
      <span>HUD</span>
    </span>
  </header>
</template>

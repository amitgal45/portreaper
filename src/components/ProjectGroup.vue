<script setup lang="ts">
// A project (or a process without one) and its ports. The header sticks while its rows scroll.
import { ChevronRight, Lock } from "lucide-vue-next";
import { computed } from "vue";
import { useActions } from "../composables/useActions";
import { entryKey, type PortGroup } from "../composables/usePorts";
import type { PortEntry } from "../types";
import PortRow from "./PortRow.vue";

const props = defineProps<{
  group: PortGroup;
  collapsed: boolean;
  selectedKey: string | null;
  pending: ReadonlySet<number>;
  reasonFor: (entry: PortEntry) => string;
}>();

const actions = useActions();
const count = computed(
  () => `${props.group.entries.length} ${props.group.entries.length === 1 ? "port" : "ports"}`,
);
</script>

<template>
  <section :data-group="group.key">
    <div
      class="group/header sticky top-0 z-10 flex h-8 items-center gap-2 border-b border-neutral-200 bg-neutral-50 px-3 text-[12px] dark:border-neutral-800 dark:bg-neutral-800"
    >
      <button
        type="button"
        class="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left outline-none focus-visible:underline"
        :aria-expanded="!collapsed"
        @click="actions.toggleGroup(group.key)"
      >
        <ChevronRight :size="12" :stroke-width="2" class="shrink-0 text-neutral-400 transition-transform" :class="!collapsed && 'rotate-90'" />
        <span class="truncate font-medium text-neutral-800 dark:text-neutral-200">{{ group.name }}</span>
        <span v-if="group.branch" class="truncate font-mono text-neutral-500 dark:text-neutral-400">{{ group.branch }}</span>
        <span v-if="group.tool" class="inline-flex h-4 shrink-0 items-center rounded bg-neutral-500/10 px-1 text-[11px] text-neutral-500 dark:text-neutral-400">{{ group.tool }}</span>
        <Lock v-if="group.protected" :size="11" :stroke-width="2" class="shrink-0 text-neutral-400" />
      </button>
      <span class="shrink-0 text-neutral-400 tabular-nums">{{ count }}</span>
      <button
        type="button"
        class="h-6 shrink-0 rounded px-2 text-[12px] text-neutral-600 opacity-0 outline-none hover:bg-neutral-200 hover:text-neutral-900 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-blue-500/50 group-hover/header:opacity-100 dark:text-neutral-300 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
        :title="group.protected ? 'Kill every process in this group (asks first)' : 'Kill every process in this group · ⌥ to force'"
        @click.stop="actions.killGroup(group, $event.altKey)"
      >
        Kill all
      </button>
    </div>
    <TransitionGroup v-if="!collapsed" name="row" tag="div" role="rowgroup">
      <PortRow
        v-for="entry in group.entries"
        :key="entryKey(entry)"
        :entry="entry"
        :selected="entryKey(entry) === selectedKey"
        :pending="pending.has(entry.pid)"
        :show-branch="group.branch === null"
        :show-tool="group.tool === null"
        :reason="entry.protected ? reasonFor(entry) : null"
      />
    </TransitionGroup>
  </section>
</template>

<style scoped>
.row-leave-active {
  transition: opacity 150ms ease;
}
.row-leave-to {
  opacity: 0;
}
</style>

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
  /** Ports a `collisionResolved` named in the last minute. */
  collisions: ReadonlySet<number>;
}>();

const actions = useActions();
const count = computed(
  () => `${props.group.entries.length} ${props.group.entries.length === 1 ? "port" : "ports"}`,
);
</script>

<template>
  <section :data-group="group.key">
    <div
      class="group/header sticky top-0 z-10 flex h-7 items-center gap-2 border-b border-edge bg-obsidian px-3 text-[11px]"
    >
      <button
        type="button"
        class="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left outline-none focus-visible:underline"
        :aria-expanded="!collapsed"
        @click="actions.toggleGroup(group.key)"
      >
        <ChevronRight :size="12" :stroke-width="2" class="shrink-0 text-ink-muted transition-transform" :class="!collapsed && 'rotate-90'" />
        <span class="truncate font-semibold text-ink">{{ group.name }}</span>
        <span v-if="group.branch" class="truncate rounded border border-edge bg-steel px-1 font-mono text-[10px] text-ink-muted">{{ group.branch }}</span>
        <Lock v-if="group.protected" :size="10" :stroke-width="2" class="shrink-0 text-azure" aria-label="protected" />
      </button>
      <span class="shrink-0 font-mono text-ink-muted tabular-nums">{{ count }}</span>
      <button
        type="button"
        class="h-5 shrink-0 rounded px-1.5 text-[11px] text-ink-muted opacity-0 outline-none hover:bg-steel hover:text-coral focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-coral/40 group-hover/header:opacity-100"
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
        :reason="entry.protected ? reasonFor(entry) : null"
        :collision="collisions.has(entry.port)"
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

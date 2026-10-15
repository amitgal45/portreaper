<script setup lang="ts">
// A project (or a process without one) and its ports: a 32 px row with a colour bar, the name,
// the branch in mono and the count. It sticks under the table header while its rows scroll.
import { ChevronDown, Lock } from "lucide-vue-next";
import { computed } from "vue";
import { useActions } from "../composables/useActions";
import { entryKey, type PortGroup } from "../composables/usePorts";
import { groupColour } from "../lib/group-colour";
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
const bar = computed(() => groupColour(props.group.name));
</script>

<template>
  <section :data-group="group.key">
    <div class="group/header sticky top-7 z-10 flex h-8 items-center gap-2 border-b border-line bg-surface px-4 text-[13px]">
      <span class="h-4 w-1 shrink-0 rounded-sm" :class="bar" aria-hidden="true" />
      <button
        type="button"
        class="flex h-full min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:underline"
        :aria-expanded="!collapsed"
        @click="actions.toggleGroup(group.key)"
      >
        <span class="truncate font-semibold text-ink">{{ group.name }}</span>
        <span v-if="group.branch" class="truncate font-mono text-[12px] text-ink-2">{{ group.branch }}</span>
        <Lock v-if="group.protected" :size="11" :stroke-width="2" class="shrink-0 text-blue-ink" aria-label="protected" />
      </button>
      <button
        type="button"
        class="h-6 shrink-0 rounded-md border border-line-strong bg-surface px-2 text-[12px] text-red-ink opacity-0 outline-none hover:bg-hover focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-brand/40 group-hover/header:opacity-100"
        :title="group.protected ? 'Kill every process in this group (asks first)' : 'Kill every process in this group · ⌥ to force'"
        @click.stop="actions.killGroup(group, $event.altKey)"
      >
        Kill all
      </button>
      <span class="shrink-0 text-[12px] text-ink-3 tabular-nums">{{ count }}</span>
      <ChevronDown
        :size="12"
        :stroke-width="2"
        class="shrink-0 text-ink-3 transition-transform"
        :class="collapsed && '-rotate-90'"
        aria-hidden="true"
      />
    </div>
    <TransitionGroup v-if="!collapsed" name="row" tag="div" role="rowgroup">
      <PortRow
        v-for="entry in group.entries"
        :key="entryKey(entry)"
        :entry="entry"
        :selected="entryKey(entry) === selectedKey"
        :pending="pending.has(entry.pid)"
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

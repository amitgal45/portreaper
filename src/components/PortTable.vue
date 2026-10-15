<script setup lang="ts">
// The table: a 28 px header row that sticks, then the groups, or the empty state. Scrolls; the
// strips above and below do not.
import type { CategoryFilter, PortGroup } from "../composables/usePorts";
import { TABLE_COLUMNS, WIDE_ONLY } from "../lib/table-columns";
import type { PortEntry } from "../types";
import ProjectGroup from "./ProjectGroup.vue";

defineProps<{
  groups: PortGroup[];
  collapsed: ReadonlySet<string>;
  selectedKey: string | null;
  pending: ReadonlySet<number>;
  /** False until the first poll answered: show nothing rather than a flash of "no ports". */
  loaded: boolean;
  query: string;
  category: CategoryFilter;
  reasonFor: (entry: PortEntry) => string;
  collisions: ReadonlySet<number>;
}>();

const heading = "truncate text-[11px] font-semibold uppercase tracking-wide text-ink-3";
</script>

<template>
  <div role="grid" aria-label="Listening ports" class="min-h-0 flex-1 overflow-y-auto bg-surface">
    <div :class="[TABLE_COLUMNS, 'sticky top-0 z-20 h-7 border-b border-line bg-surface']" aria-hidden="true">
      <span :class="heading">Port</span>
      <span :class="heading">Process</span>
      <span :class="heading">Status</span>
      <span :class="[heading, WIDE_ONLY, 'text-right']">Memory</span>
      <span :class="[heading, WIDE_ONLY, 'text-right']">Uptime</span>
      <span />
    </div>
    <template v-if="loaded">
      <div v-if="groups.length === 0" class="flex h-[calc(100%-28px)] flex-col items-center justify-center gap-1 px-6 text-center">
        <template v-if="query.trim()">
          <p class="text-ink-2">No ports match “{{ query.trim() }}”.</p>
          <p class="text-[12px] text-ink-3">Esc clears the search.</p>
        </template>
        <template v-else-if="category !== 'all'">
          <p class="text-ink-2">Nothing in this filter.</p>
          <p class="text-[12px] text-ink-3">Pick All ports to see everything.</p>
        </template>
        <template v-else>
          <p class="text-ink-2">No listening ports.</p>
          <p class="text-[12px] text-ink-3">Start a dev server and it will appear here.</p>
        </template>
      </div>
      <ProjectGroup
        v-for="group in groups"
        :key="group.key"
        :group="group"
        :collapsed="collapsed.has(group.key)"
        :selected-key="selectedKey"
        :pending="pending"
        :reason-for="reasonFor"
        :collisions="collisions"
      />
    </template>
  </div>
</template>

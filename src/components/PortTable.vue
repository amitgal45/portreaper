<script setup lang="ts">
// The list: groups of rows, or the empty state. Scrolls; the strips above and below do not.
import type { CategoryFilter, PortGroup } from "../composables/usePorts";
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
</script>

<template>
  <div role="grid" aria-label="Listening ports" class="min-h-0 flex-1 overflow-y-auto">
    <template v-if="loaded">
      <div v-if="groups.length === 0" class="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
        <template v-if="query.trim()">
          <p class="text-ink-muted">No ports match “{{ query.trim() }}”.</p>
          <p class="text-[11px] text-ink-muted">Esc clears the search.</p>
        </template>
        <template v-else-if="category !== 'all'">
          <p class="text-ink-muted">Nothing in this filter.</p>
          <p class="text-[11px] text-ink-muted">Pick All to see every port.</p>
        </template>
        <template v-else>
          <p class="text-ink-muted">No listening ports.</p>
          <p class="text-[11px] text-ink-muted">Start a dev server and it will appear here.</p>
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

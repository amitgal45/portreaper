<script setup lang="ts">
// The list: groups of rows, or the empty state. Scrolls; the title strip and status line do not.
import type { PortGroup } from "../composables/usePorts";
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
  reasonFor: (entry: PortEntry) => string;
}>();
</script>

<template>
  <div role="grid" aria-label="Listening ports" class="min-h-0 flex-1 overflow-y-auto">
    <template v-if="loaded">
      <div v-if="groups.length === 0" class="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
        <template v-if="query.trim()">
          <p class="text-neutral-600 dark:text-neutral-300">No ports match “{{ query.trim() }}”.</p>
          <p class="text-[12px] text-neutral-400">Esc clears the search.</p>
        </template>
        <template v-else>
          <p class="text-neutral-600 dark:text-neutral-300">No listening ports.</p>
          <p class="text-[12px] text-neutral-400">Start a dev server and it will appear here.</p>
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
      />
    </template>
  </div>
</template>

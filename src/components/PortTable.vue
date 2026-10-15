<script setup lang="ts">
// The table: a 28 px header row that sticks, then the groups, or the empty state. Scrolls; the
// strips above and below do not. Under the `watching` filter the watched ports nothing holds
// follow the groups as "free" rows (WP-18): the port, "— free —", and Stop watching, which is
// how a watch on a free port is removed.
import { Eye } from "lucide-vue-next";
import { useActions } from "../composables/useActions";
import type { CategoryFilter, PortGroup } from "../composables/usePorts";
import { TABLE_COLUMNS, WIDE_ONLY } from "../lib/table-columns";
import type { PortEntry, WatchedPort } from "../types";
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
  /** Watched ports that are free, under the `watching` filter; empty under every other. */
  freeRows: WatchedPort[];
}>();

const actions = useActions();

const heading = "truncate text-[11px] font-semibold uppercase tracking-wide text-ink-3";
const stopButton =
  "h-[26px] rounded-md border border-line-strong bg-surface px-2.5 text-[12px] font-medium text-ink-2 outline-none hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40";
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
      <div
        v-if="groups.length === 0 && freeRows.length === 0"
        class="flex h-[calc(100%-28px)] flex-col items-center justify-center gap-1 px-6 text-center"
      >
        <template v-if="query.trim()">
          <p class="text-ink-2">No ports match “{{ query.trim() }}”.</p>
          <p class="text-[12px] text-ink-3">Esc clears the search.</p>
        </template>
        <template v-else-if="category === 'watching'">
          <p class="text-ink-2">No watched ports.</p>
          <p class="text-[12px] text-ink-3">Watch :3000 from a row’s menu and PortReaper will say when it is free.</p>
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
      <section v-if="freeRows.length > 0" data-group="watching:free">
        <div class="sticky top-7 z-10 flex h-8 items-center gap-2 border-b border-line bg-surface px-4 text-[13px]">
          <span class="h-4 w-1 shrink-0 rounded-sm bg-blue" aria-hidden="true" />
          <span class="truncate font-semibold text-ink">Free</span>
          <span class="truncate text-[12px] text-ink-2">watched, nothing listening</span>
          <span class="ml-auto shrink-0 text-[12px] text-ink-3 tabular-nums">
            {{ freeRows.length }} {{ freeRows.length === 1 ? "port" : "ports" }}
          </span>
        </div>
        <div role="rowgroup">
          <div
            v-for="w in freeRows"
            :key="`${w.protocol}:${w.port}`"
            role="row"
            :data-port="w.port"
            data-watch="free"
            :class="[TABLE_COLUMNS, 'h-10 border-b border-line hover:bg-hover']"
          >
            <span class="truncate font-mono text-[15px] font-semibold tracking-tight text-ink-3 tabular-nums">
              {{ w.port }}<span v-if="w.protocol === 'udp'" class="ml-1 text-[10px] font-normal">udp</span>
            </span>
            <span class="truncate text-ink-3">
              — free —<template v-if="w.processName"> · was {{ w.processName }}</template>
            </span>
            <span
              data-badge="watched"
              class="flex items-center text-blue-ink"
              title="Watching: PortReaper will say when something takes this port"
            >
              <Eye :size="14" :stroke-width="2" aria-label="watched" />
            </span>
            <span :class="WIDE_ONLY" />
            <span :class="WIDE_ONLY" />
            <span class="flex items-center justify-end">
              <button type="button" data-action="unwatch" :class="stopButton" @click="actions.watch(w)">
                Stop watching
              </button>
            </span>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

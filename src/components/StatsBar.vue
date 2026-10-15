<script setup lang="ts">
// Four compact tiles over the list: what is listening, what the dev servers hold, the zombies
// and the ports anyone on the network can reach. The last two are buttons: they set the pill.
import { MemoryStick, Plug } from "lucide-vue-next";
import { computed } from "vue";
import type { CategoryFilter } from "../composables/usePorts";
import { formatBytes } from "../lib/format";

const props = defineProps<{
  total: number;
  projects: number;
  /** Memory the web, api and ai processes hold, once per pid. */
  devMemoryBytes: number;
  zombies: number;
  zombieMemoryBytes: number;
  publicCount: number;
  /** The active pill, so the clicked tile reads as pressed. */
  category: CategoryFilter;
}>();

const emit = defineEmits<{ filter: [category: CategoryFilter] }>();

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const devMemory = computed(() => formatBytes(props.devMemoryBytes));
const zombieMemory = computed(() => formatBytes(props.zombieMemoryBytes));

const tile = "flex min-w-0 items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left";
const label = "truncate font-mono text-[10px] uppercase tracking-wider";
const value = "font-mono text-[14px] font-bold leading-5 tabular-nums";
const sub = "truncate text-[10px] text-ink-muted";
const icon = "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[13px] leading-none";

/** A tile that filters: amber or coral while it has something to show, quiet at zero. */
function signal(count: number, pressed: boolean, tone: "amber" | "coral"): string {
  if (count === 0) return `${tile} border-edge bg-obsidian`;
  const on = tone === "amber" ? "border-amber-neon/60 bg-amber-neon/10" : "border-coral/60 bg-coral/10";
  const off =
    tone === "amber"
      ? "border-amber-neon/30 bg-amber-neon/5 hover:border-amber-neon/60"
      : "border-coral/30 bg-coral/5 hover:border-coral/60";
  return `${tile} cursor-default outline-none transition-colors focus-visible:ring-2 focus-visible:ring-coral/40 ${pressed ? on : off}`;
}
</script>

<template>
  <div class="grid shrink-0 grid-cols-2 gap-2 border-b border-edge px-3 py-2 sm:grid-cols-4">
    <div data-tile="ports" :class="[tile, 'border-edge bg-obsidian']">
      <div class="min-w-0">
        <div :class="[label, 'text-ink-muted']">Listening</div>
        <div class="flex items-baseline gap-1.5">
          <span :class="[value, 'text-ink']">{{ total }}</span>
          <span :class="sub">{{ total === 1 ? "port" : "ports" }} · {{ plural(projects, "project") }}</span>
        </div>
      </div>
      <span :class="[icon, 'bg-steel text-ink-muted']" aria-hidden="true"><Plug :size="13" :stroke-width="2" /></span>
    </div>

    <div data-tile="memory" :class="[tile, 'border-edge bg-obsidian']">
      <div class="min-w-0">
        <div :class="[label, 'text-ink-muted']">Dev-server memory</div>
        <div class="flex items-baseline gap-1.5">
          <span :class="[value, 'text-ink']">{{ devMemory }}</span>
          <span :class="sub">web · api · ai</span>
        </div>
      </div>
      <span :class="[icon, 'bg-steel text-ink-muted']" aria-hidden="true"><MemoryStick :size="13" :stroke-width="2" /></span>
    </div>

    <button
      type="button"
      data-tile="zombies"
      :aria-pressed="category === 'zombie'"
      :class="signal(zombies, category === 'zombie', 'amber')"
      title="Dev servers whose terminal is gone. Click to list them."
      @click="emit('filter', 'zombie')"
    >
      <div class="min-w-0">
        <div :class="[label, zombies ? 'text-amber-neon' : 'text-ink-muted']">Zombies</div>
        <div class="flex items-baseline gap-1.5">
          <span :class="[value, zombies ? 'text-amber-neon' : 'text-ink']">{{ zombies }}</span>
          <span :class="sub">{{ zombies ? `${zombieMemory} reclaimable` : "lost terminals" }}</span>
        </div>
      </div>
      <span :class="[icon, zombies ? 'bg-amber-neon/20' : 'bg-steel']" aria-hidden="true">⚡</span>
    </button>

    <button
      type="button"
      data-tile="public"
      :aria-pressed="category === 'public'"
      :class="signal(publicCount, category === 'public', 'coral')"
      title="Bound to every interface: anyone on your network can reach them. Click to list them."
      @click="emit('filter', 'public')"
    >
      <div class="min-w-0">
        <div :class="[label, publicCount ? 'text-coral' : 'text-ink-muted']">Public LAN</div>
        <div class="flex items-baseline gap-1.5">
          <span :class="[value, publicCount ? 'text-coral' : 'text-ink']">{{ publicCount }}</span>
          <span :class="sub">{{ publicCount ? "reachable from your network" : "none exposed" }}</span>
        </div>
      </div>
      <span :class="[icon, publicCount ? 'bg-coral/20' : 'bg-steel']" aria-hidden="true">🌐</span>
    </button>
  </div>
</template>

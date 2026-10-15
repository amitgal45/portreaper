<script setup lang="ts">
// Four 36 px cards under the toolbar: what is listening, what the dev servers hold, the zombies
// and the ports anyone on the Wi-Fi can reach. The last two are buttons: they set the filter.
// Four in a row from 820 px of main column; two per row below.
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
  /** The active filter, so the clicked card reads as pressed. */
  category: CategoryFilter;
}>();

const emit = defineEmits<{ filter: [category: CategoryFilter] }>();

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const devMemory = computed(() => formatBytes(props.devMemoryBytes));
const zombieCaption = computed(() =>
  props.zombies
    ? `${props.zombies === 1 ? "zombie" : "zombies"} · ${formatBytes(props.zombieMemoryBytes)}`
    : "zombies",
);

const card =
  "flex h-9 min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap rounded-lg border px-2.5 text-left";
const quiet = "border-line bg-canvas";
const dot = "h-2 w-2 shrink-0 rounded-full";
const big = "shrink-0 text-[15px] font-semibold tracking-tight tabular-nums";
const caption = "min-w-0 truncate text-[12px] text-ink-2";
const clickable = "outline-none focus-visible:ring-2 focus-visible:ring-brand/40";

/** A card that filters: tinted while it has something to show, quiet at zero, a ring when pressed. */
function signal(count: number, pressed: boolean, tone: "orange" | "red"): string {
  if (count === 0) return `${card} ${quiet} ${clickable}`;
  const tint = tone === "orange" ? "bg-orange-tint" : "bg-red-tint";
  const ring = tone === "orange" ? "ring-orange" : "ring-red";
  return `${card} ${clickable} border-transparent ${tint} ${pressed ? `ring-1 ring-inset ${ring}` : ""}`;
}
</script>

<template>
  <div class="grid shrink-0 grid-cols-2 gap-2 border-b border-line bg-surface px-4 py-2.5 @min-[820px]/main:grid-cols-4">
    <div data-tile="ports" :class="[card, quiet]">
      <span :class="[dot, 'bg-green']" aria-hidden="true" />
      <span :class="[big, 'text-ink']">{{ total }}</span>
      <span :class="caption">{{ total === 1 ? "port" : "ports" }} · {{ plural(projects, "project") }}</span>
    </div>

    <div data-tile="memory" :class="[card, quiet]">
      <span :class="[dot, 'bg-blue']" aria-hidden="true" />
      <span :class="[big, 'text-ink']">{{ devMemory }}</span>
      <span :class="caption">dev servers</span>
    </div>

    <button
      type="button"
      data-tile="zombies"
      :aria-pressed="category === 'zombie'"
      :class="signal(zombies, category === 'zombie', 'orange')"
      title="Dev servers whose terminal is gone. Click to list them."
      @click="emit('filter', 'zombie')"
    >
      <span :class="[dot, 'bg-orange']" aria-hidden="true" />
      <span :class="[big, zombies ? 'text-orange-ink' : 'text-ink']">{{ zombies }}</span>
      <span :class="caption">{{ zombieCaption }}</span>
    </button>

    <button
      type="button"
      data-tile="public"
      :aria-pressed="category === 'public'"
      :class="signal(publicCount, category === 'public', 'red')"
      title="Bound to every interface: anyone on your network can reach them. Click to list them."
      @click="emit('filter', 'public')"
    >
      <span :class="[dot, 'bg-red']" aria-hidden="true" />
      <span :class="[big, publicCount ? 'text-red-ink' : 'text-ink']">{{ publicCount }}</span>
      <span :class="caption">public on your Wi-Fi</span>
    </button>
  </div>
</template>

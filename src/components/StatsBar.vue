<script setup lang="ts">
// The summary line under the toolbar (B v3, spec item 3): what is listening, what the dev servers
// hold, the zombies and the ports anyone on the Wi-Fi can reach. Each item is a dot, a number and
// its label, with no card; the line wraps when the main column is too narrow, and clips nothing.
// The last two items are buttons: they set the filter, and the pressed one gets a ring.
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
  /** The active filter, so the clicked item reads as pressed. */
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

/** 22 px high, 6 px in from each side (so the pressed ring has room), whole: the line wraps between
 *  items, never inside one. 10 px of the line plus 6 of the item put the first dot at 16 px, as in the mock-up. */
const item = "inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 text-left";
const dot = "h-2 w-2 shrink-0 rounded-full";
const number = "text-[13px] font-semibold tabular-nums";
const label = "text-[12px] text-ink-2";
/** The filter items: brand-ink focus ring (3:1 or more on the surface), the hover fill (no tint). */
const clickable = "outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand-ink";

/** Pressed: a 1 px ring in the ink of the item while it has something to show, in ink-2 at zero. No tint. */
function pressedRing(count: number, pressed: boolean, tone: "orange" | "red"): string {
  if (!pressed) return "";
  if (count === 0) return "ring-1 ring-inset ring-ink-2";
  return tone === "orange" ? "ring-1 ring-inset ring-orange-ink" : "ring-1 ring-inset ring-red-ink";
}
</script>

<template>
  <div
    data-summary
    class="flex shrink-0 flex-wrap items-center gap-x-1 gap-y-1 border-b border-line bg-surface px-2.5 py-2"
  >
    <div data-tile="ports" :class="item">
      <span :class="[dot, 'bg-green']" aria-hidden="true" />
      <span :class="[number, 'text-ink']">{{ total }}</span>
      <span :class="label">{{ total === 1 ? "port" : "ports" }} · {{ plural(projects, "project") }}</span>
    </div>

    <div data-tile="memory" :class="item">
      <span :class="[dot, 'bg-blue']" aria-hidden="true" />
      <span :class="[number, 'text-ink']">{{ devMemory }}</span>
      <span :class="label">dev servers</span>
    </div>

    <button
      type="button"
      data-tile="zombies"
      :aria-pressed="category === 'zombie'"
      :class="[item, clickable, pressedRing(zombies, category === 'zombie', 'orange')]"
      title="Dev servers whose terminal is gone. Click to list them."
      @click="emit('filter', 'zombie')"
    >
      <span :class="[dot, 'bg-orange']" aria-hidden="true" />
      <span :class="[number, zombies ? 'text-orange-ink' : 'text-ink']">{{ zombies }}</span>
      <span :class="label">{{ zombieCaption }}</span>
    </button>

    <button
      type="button"
      data-tile="public"
      :aria-pressed="category === 'public'"
      :class="[item, clickable, pressedRing(publicCount, category === 'public', 'red')]"
      title="Bound to every interface: anyone on your network can reach them. Click to list them."
      @click="emit('filter', 'public')"
    >
      <span :class="[dot, 'bg-red']" aria-hidden="true" />
      <span :class="[number, publicCount ? 'text-red-ink' : 'text-ink']">{{ publicCount }}</span>
      <span :class="label">public on your Wi-Fi</span>
    </button>
  </div>
</template>

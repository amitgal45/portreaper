<script setup lang="ts">
// Under the tiles: the search box (⌘F), the six category pills with their counts, and Reap.
// Two rows on purpose: at 560 px the pills alone fill the width.
import { Search, X, Zap } from "lucide-vue-next";
import { computed, nextTick, ref } from "vue";
import type { CategoryCounts, CategoryFilter } from "../composables/usePorts";
import { formatBytes } from "../lib/format";

const props = defineProps<{
  category: CategoryFilter;
  counts: CategoryCounts;
  zombieMemoryBytes: number;
}>();

const emit = defineEmits<{
  "update:category": [category: CategoryFilter];
  reap: [];
}>();

const query = defineModel<string>("query", { default: "" });
const input = ref<HTMLInputElement | null>(null);

/** `all` selects the text (⌘F); `end` puts the caret after it (a digit typed from the list). */
async function focus(mode: "all" | "end" = "all") {
  await nextTick();
  const el = input.value;
  if (!el) return;
  el.focus();
  if (mode === "all") el.select();
  else el.setSelectionRange(el.value.length, el.value.length);
}

function clear() {
  query.value = "";
  void focus();
}

defineExpose({ focus });

interface Pill {
  key: CategoryFilter;
  label: string;
  /** The text colour while the pill is not pressed; the signals keep their colour. */
  tone: string;
}

const pills: Pill[] = [
  { key: "all", label: "All", tone: "text-ink-muted hover:text-ink" },
  { key: "dev", label: "Dev servers", tone: "text-ink-muted hover:text-ink" },
  { key: "ai", label: "Local AI", tone: "text-violet hover:text-ink" },
  { key: "db", label: "Databases", tone: "text-azure hover:text-ink" },
  { key: "zombie", label: "⚡ Zombies", tone: "text-amber-neon hover:text-ink" },
  { key: "public", label: "🌐 Public LAN", tone: "text-coral hover:text-ink" },
];

const zombies = computed(() => props.counts.zombie);
const reclaim = computed(() => formatBytes(props.zombieMemoryBytes));
</script>

<template>
  <div class="flex shrink-0 flex-col gap-1.5 border-b border-edge bg-obsidian px-3 py-1.5">
    <div class="flex items-center gap-2">
      <label class="relative flex h-7 min-w-0 flex-1 items-center" style="max-width: 24rem">
        <Search :size="13" :stroke-width="2" class="pointer-events-none absolute left-2 text-ink-muted" aria-hidden="true" />
        <input
          ref="input"
          v-model="query"
          type="text"
          autofocus
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="Port, process, project or branch"
          aria-label="Search ports"
          class="h-7 w-full select-text rounded-md border border-edge bg-void pr-10 pl-7 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-coral/60 focus:ring-2 focus:ring-coral/20"
        />
        <button
          v-if="query"
          type="button"
          class="absolute right-1 flex h-5 w-5 items-center justify-center rounded text-ink-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-coral/40"
          aria-label="Clear search"
          title="Clear (Esc)"
          @click="clear"
        >
          <X :size="12" :stroke-width="2" />
        </button>
        <kbd
          v-else
          class="pointer-events-none absolute right-1.5 rounded border border-edge bg-obsidian px-1 font-mono text-[10px] text-ink-muted"
          aria-hidden="true"
        >
          ⌘F
        </kbd>
      </label>

      <span class="flex-1" />

      <button
        type="button"
        data-action="reap"
        class="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-amber-neon/30 bg-steel px-2.5 text-[11px] font-semibold text-amber-neon outline-none transition-colors enabled:hover:border-amber-neon/60 enabled:hover:bg-amber-neon/10 focus-visible:ring-2 focus-visible:ring-coral/40 disabled:opacity-40"
        :disabled="zombies === 0"
        :title="zombies ? 'Kill every dev server whose terminal is gone' : 'No lost-terminal servers right now'"
        @click="emit('reap')"
      >
        <Zap :size="12" :stroke-width="2" aria-hidden="true" />
        <span>Reap {{ zombies }} {{ zombies === 1 ? "zombie" : "zombies" }}</span>
        <span v-if="zombies" class="font-mono text-[10px] font-normal text-ink-muted">({{ reclaim }})</span>
      </button>
    </div>

    <div role="group" aria-label="Filter by category" class="pills flex items-center gap-1 overflow-x-auto">
      <button
        v-for="pill in pills"
        :key="pill.key"
        type="button"
        :data-pill="pill.key"
        :aria-pressed="category === pill.key"
        class="flex h-6 shrink-0 items-center gap-1 rounded-md border px-2 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-coral/40"
        :class="category === pill.key ? 'border-edge bg-steel text-ink' : `border-transparent ${pill.tone}`"
        @click="emit('update:category', pill.key)"
      >
        <span>{{ pill.label }}</span>
        <span class="font-mono text-[10px] tabular-nums opacity-80">{{ counts[pill.key] }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.pills::-webkit-scrollbar {
  display: none;
}
</style>

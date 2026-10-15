<script setup lang="ts">
// The 52 px strip over the main column. Studio: the search field (⌘F), Reap, and the ⌘⇧K hint.
// Taskline: the event count and Clear. The empty space drags the window.
import { Search, X, Zap } from "lucide-vue-next";
import { computed, nextTick, ref } from "vue";
import { formatBytes } from "../lib/format";
import type { View } from "./Sidebar.vue";

const props = defineProps<{
  view: View;
  zombies: number;
  zombieMemoryBytes: number;
  /** Events in the Taskline this session. */
  eventCount: number;
}>();

const emit = defineEmits<{ reap: []; clear: [] }>();

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

const reclaim = computed(() => formatBytes(props.zombieMemoryBytes));
const reapTitle = computed(() =>
  props.zombies
    ? `Kill every dev server whose terminal is gone (${reclaim.value} back)`
    : "No lost-terminal servers right now",
);

const button =
  "inline-flex h-[30px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-brand/40";
</script>

<template>
  <div
    data-tauri-drag-region
    class="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line bg-surface px-4"
  >
    <template v-if="view === 'studio'">
      <label class="relative flex h-[30px] w-full max-w-[320px] min-w-0 items-center">
        <Search :size="14" :stroke-width="2" class="pointer-events-none absolute left-2.5 text-ink-3" aria-hidden="true" />
        <input
          ref="input"
          v-model="query"
          type="text"
          autofocus
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="Search ports"
          title="By port, process, project or branch"
          aria-label="Search ports"
          class="h-full w-full select-text rounded-lg border border-line bg-canvas pr-10 pl-8 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-line-strong focus:ring-2 focus:ring-brand/20"
        />
        <button
          v-if="query"
          type="button"
          class="absolute right-1.5 flex h-5 w-5 items-center justify-center rounded text-ink-3 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40"
          aria-label="Clear search"
          title="Clear (Esc)"
          @click="clear"
        >
          <X :size="12" :stroke-width="2" />
        </button>
        <kbd v-else class="pointer-events-none absolute right-2.5 font-mono text-[11px] text-ink-3" aria-hidden="true">⌘F</kbd>
      </label>

      <button
        type="button"
        data-action="reap"
        :class="[button, 'border-orange bg-orange-tint text-orange-ink enabled:hover:brightness-95 disabled:opacity-50']"
        :disabled="zombies === 0"
        :title="reapTitle"
        @click="emit('reap')"
      >
        <Zap :size="13" :stroke-width="2" aria-hidden="true" />
        <span>Reap {{ zombies }} {{ zombies === 1 ? "zombie" : "zombies" }}</span>
      </button>
    </template>

    <template v-else>
      <span class="truncate text-[13px] text-ink-2">
        {{ eventCount }} {{ eventCount === 1 ? "event" : "events" }} this session
      </span>
      <button
        type="button"
        :class="[button, 'border-line-strong bg-surface text-ink enabled:hover:bg-hover disabled:opacity-50']"
        :disabled="eventCount === 0"
        @click="emit('clear')"
      >
        Clear
      </button>
    </template>

    <span data-tauri-drag-region class="min-w-0 flex-1" />

    <span
      class="hidden shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-line px-1.5 py-1 font-mono text-[11px] text-ink-3 @min-[520px]/main:inline-flex"
      title="Quick kill: press ⌘⇧K anywhere"
    >
      <kbd>⌘⇧K</kbd>
      <span class="font-sans">Quick kill</span>
    </span>
  </div>
</template>

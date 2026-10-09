<script setup lang="ts">
// The 44 px strip under the hidden native title bar. It drags the window; the search box does not.
// The left 78 px stay empty for the traffic lights. The right side is empty on purpose: the counts
// live in the status line.
import { Search, X } from "lucide-vue-next";
import { nextTick, ref } from "vue";

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
</script>

<template>
  <header
    data-tauri-drag-region
    class="flex h-11 shrink-0 items-center gap-3 border-b border-neutral-200 pr-3 pl-[78px] dark:border-neutral-800"
  >
    <label class="relative flex h-7 min-w-0 flex-1 items-center" style="max-width: 22rem">
      <Search :size="13" :stroke-width="2" class="pointer-events-none absolute left-2 text-neutral-400" aria-hidden="true" />
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
        class="h-7 w-full select-text rounded-md border border-neutral-300 bg-neutral-100/70 pr-7 pl-7 text-[13px] text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-500/25 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:focus:bg-neutral-800"
      />
      <button
        v-if="query"
        type="button"
        class="absolute right-1 flex h-5 w-5 items-center justify-center rounded text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
        aria-label="Clear search"
        title="Clear (Esc)"
        @click="clear"
      >
        <X :size="12" :stroke-width="2" />
      </button>
    </label>
  </header>
</template>

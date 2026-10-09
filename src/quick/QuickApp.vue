<script setup lang="ts">
// The Quick strip ("Free a port…", ⌘⇧K): one input, up to six rows, one footer line. Keyboard
// only; the Rust side (WP-8a) shows and positions the 480×320 window and hides it on blur.
import { Check, LoaderCircle, Lock, Search } from "lucide-vue-next";
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { provideApi } from "../api";
import { quickKey } from "./match";
import { useQuick } from "./useQuick";

const input = ref<HTMLInputElement | null>(null);

/** The caret belongs in the input: on mount and every time the window gets focus. */
function focusInput() {
  void nextTick(() => input.value?.focus());
}

const api = provideApi();
const quick = useQuick(api, { onFocus: focusInput });
const { query, matches, selected, numeric, emptyText, loaded, error, armed, result, busy } = quick;

const selectedId = computed(() => (selected.value ? quickKey(selected.value) : null));
const optionId = (key: string) => `quick-option-${key}`;

onMounted(() => {
  quick.start();
  focusInput();
});
onUnmounted(() => quick.stop());
</script>

<template>
  <main class="flex h-screen flex-col overflow-hidden bg-white text-[13px] text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
    <label class="flex h-14 shrink-0 items-center gap-3 border-b border-neutral-200 px-4 dark:border-neutral-800">
      <Search :size="18" :stroke-width="2" class="shrink-0 text-neutral-400" aria-hidden="true" />
      <input
        ref="input"
        v-model="query"
        type="text"
        autofocus
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        placeholder="Port, process or project"
        aria-label="Free a port"
        role="combobox"
        aria-controls="quick-list"
        :aria-expanded="matches.length > 0"
        :aria-activedescendant="selectedId ? optionId(selectedId) : undefined"
        class="h-full min-w-0 flex-1 select-text bg-transparent text-[16px] text-neutral-900 outline-none placeholder:text-neutral-400 dark:text-neutral-100"
        :class="numeric && 'font-mono tabular-nums'"
      />
    </label>

    <div id="quick-list" role="listbox" aria-label="Matches" class="min-h-0 flex-1 overflow-hidden">
      <template v-if="loaded">
        <p v-if="emptyText" class="flex h-10 items-center px-4 text-neutral-400">{{ emptyText }}</p>
        <div
          v-for="e in matches"
          :key="quickKey(e)"
          :id="optionId(quickKey(e))"
          role="option"
          :aria-selected="selectedId === quickKey(e)"
          :data-port="e.port"
          :data-pid="e.pid"
          class="flex h-10 items-center gap-3 px-4"
          :class="selectedId === quickKey(e) ? 'bg-blue-500/10 dark:bg-blue-400/15' : ''"
          @click="quick.select(e)"
        >
          <!-- After Enter: the row is the answer for a moment. -->
          <template v-if="result?.key === quickKey(e)">
            <Check v-if="result.ok" :size="14" :stroke-width="2.5" class="shrink-0 text-green-600 dark:text-green-400" aria-hidden="true" />
            <span class="min-w-0 truncate" :class="result.ok ? '' : 'text-red-600 dark:text-red-400'">{{ result.text }}</span>
          </template>

          <!-- A protected row after its first Enter: asks once more. -->
          <template v-else-if="armed?.key === quickKey(e)">
            <Lock :size="13" :stroke-width="2" class="shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            <!-- The hint never breaks mid-sentence: when the statement is long it moves whole to a second line. -->
            <span class="line-clamp-2 min-w-0 flex-1 text-[12px] leading-tight">
              {{ armed.text }}
              <span class="inline-block whitespace-nowrap text-neutral-500 dark:text-neutral-400">{{ armed.hint }}</span>
            </span>
            <span class="shrink-0 text-[11px] text-neutral-500 dark:text-neutral-400">↩ kill</span>
          </template>

          <template v-else>
            <span class="w-14 shrink-0 font-mono font-semibold tabular-nums">
              {{ e.port }}<span v-if="e.protocol === 'udp'" class="ml-1 text-[10px] font-normal text-neutral-400">udp</span>
            </span>
            <span class="shrink-0 truncate" style="max-width: 11rem">
              <span class="font-medium">{{ e.processName }}</span>
              <span class="ml-1 text-neutral-500 tabular-nums">{{ e.pid }}</span>
            </span>
            <span v-if="e.project" class="min-w-0 flex-1 truncate text-neutral-500">
              {{ e.project.name }}<template v-if="e.project.branch"> · <span class="font-mono text-[12px]">{{ e.project.branch }}</span></template>
            </span>
            <span v-else class="min-w-0 flex-1" />
            <span
              v-if="e.bind === 'any'"
              class="inline-flex h-4 shrink-0 items-center rounded bg-red-500/10 px-1 text-[11px] font-medium text-red-600 dark:text-red-400"
              title="reachable from your network"
            >exposed</span>
            <Lock
              v-if="e.protected"
              :size="11"
              :stroke-width="2"
              class="shrink-0 text-neutral-400"
              aria-label="protected"
              title="protected — asks twice"
            />
            <template v-if="selectedId === quickKey(e)">
              <LoaderCircle v-if="busy" :size="13" class="shrink-0 animate-spin text-neutral-400" aria-label="freeing" />
              <span v-else class="shrink-0 text-[11px] text-neutral-500 dark:text-neutral-400">↩ free</span>
            </template>
          </template>
        </div>
      </template>
    </div>

    <footer class="flex h-6 shrink-0 items-center border-t border-neutral-200 px-4 text-[11px] text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
      <span v-if="error" class="min-w-0 truncate text-red-600 dark:text-red-400" :title="error">could not refresh: {{ error }}</span>
      <span v-else class="truncate">↑↓ choose · ↩ free · ⌥↩ force · esc close</span>
    </footer>
  </main>
</template>

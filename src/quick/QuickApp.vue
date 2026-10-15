<script setup lang="ts">
// The Quick strip ("Free a port…", ⌘⇧K) on the Cyber Scythe tokens: one header line, one
// input, up to six rows, one footer line. Keyboard only; the Rust side (WP-8a) shows and
// positions the 480×320 window and hides it on blur; after a kill the page hides it itself.
// Heights add up to the window: 22 + 44 + (6 × 34 + 5 × 2 + 12) + 24 = 316.
import { Check, LoaderCircle, Lock, Search } from "lucide-vue-next";
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { provideApi } from "../api";
import { formatBytes } from "../lib/format";
import type { PortEntry } from "../types";
import { isZombie, quickKey } from "./match";
import { useQuick } from "./useQuick";

const input = ref<HTMLInputElement | null>(null);

/** The caret belongs in the input: on mount and every time the window gets focus. */
function focusInput() {
  void nextTick(() => input.value?.focus());
}

const api = provideApi();
const quick = useQuick(api, { onFocus: focusInput });
const { entries, query, matches, selected, numeric, emptyText, loaded, error, armed, result, busy } = quick;

const selectedId = computed(() => (selected.value ? quickKey(selected.value) : null));
const optionId = (key: string) => `quick-option-${key}`;
const portCount = computed(() => `${entries.value.length} ${entries.value.length === 1 ? "port" : "ports"}`);

/**
 * The category chip at the right of a row. `other` has none. An `ai` row's chip carries the
 * memory the process holds, the one thing to know about a local model before killing it.
 */
const CHIP_CLASS: Record<PortEntry["category"], string> = {
  web: "bg-steel text-ink-muted",
  api: "bg-steel text-ink-muted",
  db: "bg-azure/15 text-azure",
  ai: "bg-violet/15 text-violet",
  system: "bg-azure/15 text-azure",
  other: "",
};
function chipText(e: PortEntry): string {
  if (e.category === "other") return "";
  if (e.category === "ai") return `AI · ${formatBytes(e.memoryBytes)}`;
  return e.category;
}

onMounted(() => {
  quick.start();
  focusInput();
});
onUnmounted(() => quick.stop());
</script>

<template>
  <main class="flex h-screen flex-col overflow-hidden bg-void text-[13px] text-ink">
    <header
      data-tauri-drag-region
      class="flex h-[22px] shrink-0 items-center px-3 text-[11px] text-ink-faint"
    >
      <span class="truncate"><span class="font-semibold text-coral">PortReaper</span> · {{ portCount }} · ⌘⇧K</span>
    </header>

    <label class="flex h-11 shrink-0 items-center gap-3 border-b border-edge px-3">
      <Search :size="16" :stroke-width="2" class="shrink-0 text-ink-faint" aria-hidden="true" />
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
        class="h-full min-w-0 flex-1 select-text bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-faint"
        :class="numeric && 'font-mono tabular-nums'"
      />
    </label>

    <div
      id="quick-list"
      role="listbox"
      aria-label="Matches"
      class="flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden p-1.5"
    >
      <template v-if="loaded">
        <p v-if="emptyText" class="flex h-[34px] items-center px-2.5 text-ink-faint">{{ emptyText }}</p>
        <div
          v-for="e in matches"
          :key="quickKey(e)"
          :id="optionId(quickKey(e))"
          role="option"
          :aria-selected="selectedId === quickKey(e)"
          :data-port="e.port"
          :data-pid="e.pid"
          :data-category="e.category"
          class="flex h-[34px] shrink-0 items-center gap-2.5 rounded-md bg-obsidian px-2.5"
          :class="selectedId === quickKey(e) ? 'bg-steel ring-1 ring-inset ring-coral' : ''"
          @click="quick.select(e)"
        >
          <!-- After Enter: the row is the answer for a moment. -->
          <template v-if="result?.key === quickKey(e)">
            <Check v-if="result.ok" :size="14" :stroke-width="2.5" class="shrink-0 text-emerald-signal" aria-hidden="true" />
            <span class="min-w-0 truncate" :class="result.ok ? 'text-emerald-signal' : 'text-coral'">{{ result.text }}</span>
          </template>

          <!-- A protected row after its first Enter: asks once more. -->
          <template v-else-if="armed?.key === quickKey(e)">
            <Lock :size="13" :stroke-width="2" class="shrink-0 text-amber-neon" aria-hidden="true" />
            <!-- The hint never breaks mid-sentence: when the statement is long it moves whole to a second line. -->
            <span class="line-clamp-2 min-w-0 flex-1 text-[12px] leading-tight">
              {{ armed.text }}
              <span class="inline-block whitespace-nowrap text-ink-muted">{{ armed.hint }}</span>
            </span>
            <span class="shrink-0 text-[11px] text-ink-muted">↩ kill</span>
          </template>

          <template v-else>
            <span class="w-16 shrink-0 font-mono font-semibold tabular-nums">
              <span
                v-if="isZombie(e)"
                role="img"
                aria-label="lost terminal"
                title="lost terminal: the shell that started it is gone"
                class="mr-0.5 text-amber-neon"
              >⚡</span>{{ e.port }}<span v-if="e.protocol === 'udp'" class="ml-1 text-[10px] font-normal text-ink-faint">udp</span>
            </span>
            <span class="shrink-0 truncate" style="max-width: 10rem">
              <span class="font-medium">{{ e.processName }}</span>
              <span class="ml-1 text-ink-muted tabular-nums">{{ e.pid }}</span>
            </span>
            <span v-if="e.project" class="min-w-0 flex-1 truncate text-ink-muted">
              {{ e.project.name }}<template v-if="e.project.branch"> · <span class="font-mono text-[12px]">{{ e.project.branch }}</span></template>
            </span>
            <span v-else class="min-w-0 flex-1" />
            <span
              v-if="e.bind === 'any'"
              class="inline-flex h-4 shrink-0 items-center rounded bg-coral/15 px-1 text-[11px] font-medium text-coral"
              title="reachable from your network"
            >exposed</span>
            <span
              v-if="chipText(e)"
              data-chip
              class="inline-flex h-4 shrink-0 items-center rounded px-1 font-mono text-[10px] tracking-wide"
              :class="CHIP_CLASS[e.category]"
            >{{ chipText(e) }}</span>
            <Lock
              v-if="e.protected"
              :size="11"
              :stroke-width="2"
              class="shrink-0 text-azure"
              aria-label="protected"
              title="protected — asks twice"
            />
            <template v-if="selectedId === quickKey(e)">
              <LoaderCircle v-if="busy" :size="13" class="shrink-0 animate-spin text-ink-faint" aria-label="freeing" />
              <span v-else class="shrink-0 text-[11px] text-ink-muted">↩ free</span>
            </template>
          </template>
        </div>
      </template>
    </div>

    <footer class="flex h-6 shrink-0 items-center border-t border-edge px-3 text-[11px] text-ink-faint">
      <span v-if="error" class="min-w-0 truncate text-coral" :title="error">could not refresh: {{ error }}</span>
      <span v-else class="truncate">↑↓ choose · ↩ free · ⌥↩ force · esc close</span>
    </footer>
  </main>
</template>

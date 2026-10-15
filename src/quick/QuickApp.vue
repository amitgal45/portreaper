<script setup lang="ts">
// The Quick strip ("Free a port…", ⌘⇧K) on the Board tokens (WP-15b): one header line on the
// canvas, one input, up to six rows on a surface card, one footer line. Light and dark follow
// the system. Keyboard only; the Rust side (WP-8a) shows and positions the 480×320 window and
// hides it on blur; after a kill the page hides it itself.
// Heights add up to the window: 24 + 44 + 6 + (2 + 6 × 36) + 4 + 24 = 320.
import { Check, LoaderCircle, Lock, Search, Zap } from "lucide-vue-next";
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { provideApi } from "../api";
import FrameworkIcon from "../components/FrameworkIcon.vue";
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
 * The status pill at the right of a row: one at most, a solid colour with white text. Protected
 * first, since it is what makes Enter ask twice; then the lost terminal (what the strip is for);
 * then the network exposure; then a local model with the memory it holds, the one thing to know
 * before killing it. A plain running dev server has none.
 */
type Status = "protected" | "zombie" | "public" | "ai";
interface StatusPill {
  kind: Status;
  text: string;
  title: string;
}
const PILL_CLASS: Record<Status, string> = {
  protected: "bg-blue",
  zombie: "bg-orange",
  public: "bg-red",
  ai: "bg-purple",
};
function statusOf(e: PortEntry): StatusPill | null {
  if (e.protected) return { kind: "protected", text: "Protected", title: "protected — asks twice" };
  if (isZombie(e)) {
    return { kind: "zombie", text: "Zombie", title: "lost terminal: the shell that started it is gone" };
  }
  if (e.bind === "any") return { kind: "public", text: "Public", title: "reachable from your network" };
  if (e.category === "ai") {
    return {
      kind: "ai",
      text: `AI · ${formatBytes(e.memoryBytes)}`,
      title: "a local model server, and the memory it holds",
    };
  }
  return null;
}

/** The matches with what the template derives per row, computed once per list. */
const rows = computed(() =>
  matches.value.map((e) => ({ e, key: quickKey(e), zombie: isZombie(e), status: statusOf(e) })),
);

/**
 * The row's background follows its moment: the result tint after Enter, the warning tint while
 * a protected row waits for its second Enter, the selection tint otherwise. The selected row
 * keeps its 3 px brand bar through every state.
 */
function rowClass(key: string): string[] {
  const isSelected = selectedId.value === key;
  const classes: string[] = [];
  if (isSelected) classes.push("shadow-[inset_3px_0_0_var(--brand)]");
  if (result.value?.key === key) classes.push(result.value.ok ? "bg-green-tint" : "bg-red-tint");
  else if (armed.value?.key === key) classes.push("bg-orange-tint");
  else if (isSelected) classes.push("bg-sel");
  return classes;
}

onMounted(() => {
  quick.start();
  focusInput();
});
onUnmounted(() => quick.stop());
</script>

<template>
  <main class="flex h-screen flex-col overflow-hidden bg-canvas text-[13px] text-ink">
    <header
      data-tauri-drag-region
      class="flex h-6 shrink-0 items-center gap-1.5 px-3 text-[11px] text-ink-3"
    >
      <span
        data-tauri-drag-region
        class="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] bg-brand text-white"
        aria-hidden="true"
      >
        <Zap :size="9" :stroke-width="3" />
      </span>
      <span data-tauri-drag-region class="truncate"><span class="font-semibold">PortReaper</span> · {{ portCount }} · ⌘⇧K</span>
    </header>

    <label class="mx-2 flex h-11 shrink-0 items-center gap-2.5 rounded-lg border border-line bg-surface px-3">
      <Search :size="15" :stroke-width="2" class="shrink-0 text-ink-3" aria-hidden="true" />
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
        class="h-full min-w-0 flex-1 select-text bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-3"
        :class="numeric && 'font-mono tabular-nums'"
      />
    </label>

    <div
      id="quick-list"
      role="listbox"
      aria-label="Matches"
      class="mx-2 mt-1.5 mb-1 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-surface"
    >
      <template v-if="loaded">
        <p v-if="emptyText" class="flex h-9 items-center px-3 text-ink-3">{{ emptyText }}</p>
        <div
          v-for="{ e, key, zombie, status } in rows"
          :key="key"
          :id="optionId(key)"
          role="option"
          :aria-selected="selectedId === key"
          :data-port="e.port"
          :data-pid="e.pid"
          :data-category="e.category"
          class="flex h-9 shrink-0 items-center gap-2.5 border-b border-line px-3 last:border-b-0"
          :class="rowClass(key)"
          @click="quick.select(e)"
        >
          <!-- After Enter: the row is the answer for a moment. -->
          <template v-if="result?.key === key">
            <Check v-if="result.ok" :size="14" :stroke-width="2.5" class="shrink-0 text-green-ink" aria-hidden="true" />
            <span class="min-w-0 truncate font-medium" :class="result.ok ? 'text-green-ink' : 'text-red-ink'">{{ result.text }}</span>
          </template>

          <!-- A protected row after its first Enter: asks once more. -->
          <template v-else-if="armed?.key === key">
            <Lock :size="13" :stroke-width="2" class="shrink-0 text-orange-ink" aria-hidden="true" />
            <!-- The hint never breaks mid-sentence: when the statement is long it moves whole to a second line. -->
            <span class="line-clamp-2 min-w-0 flex-1 text-[12px] leading-tight text-ink">
              {{ armed.text }}
              <span class="inline-block whitespace-nowrap text-ink-2">{{ armed.hint }}</span>
            </span>
            <span class="shrink-0 text-[11px] text-ink-3">↩ kill</span>
          </template>

          <template v-else>
            <span class="min-w-16 shrink-0 font-mono text-[15px] font-semibold tracking-[-0.01em] tabular-nums">
              <span
                v-if="zombie"
                role="img"
                aria-label="lost terminal"
                title="lost terminal: the shell that started it is gone"
                class="mr-0.5 text-[13px]"
              >⚡</span>{{ e.port }}<span v-if="e.protocol === 'udp'" class="ml-1 font-sans text-[10px] font-normal text-ink-3">udp</span>
            </span>
            <span class="shrink-0 truncate" style="max-width: 10rem">
              <span class="font-semibold">{{ e.processName }}</span>
              <span class="ml-1 font-mono text-[12px] text-ink-3 tabular-nums">{{ e.pid }}</span>
            </span>
            <span v-if="e.project" class="min-w-0 flex-1 truncate text-ink-2">
              {{ e.project.name }}<template v-if="e.project.branch"> · <span class="font-mono text-[12px]">{{ e.project.branch }}</span></template>
            </span>
            <span v-else class="min-w-0 flex-1" />
            <!-- A brand mark for a known stack; a soft text pill when the stack has a name but no mark. -->
            <FrameworkIcon :entry="e" :size="16">
              <span
                v-if="e.framework"
                :data-framework="e.framework"
                :title="e.framework"
                class="inline-block h-5 max-w-28 shrink-0 truncate rounded-full border border-line bg-canvas px-2 text-[11px] font-medium leading-[18px] text-ink-2"
              >{{ e.framework }}</span>
            </FrameworkIcon>
            <span
              v-if="status"
              :data-status="status.kind"
              :title="status.title"
              class="inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium whitespace-nowrap text-white"
              :class="PILL_CLASS[status.kind]"
            >{{ status.text }}</span>
            <template v-if="selectedId === key">
              <LoaderCircle v-if="busy" :size="13" class="shrink-0 animate-spin text-ink-3" aria-label="freeing" />
              <span v-else class="shrink-0 text-[11px] text-ink-3">↩ free</span>
            </template>
          </template>
        </div>
      </template>
    </div>

    <footer class="flex h-6 shrink-0 items-center px-3 text-[11px] text-ink-3">
      <span v-if="error" class="min-w-0 truncate text-red-ink" :title="error">could not refresh: {{ error }}</span>
      <span v-else class="truncate">↑↓ choose · ↩ free · ⌥↩ force · esc close</span>
    </footer>
  </main>
</template>

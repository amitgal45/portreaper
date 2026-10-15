<script setup lang="ts">
// The 30 px line under the table: the poller's dot (green while it answers, red while it does
// not), "11 ports · 7 projects · scan 3 ms · last refresh 1 s ago", the poll error when there is
// one, and at the right the key hints and the version. While a search or a filter narrows the
// list: "2 of 11 ports · …".
import { computed, onMounted, onUnmounted, ref } from "vue";

const props = defineProps<{
  /** Rows that match the search and the filter. */
  shown: number;
  /** Rows the core reported. */
  total: number;
  projects: number;
  /** ms epoch of the last successful poll. */
  lastRefresh: number | null;
  /** Round-trip of the last `listPorts()`, in ms. */
  scanMs: number | null;
  version: string;
  error: string | null;
}>();

const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});
onUnmounted(() => {
  if (timer !== null) clearInterval(timer);
});

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const ago = computed(() => {
  if (props.lastRefresh === null) return "never";
  const s = Math.max(0, Math.round((now.value - props.lastRefresh) / 1000));
  if (s < 60) return `${s} s ago`;
  return `${Math.floor(s / 60)} min ago`;
});

const text = computed(() => {
  const ports =
    props.shown < props.total
      ? `${props.shown} of ${plural(props.total, "port")}`
      : plural(props.total, "port");
  const parts = [ports, plural(props.projects, "project")];
  if (props.scanMs !== null) parts.push(`scan ${props.scanMs} ms`);
  parts.push(`last refresh ${ago.value}`);
  return parts.join(" · ");
});

const version = computed(() => {
  if (!props.version) return "";
  return /^\d/.test(props.version) ? `v${props.version}` : props.version;
});
</script>

<template>
  <footer class="flex h-[30px] shrink-0 items-center gap-2.5 border-t border-line bg-surface px-4 text-[12px] text-ink-3">
    <span class="h-[7px] w-[7px] shrink-0 rounded-full" :class="error ? 'bg-red' : 'bg-green'" aria-hidden="true" />
    <span class="shrink-0 tabular-nums">{{ text }}</span>
    <span v-if="error" class="min-w-0 truncate text-red-ink" :title="error">· could not refresh: {{ error }}</span>
    <span class="ml-auto hidden shrink-0 whitespace-nowrap tabular-nums @min-[560px]/main:inline">
      ↑↓ select · ↩ kill · ⌥↩ force<template v-if="version"> · {{ version }}</template>
    </span>
  </footer>
</template>

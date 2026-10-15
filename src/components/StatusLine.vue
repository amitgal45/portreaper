<script setup lang="ts">
// "11 ports · 7 projects · scan 3 ms · last refresh 1 s ago · v0.2.0", and the poll error when
// there is one. While a search or a pill narrows the list: "2 of 11 ports · …". The dot is the
// poller: emerald while it answers, coral while it does not.
import { computed, onMounted, onUnmounted, ref } from "vue";

const props = defineProps<{
  /** Rows that match the search and the pill. */
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
  if (props.version) parts.push(/^\d/.test(props.version) ? `v${props.version}` : props.version);
  return parts.join(" · ");
});
</script>

<template>
  <footer class="flex h-6 shrink-0 items-center gap-2 border-t border-edge bg-obsidian px-3 font-mono text-[10px] text-ink-muted">
    <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="error ? 'bg-coral' : 'bg-emerald-signal'" aria-hidden="true" />
    <span class="shrink-0 tabular-nums">{{ text }}</span>
    <span v-if="error" class="min-w-0 truncate text-coral" :title="error">· could not refresh: {{ error }}</span>
  </footer>
</template>

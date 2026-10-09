<script setup lang="ts">
// "9 ports · 7 projects · last refresh 1 s ago · v0.1.0", and the poll error when there is one.
// While a search narrows the list: "2 of 9 ports · …".
import { computed, onMounted, onUnmounted, ref } from "vue";

const props = defineProps<{
  /** Rows that match the search. */
  shown: number;
  /** Rows the core reported. */
  total: number;
  projects: number;
  /** ms epoch of the last successful poll. */
  lastRefresh: number | null;
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
  const parts = [ports, plural(props.projects, "project"), `last refresh ${ago.value}`];
  if (props.version) parts.push(/^\d/.test(props.version) ? `v${props.version}` : props.version);
  return parts.join(" · ");
});
</script>

<template>
  <footer
    class="flex h-6 shrink-0 items-center gap-2 border-t border-neutral-200 px-3 text-[11px] text-neutral-500 dark:border-neutral-800 dark:text-neutral-400"
  >
    <span class="shrink-0 tabular-nums">{{ text }}</span>
    <span v-if="error" class="min-w-0 truncate text-red-600 dark:text-red-400" :title="error">· could not refresh: {{ error }}</span>
  </footer>
</template>

<script setup lang="ts">
// WP-0 shell: proves the UI can reach the core. WP-3 replaces this with the real table.
import { onMounted, ref } from "vue";
import { api, isTauri } from "./api";
import type { PortEntry } from "./types";

const entries = ref<PortEntry[]>([]);
const version = ref("");

onMounted(async () => {
  version.value = await api.appVersion();
  entries.value = await api.listPorts();
});
</script>

<template>
  <main class="flex h-full flex-col bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
    <header data-tauri-drag-region class="flex h-12 items-center justify-center text-sm font-medium">
      PortReaper {{ version }} · {{ isTauri() ? "core" : "mock" }}
    </header>
    <ul class="flex-1 overflow-auto px-4 pb-4 font-mono text-sm">
      <li v-for="e in entries" :key="`${e.pid}-${e.port}-${e.protocol}`" class="py-1">
        :{{ e.port }} {{ e.processName }} ({{ e.pid }})
        <span v-if="e.project" class="text-neutral-500">{{ e.project.name }} on {{ e.project.branch }}</span>
      </li>
      <li v-if="entries.length === 0" class="py-8 text-center text-neutral-500">No listening ports.</li>
    </ul>
  </main>
</template>

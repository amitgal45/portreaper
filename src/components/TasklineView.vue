<script setup lang="ts">
// The session's feed: one card per event, newest first, with a badge per kind, the message, a
// meta line and Relaunch where the core remembers how. The count and Clear are in the toolbar.
import { LoaderCircle, RotateCw } from "lucide-vue-next";
import { formatBytes, formatTime } from "../lib/format";
import type { EventKind, TasklineEvent } from "../types";

defineProps<{
  events: TasklineEvent[];
  loaded: boolean;
  relaunching: ReadonlySet<number>;
  canRelaunch: (event: TasklineEvent) => boolean;
}>();

const emit = defineEmits<{ relaunch: [id: number] }>();

const BADGES: Record<EventKind, { label: string; tone: string }> = {
  portFreed: { label: "PORT FREED", tone: "bg-green-tint text-green-ink" },
  forceKilled: { label: "FORCE KILLED", tone: "bg-red-tint text-red-ink" },
  zombieReaped: { label: "ZOMBIE REAPED", tone: "bg-orange-tint text-orange-ink" },
  collisionResolved: { label: "COLLISION RESOLVED", tone: "bg-orange-tint text-orange-ink" },
  relaunched: { label: "RELAUNCHED", tone: "bg-blue-tint text-blue-ink" },
  refused: { label: "REFUSED", tone: "bg-line text-ink-2" },
  failed: { label: "FAILED", tone: "bg-line text-ink-2" },
};

function meta(e: TasklineEvent): string {
  const parts = [`RAM: ${formatBytes(e.memoryBytes)}`, `${e.durationMs} ms`];
  if (e.project) parts.push(e.project);
  return parts.join(" · ");
}
</script>

<template>
  <div role="feed" aria-label="Taskline" class="min-h-0 flex-1 space-y-2 overflow-y-auto bg-canvas p-4">
    <template v-if="loaded">
      <div v-if="events.length === 0" class="flex h-full flex-col items-center justify-center gap-1 text-center">
        <p class="text-ink-2">Nothing yet.</p>
        <p class="text-[12px] text-ink-3">Every kill, reap and relaunch lands here, with what it gave back.</p>
      </div>
      <article
        v-for="e in events"
        :key="e.id"
        :data-event="e.id"
        :data-kind="e.kind"
        class="flex items-start gap-3 rounded-lg border border-line bg-surface px-3 py-2"
      >
        <time class="shrink-0 pt-0.5 font-mono text-[12px] text-ink-2 tabular-nums">{{ formatTime(e.atMs) }}</time>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span class="inline-flex h-5 items-center rounded-full px-2 text-[10px] font-semibold tracking-wide" :class="BADGES[e.kind].tone">
              {{ BADGES[e.kind].label }}
            </span>
            <span class="text-[13px] text-ink">{{ e.message }}</span>
          </div>
          <div class="mt-0.5 font-mono text-[12px] text-ink-2">{{ meta(e) }}</div>
        </div>
        <button
          v-if="canRelaunch(e)"
          type="button"
          class="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2.5 text-[12px] font-medium text-ink outline-none enabled:hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-60"
          :disabled="relaunching.has(e.id)"
          title="Start it again from the remembered command and folder"
          @click="emit('relaunch', e.id)"
        >
          <LoaderCircle v-if="relaunching.has(e.id)" :size="12" class="animate-spin text-blue-ink" aria-hidden="true" />
          <RotateCw v-else :size="12" :stroke-width="2" class="text-blue-ink" aria-hidden="true" />
          Relaunch
        </button>
      </article>
    </template>
  </div>
</template>

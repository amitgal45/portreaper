<script setup lang="ts">
// The session's feed: one card per event, newest first, with a badge per kind, the message, a
// meta line and Relaunch where the core remembers how.
import { LoaderCircle, RotateCw } from "lucide-vue-next";
import { formatBytes, formatTime } from "../lib/format";
import type { EventKind, TasklineEvent } from "../types";

defineProps<{
  events: TasklineEvent[];
  loaded: boolean;
  relaunching: ReadonlySet<number>;
  canRelaunch: (event: TasklineEvent) => boolean;
}>();

const emit = defineEmits<{ relaunch: [id: number]; clear: [] }>();

const BADGES: Record<EventKind, { label: string; tone: string }> = {
  portFreed: {
    label: "PORT FREED",
    tone: "border-emerald-signal/40 bg-emerald-signal/15 text-emerald-signal",
  },
  forceKilled: { label: "FORCE KILLED", tone: "border-coral/40 bg-coral/10 text-coral" },
  zombieReaped: { label: "ZOMBIE REAPED", tone: "border-amber-neon/40 bg-amber-neon/15 text-amber-neon" },
  collisionResolved: {
    label: "COLLISION RESOLVED",
    tone: "border-amber-neon/40 bg-amber-neon/15 text-amber-neon",
  },
  relaunched: { label: "RELAUNCHED", tone: "border-azure/40 bg-azure/15 text-azure" },
  refused: { label: "REFUSED", tone: "border-edge bg-steel text-ink-muted" },
  failed: { label: "FAILED", tone: "border-edge bg-steel text-ink-muted" },
};

function meta(e: TasklineEvent): string {
  const parts = [`RAM: ${formatBytes(e.memoryBytes)}`, `${e.durationMs} ms`];
  if (e.project) parts.push(e.project);
  return parts.join(" · ");
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex h-9 shrink-0 items-center justify-between border-b border-edge bg-obsidian px-3">
      <span class="text-[11px] text-ink-muted">
        {{ events.length }} {{ events.length === 1 ? "event" : "events" }} this session
      </span>
      <button
        type="button"
        class="h-6 rounded-md border border-edge bg-steel px-2 text-[11px] text-ink-muted outline-none enabled:hover:text-ink focus-visible:ring-2 focus-visible:ring-coral/40 disabled:opacity-40"
        :disabled="events.length === 0"
        @click="emit('clear')"
      >
        Clear
      </button>
    </div>

    <div role="feed" aria-label="Taskline" class="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 py-2">
      <template v-if="loaded">
        <div v-if="events.length === 0" class="flex h-full flex-col items-center justify-center gap-1 text-center">
          <p class="text-ink-muted">Nothing yet.</p>
          <p class="text-[11px] text-ink-muted">Every kill, reap and relaunch lands here, with what it gave back.</p>
        </div>
        <article
          v-for="e in events"
          :key="e.id"
          :data-event="e.id"
          :data-kind="e.kind"
          class="flex items-start gap-3 rounded-lg border border-edge bg-obsidian px-3 py-2"
        >
          <time class="shrink-0 pt-0.5 font-mono text-[11px] text-ink-muted tabular-nums">{{ formatTime(e.atMs) }}</time>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span class="rounded border px-1.5 py-px font-mono text-[9px] font-bold tracking-wide" :class="BADGES[e.kind].tone">
                {{ BADGES[e.kind].label }}
              </span>
              <span class="text-[12px] text-ink">{{ e.message }}</span>
            </div>
            <div class="mt-0.5 font-mono text-[10px] text-ink-muted">{{ meta(e) }}</div>
          </div>
          <button
            v-if="canRelaunch(e)"
            type="button"
            class="flex h-6 shrink-0 items-center gap-1 rounded-md border border-azure/40 bg-steel px-2 text-[11px] font-medium text-azure outline-none enabled:hover:bg-azure/15 focus-visible:ring-2 focus-visible:ring-coral/40 disabled:opacity-60"
            :disabled="relaunching.has(e.id)"
            title="Start it again from the remembered command and folder"
            @click="emit('relaunch', e.id)"
          >
            <LoaderCircle v-if="relaunching.has(e.id)" :size="11" class="animate-spin" aria-hidden="true" />
            <RotateCw v-else :size="11" :stroke-width="2" aria-hidden="true" />
            Relaunch
          </button>
        </article>
      </template>
    </div>
  </div>
</template>

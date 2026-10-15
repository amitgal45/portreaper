<script setup lang="ts">
// The 200 px column at the left of the Board: a row for the traffic lights, the brand below it, the
// category filters with their counts ("Ports"), the two alarms ("Needs attention"), and at the
// bottom the update banner when a newer release is known (WP-16), the Taskline and Settings. One
// item is on: a category while the Studio shows, the Taskline while the feed shows, Settings
// while Preferences shows (WP-17b). Clicking a category from either goes back to the Studio.
import { Clock, Database, Globe, LayoutGrid, Settings, Sparkles, Terminal, Zap } from "lucide-vue-next";
import type { CategoryCounts, CategoryFilter } from "../composables/usePorts";
import { bannerText, percentOf, type UpdateState } from "../composables/useUpdate";

export type View = "studio" | "taskline" | "settings";

const props = defineProps<{
  view: View;
  category: CategoryFilter;
  counts: CategoryCounts;
  /** Events in the Taskline this session: the badge on its item. */
  tasklineCount: number;
  /** The update banner's state; `idle` shows no banner. */
  update: UpdateState;
}>();

const emit = defineEmits<{
  "update:view": [view: View];
  "update:category": [category: CategoryFilter];
  /** The banner's Update or Retry: download and install the found release. */
  install: [];
}>();

interface Item {
  key: CategoryFilter;
  label: string;
  icon: typeof LayoutGrid;
  /** Alarms keep their colour on the icon and the badge while the item is off. */
  tone?: "warn" | "danger";
}

const PORTS: Item[] = [
  { key: "all", label: "All ports", icon: LayoutGrid },
  { key: "dev", label: "Dev servers", icon: Terminal },
  { key: "ai", label: "Local AI", icon: Sparkles },
  { key: "db", label: "Databases", icon: Database },
];

const ATTENTION: Item[] = [
  { key: "zombie", label: "Zombies", icon: Zap, tone: "warn" },
  { key: "public", label: "Public on LAN", icon: Globe, tone: "danger" },
];

const item =
  "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-ink-2 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/40";
const on = "bg-brand-tint font-semibold text-brand-ink hover:bg-brand-tint";
const badge = "ml-auto rounded-full px-1.5 py-px font-mono text-[11px] font-medium leading-4 tabular-nums";
const section = "px-2 pt-3.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3";
const updateButton =
  "h-6 rounded-md bg-brand px-2 text-[12px] font-semibold text-white outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-brand/40";

/** The progress bar's fill: the known percent, full once installed, empty while the size is unknown. */
function downloadedWidth(state: UpdateState): string {
  if (state.phase !== "downloading") return "0%";
  if (state.installed) return "100%";
  return `${percentOf(state.downloaded, state.total) ?? 0}%`;
}

function isOn(key: CategoryFilter): boolean {
  return props.view === "studio" && props.category === key;
}

function iconClass(it: Item, active: boolean): string {
  if (active) return "text-brand-ink";
  if (it.tone === "warn") return "text-orange";
  if (it.tone === "danger") return "text-red";
  return "text-ink-3";
}

/** An alarm's badge keeps its colour while it counts something; at zero it goes quiet. */
function badgeClass(it: Item, active: boolean): string {
  if (active) return "bg-brand text-white";
  if (props.counts[it.key] === 0) return "bg-line text-ink-3";
  if (it.tone === "warn") return "bg-orange-tint text-orange-ink";
  if (it.tone === "danger") return "bg-red-tint text-red-ink";
  return "bg-line text-ink-3";
}

function pick(key: CategoryFilter) {
  emit("update:category", key);
  if (props.view !== "studio") emit("update:view", "studio");
}
</script>

<template>
  <nav aria-label="Views" class="flex h-full min-h-0 flex-col border-r border-line bg-canvas px-2.5 pb-2.5">
    <!-- 52 px for the traffic lights alone: macOS draws them at the top left, and nothing sits
         beside them. The brand gets its own row below, the way Slack places the workspace name. -->
    <div data-tauri-drag-region class="h-[52px] shrink-0"></div>
    <div class="flex h-9 shrink-0 items-center gap-2 px-2 pb-1">
      <span class="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-brand text-white" aria-hidden="true">
        <!-- The socket glyph of design/icon.svg, cut by the scythe. -->
        <svg width="14" height="12" viewBox="152 198 720 628" fill="currentColor" fill-rule="evenodd">
          <mask id="pr-cut" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">
            <rect width="1024" height="1024" fill="white" />
            <path d="M388 892 Q398 475 636 132" fill="none" stroke="black" stroke-width="88" />
          </mask>
          <path
            d="M184 258 A24 24 0 0 1 208 234 H816 A24 24 0 0 1 840 258 V646 A24 24 0 0 1 816 670 H730 V766 A24 24 0 0 1 706 790 H318 A24 24 0 0 1 294 766 V670 H208 A24 24 0 0 1 184 646 Z M280 330 V574 H390 V694 H634 V574 H744 V330 Z"
            mask="url(#pr-cut)"
          />
        </svg>
      </span>
      <span class="truncate text-[13.5px] font-semibold text-ink">PortReaper</span>
    </div>

    <div :class="section">Ports</div>
    <button
      v-for="it in PORTS"
      :key="it.key"
      type="button"
      :data-nav="it.key"
      :aria-current="isOn(it.key) ? 'true' : undefined"
      :class="[item, isOn(it.key) && on]"
      @click="pick(it.key)"
    >
      <component :is="it.icon" :size="14" :stroke-width="2" :class="iconClass(it, isOn(it.key))" aria-hidden="true" />
      <span class="truncate">{{ it.label }}</span>
      <span :class="[badge, badgeClass(it, isOn(it.key))]">{{ counts[it.key] }}</span>
    </button>

    <div :class="section">Needs attention</div>
    <button
      v-for="it in ATTENTION"
      :key="it.key"
      type="button"
      :data-nav="it.key"
      :aria-current="isOn(it.key) ? 'true' : undefined"
      :class="[item, isOn(it.key) && on]"
      @click="pick(it.key)"
    >
      <component :is="it.icon" :size="14" :stroke-width="2" :class="iconClass(it, isOn(it.key))" aria-hidden="true" />
      <span class="truncate">{{ it.label }}</span>
      <span :class="[badge, badgeClass(it, isOn(it.key))]">{{ counts[it.key] }}</span>
    </button>

    <div class="mt-auto grid gap-0.5 pt-3">
      <!-- The update banner (WP-16): ready · Update, Downloading… N%, or the failure · Retry.
           A region, not a status: the toasts own that role. -->
      <section
        v-if="update.phase !== 'idle'"
        data-update
        :data-phase="update.phase"
        aria-label="Update"
        class="mb-1 grid gap-1.5 rounded-md bg-brand-tint p-2 text-[12px] leading-4 text-brand-ink"
      >
        <span class="break-words font-semibold">{{ bannerText(update) }}</span>
        <div v-if="update.phase === 'downloading'" class="h-1 overflow-hidden rounded-full bg-brand/20" aria-hidden="true">
          <div class="h-full bg-brand transition-[width]" :style="{ width: downloadedWidth(update) }"></div>
        </div>
        <button v-if="update.phase === 'available'" type="button" data-action="update" :class="updateButton" @click="emit('install')">
          Update
        </button>
        <button v-else-if="update.phase === 'error'" type="button" data-action="retry" :class="updateButton" @click="emit('install')">
          Retry
        </button>
      </section>
      <button
        type="button"
        data-nav="taskline"
        :aria-current="view === 'taskline' ? 'true' : undefined"
        :class="[item, view === 'taskline' && on]"
        @click="emit('update:view', 'taskline')"
      >
        <Clock :size="14" :stroke-width="2" :class="view === 'taskline' ? 'text-brand-ink' : 'text-ink-3'" aria-hidden="true" />
        <span class="truncate">Taskline</span>
        <span
          v-if="tasklineCount > 0"
          data-badge="taskline-count"
          :class="[badge, view === 'taskline' ? 'bg-brand text-white' : 'bg-line text-ink-3']"
        >
          {{ tasklineCount }}
        </span>
      </button>
      <button
        type="button"
        data-nav="settings"
        :aria-current="view === 'settings' ? 'true' : undefined"
        :class="[item, view === 'settings' && on]"
        title="Preferences (⌘,)"
        @click="emit('update:view', 'settings')"
      >
        <Settings :size="14" :stroke-width="2" :class="view === 'settings' ? 'text-brand-ink' : 'text-ink-3'" aria-hidden="true" />
        <span class="truncate">Settings</span>
      </button>
    </div>
  </nav>
</template>

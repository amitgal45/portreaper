<script setup lang="ts">
// The 200 px column at the left of the Board: a row for the traffic lights, the brand below it, the
// category filters with their counts ("Ports"), the two alarms ("Needs attention"), and at the
// bottom the update banner when a newer release is known (WP-16), the Taskline and Settings. One
// item is on: a category while the Studio shows, the Taskline while the feed shows, Settings
// while Preferences shows (WP-17b). Clicking a category from either goes back to the Studio, and
// so do ⌘1–⌘4 (App.vue), whose hints sit on the first four items.
// B v3 (#34): a macOS-grey sidebar (rgba over the canvas, so it reads as solid; no vibrancy), our
// own icons, plain grey counts, and a neutral fill with a coral icon on the item that is on. The
// nav takes the sidebar's own greys (`sidebar-inks`), so text-ink-2 and text-ink-3 in here are
// darker than in the window.
import type { Component } from "vue";
import { CATEGORY_SHORTCUTS } from "../composables/useKeyboard";
import type { CategoryCounts, CategoryFilter } from "../composables/usePorts";
import { bannerText, percentOf, type UpdateState } from "../composables/useUpdate";
import AppMark from "./AppMark.vue";
import {
  ClockIcon,
  DbIcon,
  EyeIcon,
  GearIcon,
  GlobeIcon,
  GridIcon,
  SparkIcon,
  TermIcon,
  ZapIcon,
} from "./icons";

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
  icon: Component;
  /** Alarms colour their icon while the item is off and its count is above 0; the count stays grey. */
  tone?: "warn" | "danger";
}

const PORTS: Item[] = [
  { key: "all", label: "All ports", icon: GridIcon },
  { key: "dev", label: "Dev servers", icon: TermIcon },
  { key: "ai", label: "Local AI", icon: SparkIcon },
  { key: "db", label: "Databases", icon: DbIcon },
];

const ATTENTION: Item[] = [
  { key: "zombie", label: "Zombies", icon: ZapIcon, tone: "warn" },
  { key: "public", label: "Public on LAN", icon: GlobeIcon, tone: "danger" },
  { key: "watching", label: "Watching", icon: EyeIcon },
];

/** The focus ring is brand-ink: 3.9:1 or more on every item fill in light (brand is 2.4–2.8:1), 5.3:1 in dark. */
const item =
  "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-brand-ink";
/** On or off, never both: two utilities for one property would leave the winner to the stylesheet's order.
 *  A press fills an off item like the selected one, at once: no transition, no scale. */
const on = "bg-sidebar-sel text-ink";
const off = "text-ink-2 hover:bg-sidebar-hover active:bg-sidebar-sel";
/** The hint and the count: 11 px sans, grey. ink-3 off; ink-2 on the selected fill, where ink-3 is short of AA. */
const quiet = "text-[11px] leading-4 tabular-nums";
/** Two digits wide, right-aligned: the ⌘ hints stay in one column for 1- and 2-digit counts. */
const countBox = "min-w-[2ch] text-right";
const section = "px-2 pt-3.5 pb-1.5 text-[11px] font-semibold text-ink-3";
/** Update and Retry are filled with brand-ink, so their brand-ink ring stands 2 px off, on a band of the
 *  banner's tint: right on the fill it would be 1:1. Ring on the tint 5.0:1 light, 6.2:1 dark. */
const updateButton =
  "h-6 rounded-md bg-brand-ink px-2 text-[12px] font-semibold text-surface outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-brand-ink ring-offset-2 ring-offset-brand-tint";

/** The progress bar's fill: the known percent, full once installed, empty while the size is unknown. */
function downloadedWidth(state: UpdateState): string {
  if (state.phase !== "downloading") return "0%";
  if (state.installed) return "100%";
  return `${percentOf(state.downloaded, state.total) ?? 0}%`;
}

function isOn(key: CategoryFilter): boolean {
  return props.view === "studio" && props.category === key;
}

/** ⌘1–⌘4 on the four "Ports" items; nothing on the others. */
function shortcutOf(key: CategoryFilter): number | null {
  const index = CATEGORY_SHORTCUTS.indexOf(key);
  return index < 0 ? null : index + 1;
}

/** Coral when on; an alarm's colour while it has something to show; the quiet grey otherwise. */
function iconClass(it: Item, active: boolean): string {
  if (active) return "text-brand";
  if (props.counts[it.key] > 0) {
    if (it.tone === "warn") return "text-orange";
    if (it.tone === "danger") return "text-red";
  }
  return "text-ink-3";
}

function quietClass(active: boolean): string {
  return active ? "text-ink-2" : "text-ink-3";
}

function pick(key: CategoryFilter) {
  emit("update:category", key);
  if (props.view !== "studio") emit("update:view", "studio");
}
</script>

<template>
  <nav aria-label="Views" class="sidebar-inks flex h-full min-h-0 flex-col border-r border-sidebar-edge bg-sidebar px-2.5 pb-2.5">
    <!-- 52 px for the traffic lights alone: macOS draws them at the top left, and nothing sits
         beside them. The brand gets its own row below, the way Slack places the workspace name. -->
    <div data-tauri-drag-region class="h-[52px] shrink-0"></div>
    <div class="flex h-9 shrink-0 items-center gap-2 px-2 pb-1">
      <AppMark class="h-[22px] w-[22px] shrink-0" />
      <span class="truncate text-[13.5px] font-semibold text-ink">PortReaper</span>
    </div>

    <div :class="section">Ports</div>
    <button
      v-for="it in PORTS"
      :key="it.key"
      type="button"
      :data-nav="it.key"
      :aria-current="isOn(it.key) ? 'true' : undefined"
      :aria-keyshortcuts="shortcutOf(it.key) ? `Meta+${shortcutOf(it.key)}` : undefined"
      :class="[item, isOn(it.key) ? on : off]"
      @click="pick(it.key)"
    >
      <component :is="it.icon" class="shrink-0" :class="iconClass(it, isOn(it.key))" />
      <span class="truncate">{{ it.label }}</span>
      <span
        v-if="shortcutOf(it.key)"
        data-shortcut
        aria-hidden="true"
        :class="['ml-auto shrink-0 pr-0.5', quiet, quietClass(isOn(it.key))]"
      >⌘{{ shortcutOf(it.key) }}</span>
      <span
        data-count
        :class="[shortcutOf(it.key) ? 'ml-2' : 'ml-auto', quiet, countBox, quietClass(isOn(it.key))]"
      >{{ counts[it.key] }}</span>
    </button>

    <div :class="section">Needs attention</div>
    <button
      v-for="it in ATTENTION"
      :key="it.key"
      type="button"
      :data-nav="it.key"
      :aria-current="isOn(it.key) ? 'true' : undefined"
      :class="[item, isOn(it.key) ? on : off]"
      @click="pick(it.key)"
    >
      <component :is="it.icon" class="shrink-0" :class="iconClass(it, isOn(it.key))" />
      <span class="truncate">{{ it.label }}</span>
      <span data-count :class="['ml-auto', quiet, countBox, quietClass(isOn(it.key))]">{{ counts[it.key] }}</span>
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
        :class="[item, view === 'taskline' ? on : off]"
        @click="emit('update:view', 'taskline')"
      >
        <ClockIcon class="shrink-0" :class="view === 'taskline' ? 'text-brand' : 'text-ink-3'" />
        <span class="truncate">Taskline</span>
        <span
          v-if="tasklineCount > 0"
          data-count
          data-badge="taskline-count"
          :class="['ml-auto', quiet, countBox, quietClass(view === 'taskline')]"
        >
          {{ tasklineCount }}
        </span>
      </button>
      <button
        type="button"
        data-nav="settings"
        :aria-current="view === 'settings' ? 'true' : undefined"
        :class="[item, view === 'settings' ? on : off]"
        title="Preferences (⌘,)"
        @click="emit('update:view', 'settings')"
      >
        <GearIcon class="shrink-0" :class="view === 'settings' ? 'text-brand' : 'text-ink-3'" />
        <span class="truncate">Settings</span>
      </button>
    </div>
  </nav>
</template>

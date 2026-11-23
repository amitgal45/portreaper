<script setup lang="ts">
// One listening port: a 34 px row (B v3, #34). Port · process (name, pid) · the statuses and the
// brand mark · memory · uptime · Kill and the row menu. The row opens the inspector; Kill kills (⌥
// forces). The command line is not here: it lives in the inspector.
// A status is coloured text with its icon, not a pill. The selected row is the coral fill, and
// everything in it turns white (on-sel-fill, 4.7:1 light, 4.5:1 dark): nothing lighter would pass.
// Kill shows on the selected row, under the pointer and with the focus in the row; elsewhere it is
// transparent (opacity alone, so it keeps its place, its name and its Tab stop). Nothing moves.
import { Ellipsis, LoaderCircle } from "lucide-vue-next";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "reka-ui";
import { type Component, computed, ref, watch } from "vue";
import { killLabels, useActions } from "../composables/useActions";
import { isPublic, isZombie } from "../composables/usePorts";
import { useWatched } from "../composables/useWatch";
import { formatBytes, formatUptime } from "../lib/format";
import { launchdHint } from "../lib/protection";
import { TABLE_COLUMNS, WIDE_ONLY } from "../lib/table-columns";
import type { PortEntry } from "../types";
import FrameworkIcon from "./FrameworkIcon.vue";
import HintTooltip from "./HintTooltip.vue";
import { DotIcon, EyeIcon, GlobeIcon, SparkIcon, ZapIcon } from "./icons";

const props = defineProps<{
  entry: PortEntry;
  selected: boolean;
  /** A kill is in flight: spinner, no clicks. */
  pending: boolean;
  /** Why it is protected, when it is. */
  reason: string | null;
  /** A `collisionResolved` named this port in the last minute: the number goes orange. */
  collision: boolean;
}>();

const actions = useActions();
const labels = computed(() => killLabels(actions.defaultForce?.() ?? false));
const isWatched = useWatched();
const el = ref<HTMLElement | null>(null);

/** The port is watched (WP-18): the eye after the brand mark, and the menu offers to stop. */
const watched = computed(() => isWatched(props.entry));

const uptime = computed(() => formatUptime(props.entry.startedAt));
const memory = computed(() => formatBytes(props.entry.memoryBytes));
/** The framework name adds nothing when it repeats the process name (mDNSResponder). */
const framework = computed(() => {
  const f = props.entry.framework;
  return f && f.toLowerCase() !== props.entry.processName.toLowerCase() ? f : null;
});

interface Badge {
  key: "zombie" | "public" | "protected" | "ai" | "running" | "launchd";
  label: string;
  /** The ink and icon of a status; null for the launchd chip, which says who runs it, not a state. */
  ink: string | null;
  icon: Component | null;
  hint: string;
}

/**
 * What the taxonomy knows, worst first; `Running` only when nothing else applies. Then the
 * `launchd` chip, in the framework chip's neutral colours: who runs the process is a fact, not a
 * state. An entry from an older core (the Quick strip's cache) has no `launchd`, so no chip.
 */
const badges = computed<Badge[]>(() => {
  const e = props.entry;
  const out: Badge[] = [];
  if (e.orphan) {
    const zombieHint =
      e.port === 0
        ? "its agent or terminal exited; an orphaned background process"
        : "its terminal is gone; a dev server nobody is using";
    out.push({
      key: "zombie",
      label: "Zombie",
      ink: "text-orange-ink",
      icon: ZapIcon,
      hint: isZombie(e) ? zombieHint : "its terminal is gone, but it is protected: Reap leaves it alone",
    });
  }
  if (isPublic(e)) {
    out.push({
      key: "public",
      label: "Public",
      ink: "text-red-ink",
      icon: GlobeIcon,
      hint: "bound to every interface: reachable from your network",
    });
  }
  if (e.protected) {
    out.push({
      key: "protected",
      label: "Protected",
      ink: "text-blue-ink",
      icon: DotIcon,
      hint: `${props.reason ?? "protected"} — asks before killing`,
    });
  }
  if (e.category === "ai") {
    out.push({
      key: "ai",
      label: `AI · ${memory.value}`,
      ink: "text-purple-ink",
      icon: SparkIcon,
      hint: "a local model server; this is the memory it holds",
    });
  }
  if (out.length === 0)
    out.push({ key: "running", label: "Running", ink: "text-green-ink", icon: DotIcon, hint: "" });
  const job = e.launchd;
  if (job) {
    out.push({ key: "launchd", label: "launchd", ink: null, icon: null, hint: launchdHint(job) });
  }
  return out;
});

/** A status: its ink, 12 px medium, after its 13 px icon at 5 px (`.pill svg.i` in the mock-up). No fill. */
const status = "shrink-0 items-center gap-[5px] whitespace-nowrap text-[12px] font-medium";
/** The launchd and framework chips: soft and bordered. On the coral they keep only a white edge and
 *  white text: white 18% over the coral would bring the text to 3.7:1. */
const chip =
  "h-[22px] shrink-0 items-center whitespace-nowrap rounded-full border px-2.5 text-[12px] font-medium";
const chipTone = computed(() =>
  props.selected ? "border-on-sel-fill/60 text-on-sel-fill" : "border-line bg-canvas text-ink-2",
);
const num = "whitespace-nowrap text-right font-mono text-[12px] tabular-nums";

/** A text colour in the row: white on the selected row, whatever it is elsewhere. */
function ink(elsewhere: string): string {
  return props.selected ? "text-on-sel-fill" : elsewhere;
}

/**
 * The first badge shows at every width; the others only from 640 px of main column (WIDE_ONLY).
 * Those get no `inline-flex` of their own: Tailwind writes `.hidden` before `.inline-flex`, so a
 * plain `inline-flex` would win over WIDE_ONLY and keep them on screen below 640 px.
 */
function badgeClass(b: Badge, i: number): string[] {
  const display = i === 0 ? "inline-flex" : `${WIDE_ONLY} @min-[640px]/main:inline-flex`;
  return b.ink === null ? [chip, display, chipTone.value] : [status, display, ink(b.ink)];
}

const portInk = computed(() => {
  if (props.collision) return ink("text-orange-ink");
  return ink(props.entry.port === 0 ? "text-ink-2" : "text-ink");
});

/** Kill and the menu: 26 px. The focus ring is brand-ink on a row (5:1 or more), white on the coral
 *  (brand-ink is 1.2:1 there), 2 px off the button on the coral, so the white ring does not merge
 *  with the white button. */
const killBase =
  "h-[26px] rounded-md border px-2.5 text-[12px] font-medium outline-none focus-visible:ring-2";
/** Transparent until the row is under the pointer, holds the keyboard focus or has its menu open
 *  (the trigger's aria-expanded; the menu itself is portaled out of the row), or the button has the
 *  keyboard focus. A click's focus does not count. Opacity only, at once: no `hidden`, no
 *  `invisible`, no transition. */
const killHidden =
  "opacity-0 group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100 group-has-[[aria-expanded=true]]/row:opacity-100 focus-visible:opacity-100";
const killClass = computed(() =>
  props.selected
    ? `${killBase} opacity-100 border-surface bg-surface text-red-ink hover:border-canvas hover:bg-canvas focus-visible:ring-on-sel-fill ring-offset-2 ring-offset-sel-fill`
    : `${killBase} ${killHidden} border-line-strong bg-surface text-red-ink hover:border-red-ink hover:bg-red-ink hover:text-surface focus-visible:ring-brand-ink`,
);
/** No border, on every row. */
const moreClass = computed(() =>
  props.selected
    ? "flex h-[26px] w-[26px] items-center justify-center rounded-md text-on-sel-fill outline-none focus-visible:ring-2 focus-visible:ring-on-sel-fill"
    : "flex h-[26px] w-[26px] items-center justify-center rounded-md text-ink-3 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-brand-ink data-[state=open]:bg-hover data-[state=open]:text-ink",
);
const menuItem =
  "flex h-7 cursor-default select-none items-center gap-2 rounded-md px-2 text-[13px] text-ink outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-hover";

watch(
  () => props.selected,
  (selected) => {
    if (selected && typeof el.value?.scrollIntoView === "function")
      el.value.scrollIntoView({ block: "nearest" });
  },
);
</script>

<template>
  <div
    ref="el"
    role="row"
    :aria-selected="selected"
    :data-pid="entry.pid"
    :data-port="entry.port"
    :data-category="entry.category"
    :class="[
      TABLE_COLUMNS,
      'group/row h-[34px] scroll-mt-15 border-b border-row-line',
      selected ? 'bg-sel-fill text-on-sel-fill' : 'hover:bg-hover',
      pending && 'pointer-events-none opacity-60',
    ]"
    @click="actions.inspect(entry)"
  >
    <span
      class="truncate font-mono text-[15px] font-semibold tracking-tight tabular-nums"
      :class="portInk"
      :title="collision ? 'A new process took this port right after PortReaper freed it' : entry.port === 0 ? 'No listening socket (stdio or background worker)' : undefined"
    >
      <template v-if="entry.port === 0">stdio</template>
      <template v-else>{{ entry.port }}<span v-if="entry.protocol === 'udp'" :class="['ml-1 text-[10px] font-normal', ink('text-ink-3')]">udp</span></template>
    </span>

    <!-- A container's port names the container, and says so where the pid would be (WP-20). -->
    <span
      class="flex min-w-0 items-baseline gap-1.5 overflow-hidden whitespace-nowrap"
      :data-cell="entry.container ? 'container' : undefined"
    >
      <template v-if="entry.container">
        <span :class="['truncate font-semibold', ink('text-ink')]">{{ entry.container }}</span>
        <span :class="['shrink-0 font-mono text-[12px]', ink('text-ink-2')]">container</span>
      </template>
      <template v-else>
        <span :class="['truncate font-semibold', ink('text-ink')]">{{ entry.processName }}</span>
        <span :class="['shrink-0 font-mono text-[12px] tabular-nums', ink('text-ink-2')]">{{ entry.pid }}</span>
      </template>
    </span>

    <!-- On the coral, a brand mark paints white too (`fill: currentColor` beats its fill attribute).
         One 22 px line (the chip's height) that wraps: a badge that does not fit goes whole to a
         second line, which overflow-hidden keeps out of sight, so no badge shows as a sliver. The
         22 px leading makes the first line 22 px even with no chip on it, so it stays centred. -->
    <span
      data-cell="status"
      :class="['flex h-[22px] min-w-0 flex-wrap items-center gap-2 overflow-hidden leading-[22px]', selected && '[&_[data-brand]_path]:fill-current']"
    >
      <template v-for="(b, i) in badges" :key="b.key">
        <HintTooltip v-if="b.hint" :text="b.hint">
          <span :data-badge="b.key" :class="badgeClass(b, i)"><component :is="b.icon" v-if="b.icon" :size="13" class="shrink-0" />{{ b.label }}</span>
        </HintTooltip>
        <span v-else :data-badge="b.key" :class="badgeClass(b, i)"><component :is="b.icon" v-if="b.icon" :size="13" class="shrink-0" />{{ b.label }}</span>
      </template>
      <FrameworkIcon :entry="entry" :size="16">
        <span v-if="framework" data-badge="framework" :class="[chip, 'inline-flex', chipTone]">{{ framework }}</span>
      </FrameworkIcon>
      <!-- Our eye is aria-hidden, so the mark carries the name. -->
      <span
        v-if="watched"
        data-badge="watched"
        role="img"
        aria-label="watched"
        :class="['flex shrink-0 items-center', ink('text-blue-ink')]"
        title="Watching: PortReaper will say when this port is free"
      >
        <EyeIcon :size="14" />
      </span>
    </span>

    <span :class="[num, ink('text-ink-2'), WIDE_ONLY]">{{ memory }}</span>
    <span :class="[num, ink('text-ink-2'), WIDE_ONLY]">{{ uptime }}</span>

    <span class="flex items-center justify-end gap-1.5">
      <LoaderCircle v-if="pending" :size="14" :class="['animate-spin', ink('text-ink-3')]" aria-label="killing" />
      <template v-else>
        <button
          type="button"
          :class="killClass"
          :title="entry.protected ? 'Kill (asks first)' : labels.title"
          aria-label="Kill"
          @click.stop="actions.kill(entry, $event.altKey)"
        >
          Kill
        </button>
        <DropdownMenuRoot>
          <DropdownMenuTrigger as-child>
            <button
              type="button"
              :class="moreClass"
              aria-label="More"
              title="More"
              @click.stop
            >
              <Ellipsis :size="14" :stroke-width="2" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuPortal>
            <DropdownMenuContent
              align="end"
              :side-offset="4"
              :collision-padding="8"
              class="z-50 min-w-48 rounded-lg border border-line-strong bg-surface p-1"
              @click.stop
            >
              <DropdownMenuItem :class="menuItem" @select="actions.inspect(entry)">Inspect</DropdownMenuItem>
              <DropdownMenuItem :class="menuItem" data-action="watch" :disabled="entry.port === 0" @select="actions.watch(entry)">
                {{ entry.port === 0 ? "Watch port" : watched ? `Stop watching :${entry.port}` : `Watch :${entry.port}` }}
              </DropdownMenuItem>
              <!-- By number, TCP and UDP alike; a portless (stdio) row has no number to hide. -->
              <DropdownMenuItem :class="menuItem" data-action="hide" :disabled="entry.port === 0" @select="actions.hide(entry)">
                {{ entry.port === 0 ? "Hide port" : `Hide :${entry.port}` }}
              </DropdownMenuItem>
              <DropdownMenuItem :class="menuItem" :disabled="entry.port === 0 || entry.protocol !== 'tcp'" @select="actions.openInBrowser(entry)">
                {{ entry.port === 0 ? "Open in browser" : `Open localhost:${entry.port}` }}
              </DropdownMenuItem>
              <DropdownMenuItem :class="menuItem" @select="actions.copyKill(entry)">Copy kill -9 {{ entry.pid }}</DropdownMenuItem>
              <DropdownMenuItem :class="menuItem" :disabled="!entry.command" @select="actions.copyCommand(entry)">
                Copy command
              </DropdownMenuItem>
              <DropdownMenuItem :class="menuItem" :disabled="!entry.project?.root" @select="actions.revealFolder(entry)">
                Reveal folder
              </DropdownMenuItem>
              <DropdownMenuSeparator class="my-1 h-px bg-line" />
              <DropdownMenuItem :class="[menuItem, 'text-red-ink']" @select="actions.kill(entry, true)">
                {{ labels.alt }}<span class="ml-auto font-mono text-[11px] text-ink-3">⌥↩</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>
      </template>
    </span>
  </div>
</template>

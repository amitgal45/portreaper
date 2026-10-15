<script setup lang="ts">
// One listening port: a 40 px row. Port · process (name, pid) · status pills and the brand mark
// · memory · uptime · Kill and the row menu. The row opens the inspector; Kill kills (⌥ forces).
// The command line is not here: it lives in the inspector.
import { Ellipsis, Eye, LoaderCircle } from "lucide-vue-next";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "reka-ui";
import { computed, ref, watch } from "vue";
import { useActions } from "../composables/useActions";
import { isPublic, isZombie } from "../composables/usePorts";
import { useWatched } from "../composables/useWatch";
import { formatBytes, formatUptime } from "../lib/format";
import { TABLE_COLUMNS, WIDE_ONLY } from "../lib/table-columns";
import type { PortEntry } from "../types";
import FrameworkIcon from "./FrameworkIcon.vue";
import HintTooltip from "./HintTooltip.vue";

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

interface Pill {
  key: "zombie" | "public" | "protected" | "ai" | "running";
  label: string;
  tone: string;
  hint: string;
}

/** What the taxonomy knows, worst first; `Running` only when nothing else applies. */
const pills = computed<Pill[]>(() => {
  const e = props.entry;
  const out: Pill[] = [];
  if (e.orphan) {
    out.push({
      key: "zombie",
      label: "Zombie",
      tone: "bg-orange-tint text-orange-ink",
      hint: isZombie(e)
        ? "its terminal is gone; a dev server nobody is using"
        : "its terminal is gone, but it is protected: Reap leaves it alone",
    });
  }
  if (isPublic(e)) {
    out.push({
      key: "public",
      label: "Public",
      tone: "bg-red-tint text-red-ink",
      hint: "bound to every interface: reachable from your network",
    });
  }
  if (e.protected) {
    out.push({
      key: "protected",
      label: "Protected",
      tone: "bg-blue-tint text-blue-ink",
      hint: `${props.reason ?? "protected"} — asks before killing`,
    });
  }
  if (e.category === "ai") {
    out.push({
      key: "ai",
      label: `AI · ${memory.value}`,
      tone: "bg-purple-tint text-purple-ink",
      hint: "a local model server; this is the memory it holds",
    });
  }
  if (out.length === 0)
    out.push({ key: "running", label: "Running", tone: "bg-green-tint text-green-ink", hint: "" });
  return out;
});

const pill =
  "inline-flex h-[22px] shrink-0 items-center whitespace-nowrap rounded-full px-2.5 text-[12px] font-semibold";
const soft =
  "inline-flex h-[22px] shrink-0 items-center whitespace-nowrap rounded-full border border-line bg-canvas px-2.5 text-[12px] font-medium text-ink-2";
const num = "whitespace-nowrap text-right font-mono text-[12px] text-ink-2 tabular-nums";
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
      'relative h-10 border-b border-line scroll-mt-15',
      selected
        ? 'bg-sel before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-brand'
        : 'hover:bg-hover',
      pending && 'pointer-events-none opacity-60',
    ]"
    @click="actions.inspect(entry)"
  >
    <span
      class="truncate font-mono text-[15px] font-semibold tracking-tight tabular-nums"
      :class="collision ? 'text-orange-ink' : 'text-ink'"
      :title="collision ? 'A new process took this port right after PortReaper freed it' : undefined"
    >
      {{ entry.port }}<span v-if="entry.protocol === 'udp'" class="ml-1 text-[10px] font-normal text-ink-3">udp</span>
    </span>

    <span class="flex min-w-0 items-baseline gap-1.5 overflow-hidden whitespace-nowrap">
      <span class="truncate font-semibold text-ink">{{ entry.processName }}</span>
      <span class="shrink-0 font-mono text-[12px] text-ink-2 tabular-nums">{{ entry.pid }}</span>
    </span>

    <span class="flex min-w-0 items-center gap-1.5 overflow-hidden">
      <template v-for="(p, i) in pills" :key="p.key">
        <HintTooltip v-if="p.hint" :text="p.hint">
          <span :data-badge="p.key" :class="[pill, p.tone, i > 0 && WIDE_ONLY, i > 0 && '@min-[640px]/main:inline-flex']">{{ p.label }}</span>
        </HintTooltip>
        <span v-else :data-badge="p.key" :class="[pill, p.tone]">{{ p.label }}</span>
      </template>
      <FrameworkIcon :entry="entry" :size="16">
        <span v-if="framework" data-badge="framework" :class="soft">{{ framework }}</span>
      </FrameworkIcon>
      <span
        v-if="watched"
        data-badge="watched"
        class="flex shrink-0 items-center text-blue-ink"
        title="Watching: PortReaper will say when this port is free"
      >
        <Eye :size="14" :stroke-width="2" aria-label="watched" />
      </span>
    </span>

    <span :class="[num, WIDE_ONLY]">{{ memory }}</span>
    <span :class="[num, WIDE_ONLY]">{{ uptime }}</span>

    <span class="flex items-center justify-end gap-1.5">
      <LoaderCircle v-if="pending" :size="14" class="animate-spin text-ink-3" aria-label="killing" />
      <template v-else>
        <button
          type="button"
          class="h-[26px] rounded-md border px-2.5 text-[12px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          :class="
            selected
              ? 'border-red-ink bg-red-ink text-surface hover:brightness-95'
              : 'border-line-strong bg-surface text-red-ink hover:border-red-ink hover:bg-red-ink hover:text-surface'
          "
          :title="entry.protected ? 'Kill (asks first)' : 'Kill · ⌥ to force'"
          aria-label="Kill"
          @click.stop="actions.kill(entry, $event.altKey)"
        >
          Kill
        </button>
        <DropdownMenuRoot>
          <DropdownMenuTrigger as-child>
            <button
              type="button"
              class="flex h-[26px] w-[26px] items-center justify-center rounded-md border border-line bg-surface text-ink-3 outline-none hover:border-line-strong hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40 data-[state=open]:bg-hover"
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
              <DropdownMenuItem :class="menuItem" data-action="watch" @select="actions.watch(entry)">
                {{ watched ? `Stop watching :${entry.port}` : `Watch :${entry.port}` }}
              </DropdownMenuItem>
              <DropdownMenuItem :class="menuItem" :disabled="entry.protocol !== 'tcp'" @select="actions.openInBrowser(entry)">
                Open localhost:{{ entry.port }}
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
                Force kill<span class="ml-auto font-mono text-[11px] text-ink-3">⌥↩</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>
      </template>
    </span>
  </div>
</template>

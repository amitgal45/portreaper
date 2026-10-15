<script setup lang="ts">
// One listening port: 36 px, one line. The row opens the drawer; the eye does the same; Kill
// kills (⌥ forces). The badges say what the taxonomy knows: scope, framework, zombie, protected,
// local AI with its memory.
import { Eye, GitBranch, LoaderCircle, Lock, Zap } from "lucide-vue-next";
import { computed, ref, watch } from "vue";
import { useActions } from "../composables/useActions";
import { isZombie } from "../composables/usePorts";
import { executableDir, formatBytes, formatUptime, shortCommand } from "../lib/format";
import type { PortEntry } from "../types";
import HintTooltip from "./HintTooltip.vue";

const props = defineProps<{
  entry: PortEntry;
  selected: boolean;
  /** A kill is in flight: spinner, no clicks. */
  pending: boolean;
  /** The group header already shows the branch; do not repeat it. */
  showBranch: boolean;
  /** Why it is protected, when it is. */
  reason: string | null;
  /** A `collisionResolved` named this port in the last minute: the number goes amber. */
  collision: boolean;
}>();

const actions = useActions();
const el = ref<HTMLElement | null>(null);

const command = computed(() => shortCommand(props.entry.command));
/** A command that is only the executable repeats the name (daemons, Docker): say where it lives instead. */
const repeatsName = computed(
  () => !command.value.text || command.value.text.toLowerCase() === props.entry.processName.toLowerCase(),
);
const location = computed(() =>
  repeatsName.value ? executableDir(props.entry.exe, props.entry.command) : "",
);
const uptime = computed(() => formatUptime(props.entry.startedAt));
const memory = computed(() => formatBytes(props.entry.memoryBytes));
const zombie = computed(() => isZombie(props.entry));
/** The framework chip adds nothing when it repeats the process name (mDNSResponder). */
const framework = computed(() => {
  const f = props.entry.framework;
  return f && f.toLowerCase() !== props.entry.processName.toLowerCase() ? f : null;
});

const chip = "inline-flex h-4 shrink-0 items-center gap-0.5 rounded px-1 text-[10px] font-medium";
const iconButton =
  "flex h-6 w-6 items-center justify-center rounded-md text-ink-muted outline-none hover:bg-steel hover:text-ink focus-visible:ring-2 focus-visible:ring-coral/40";

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
    class="group/row flex h-9 items-center gap-2 border-b border-edge/60 px-3 scroll-mt-7"
    :class="[
      selected ? 'bg-steel/60 ring-1 ring-coral/40 ring-inset' : 'hover:bg-steel/40',
      pending && 'pointer-events-none opacity-60',
    ]"
    @click="actions.inspect(entry)"
  >
    <span
      class="w-14 shrink-0 font-mono text-[13px] font-bold tabular-nums"
      :class="collision ? 'text-amber-neon' : 'text-ink'"
      :title="collision ? 'A new process took this port right after PortReaper freed it' : undefined"
    >
      :{{ entry.port }}<span v-if="entry.protocol === 'udp'" class="ml-1 text-[10px] font-normal text-ink-muted">udp</span>
    </span>

    <span class="w-14 shrink-0 text-[10px]">
      <HintTooltip v-if="entry.bind === 'any'" text="bound to every interface: reachable from your network">
        <span :class="[chip, 'rounded-full border border-coral/30 bg-coral/10 font-mono text-coral']">
          <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-coral" aria-hidden="true" />public
        </span>
      </HintTooltip>
      <span v-else-if="entry.bind === 'loopback'" :class="[chip, 'rounded-full border border-edge bg-steel font-mono text-ink-muted']">local</span>
      <span v-else class="font-mono text-ink-muted">{{ entry.address }}</span>
    </span>

    <span class="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
      <span class="shrink-0 truncate">
        <span class="font-semibold text-ink">{{ entry.processName }}</span>
        <span class="ml-1 font-mono text-[11px] text-ink-muted tabular-nums">{{ entry.pid }}</span>
      </span>
      <span v-if="showBranch && entry.project?.branch" data-badge="branch" :class="[chip, 'border border-edge bg-steel font-mono text-ink-muted']">
        <GitBranch :size="10" :stroke-width="2" aria-hidden="true" />{{ entry.project.branch }}
      </span>
      <span v-if="framework" data-badge="framework" :class="[chip, 'bg-emerald-signal/15 font-mono text-emerald-signal']">
        {{ framework }}
      </span>
      <HintTooltip
        v-if="entry.orphan"
        :text="zombie ? 'its terminal is gone; a dev server nobody is using' : 'its terminal is gone, but it is protected: Reap leaves it alone'"
      >
        <span data-badge="zombie" :class="[chip, 'border border-amber-neon/40 bg-amber-neon/15 text-amber-neon']">
          <Zap :size="10" :stroke-width="2" aria-hidden="true" />zombie
        </span>
      </HintTooltip>
      <HintTooltip v-if="entry.protected" :text="`${reason ?? 'protected'} — asks before killing`">
        <span data-badge="protected" :class="[chip, 'border border-azure/40 bg-azure/15 text-azure']">
          <Lock :size="10" :stroke-width="2" aria-hidden="true" />protected
        </span>
      </HintTooltip>
      <HintTooltip v-if="entry.category === 'ai'" text="a local model server; this is the memory it holds">
        <span data-badge="ai" :class="[chip, 'border border-violet/40 bg-violet/15 font-mono text-violet']">AI · {{ memory }}</span>
      </HintTooltip>
      <span v-if="!repeatsName" data-cell="command" class="hidden min-w-0 flex-1 truncate font-mono text-[11px] text-ink-muted sm:inline" :title="command.title">{{ command.text }}</span>
      <span v-else-if="location" data-cell="location" class="hidden min-w-0 flex-1 truncate font-mono text-[11px] text-ink-muted sm:inline" :title="entry.exe || command.title">{{ location }}</span>
    </span>

    <span class="w-16 shrink-0 text-right font-mono text-[11px] text-ink-muted tabular-nums">{{ memory }}</span>
    <span class="w-12 shrink-0 whitespace-nowrap text-right font-mono text-[11px] text-ink-muted tabular-nums">{{ uptime }}</span>

    <span class="flex w-18 shrink-0 items-center justify-end gap-1">
      <LoaderCircle v-if="pending" :size="14" class="animate-spin text-ink-muted" aria-label="killing" />
      <template v-else>
        <button type="button" :class="iconButton" aria-label="Inspect" title="Inspect" @click.stop="actions.inspect(entry)">
          <Eye :size="13" :stroke-width="2" />
        </button>
        <button
          type="button"
          class="h-6 rounded-md bg-steel px-2 text-[11px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-coral/40"
          :class="entry.protected ? 'text-ink-muted hover:text-ink' : 'text-coral hover:bg-coral hover:text-void'"
          :title="entry.protected ? 'Kill (asks first)' : 'Kill · ⌥ to force'"
          aria-label="Kill"
          @click.stop="actions.kill(entry, $event.altKey)"
        >
          Kill
        </button>
      </template>
    </span>
  </div>
</template>

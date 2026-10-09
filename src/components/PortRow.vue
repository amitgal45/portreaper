<script setup lang="ts">
// One listening port: 32 px, one line. Click selects, the X kills (⌥ forces), the menu has the rest.
import {
  Copy,
  ExternalLink,
  FolderOpen,
  GitBranch,
  LoaderCircle,
  Lock,
  MoreHorizontal,
  X,
  Zap,
} from "lucide-vue-next";
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
import { executableDir, formatBytes, formatUptime, shortCommand } from "../lib/format";
import type { PortEntry } from "../types";
import HintTooltip from "./HintTooltip.vue";

const props = defineProps<{
  entry: PortEntry;
  selected: boolean;
  /** A kill is in flight: spinner, no clicks. */
  pending: boolean;
  /** The group header already shows these; do not repeat them. */
  showBranch: boolean;
  showTool: boolean;
  /** Why it is protected, when it is. */
  reason: string | null;
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
const canOpen = computed(() => props.entry.protocol === "tcp");
const root = computed(() => props.entry.project?.root ?? "");

const menuItem =
  "flex h-7 cursor-default select-none items-center gap-2 rounded px-2 outline-none data-[highlighted]:bg-neutral-100 data-[disabled]:opacity-40 dark:data-[highlighted]:bg-neutral-700";
const iconButton =
  "flex h-6 w-6 items-center justify-center rounded text-neutral-500 dark:text-neutral-400 outline-none hover:bg-neutral-200 hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-blue-500/50 dark:hover:bg-neutral-700 dark:hover:text-neutral-100";

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
    class="group/row flex h-8 items-center gap-2 border-b border-neutral-200/70 px-3 scroll-mt-8 dark:border-neutral-800"
    :class="[
      selected ? 'bg-blue-500/10 dark:bg-blue-400/15' : 'hover:bg-neutral-100 dark:hover:bg-neutral-800/60',
      pending && 'pointer-events-none opacity-60',
    ]"
    @click="actions.select(entry)"
  >
    <span class="w-14 shrink-0 font-mono font-medium tabular-nums">
      {{ entry.port }}<span v-if="entry.protocol === 'udp'" class="ml-1 text-[10px] font-normal text-neutral-400">udp</span>
    </span>

    <span class="w-16 shrink-0 text-[11px]">
      <HintTooltip v-if="entry.bind === 'any'" text="reachable from your network">
        <span class="inline-flex h-4 items-center rounded bg-red-500/10 px-1 font-medium text-red-600 dark:text-red-400">exposed</span>
      </HintTooltip>
      <span v-else-if="entry.bind === 'loopback'" class="text-neutral-400">local</span>
      <span v-else class="font-mono text-neutral-500 dark:text-neutral-400">{{ entry.address }}</span>
    </span>

    <span class="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
      <span class="shrink-0 truncate">
        <span class="font-medium">{{ entry.processName }}</span>
        <span class="ml-1 text-neutral-500 dark:text-neutral-400 tabular-nums">{{ entry.pid }}</span>
      </span>
      <span v-if="showBranch && entry.project?.branch" data-badge="branch" class="inline-flex h-4 shrink-0 items-center gap-0.5 rounded bg-neutral-500/10 px-1 font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
        <GitBranch :size="10" :stroke-width="2" />{{ entry.project.branch }}
      </span>
      <span v-if="showTool && entry.project?.tool" data-badge="tool" class="inline-flex h-4 shrink-0 items-center rounded bg-neutral-500/10 px-1 text-[11px] text-neutral-500 dark:text-neutral-400">
        {{ entry.project.tool }}
      </span>
      <HintTooltip v-if="entry.orphan" text="its parent process is gone; usually a dev server whose terminal was closed">
        <span class="inline-flex h-4 shrink-0 items-center rounded bg-amber-500/15 px-1 text-[11px] font-medium text-amber-700 dark:text-amber-400">lost its terminal</span>
      </HintTooltip>
      <HintTooltip v-if="entry.protected" :text="`${reason ?? 'protected'} — asks before killing`">
        <span class="inline-flex shrink-0 text-neutral-400"><Lock :size="11" :stroke-width="2" /></span>
      </HintTooltip>
      <span v-if="!repeatsName" data-cell="command" class="hidden min-w-0 flex-1 truncate text-[12px] text-neutral-400 sm:inline" :title="command.title">{{ command.text }}</span>
      <span v-else-if="location" data-cell="location" class="hidden min-w-0 flex-1 truncate text-[12px] text-neutral-400 sm:inline" :title="entry.exe || command.title">{{ location }}</span>
    </span>

    <span class="w-16 shrink-0 text-right text-[12px] text-neutral-500 dark:text-neutral-400 tabular-nums">{{ memory }}</span>
    <span class="w-10 shrink-0 text-right text-[12px] text-neutral-500 dark:text-neutral-400 tabular-nums">{{ uptime }}</span>

    <span class="flex w-13 shrink-0 items-center justify-end gap-0.5">
      <LoaderCircle v-if="pending" :size="14" class="animate-spin text-neutral-400" aria-label="killing" />
      <template v-else>
        <button
          type="button"
          :class="[iconButton, selected ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100']"
          :title="entry.protected ? 'Kill (asks first)' : 'Kill · ⌥ to force'"
          aria-label="Kill"
          @click.stop="actions.kill(entry, $event.altKey)"
        >
          <X :size="14" :stroke-width="2" />
        </button>
        <DropdownMenuRoot>
          <DropdownMenuTrigger as-child>
            <button
              type="button"
              :class="[iconButton, 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100']"
              aria-label="More"
              @click.stop
            >
              <MoreHorizontal :size="14" :stroke-width="2" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuPortal>
            <DropdownMenuContent
              align="end"
              :side-offset="4"
              :collision-padding="8"
              class="z-50 min-w-48 rounded-md border border-neutral-200 bg-white p-1 text-[13px] shadow-md dark:border-neutral-700 dark:bg-neutral-800"
            >
              <DropdownMenuItem :class="menuItem" :disabled="!canOpen" @select="actions.openInBrowser(entry)">
                <ExternalLink :size="13" class="text-neutral-400" />Open localhost:{{ entry.port }}
              </DropdownMenuItem>
              <DropdownMenuItem :class="menuItem" @select="actions.copyKill(entry)">
                <Copy :size="13" class="text-neutral-400" />Copy <span class="font-mono">kill -9 {{ entry.pid }}</span>
              </DropdownMenuItem>
              <DropdownMenuItem :class="menuItem" :disabled="!entry.command" @select="actions.copyCommand(entry)">
                <Copy :size="13" class="text-neutral-400" />Copy command line
              </DropdownMenuItem>
              <DropdownMenuItem :class="menuItem" :disabled="!root" @select="actions.revealFolder(entry)">
                <FolderOpen :size="13" class="text-neutral-400" />Reveal project folder
              </DropdownMenuItem>
              <DropdownMenuSeparator class="my-1 h-px bg-neutral-200 dark:bg-neutral-700" />
              <DropdownMenuItem :class="[menuItem, 'text-red-600 dark:text-red-400']" @select="actions.kill(entry, true)">
                <Zap :size="13" />Force kill
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>
      </template>
    </span>
  </div>
</template>

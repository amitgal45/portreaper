<script setup lang="ts">
// One process, in full: the header, network, resources, project, ancestry, the full command
// with its copy button, and the two verbs. The same panel sits as the third column of the Board
// in a wide window and inside a slide-over in a narrow one (App.vue decides).
import { Copy, ExternalLink, Eye, FolderOpen, GitBranch, LoaderCircle, RotateCw, X } from "lucide-vue-next";
import { computed, ref, watch } from "vue";
import { useApi } from "../api";
import { useActions } from "../composables/useActions";
import type { RestartState } from "../composables/useKillFlow";
import { useWatched } from "../composables/useWatch";
import { formatBytes, formatUptime } from "../lib/format";
import type { PortEntry, ProcessNode } from "../types";
import FrameworkIcon from "./FrameworkIcon.vue";

const props = defineProps<{
  entry: PortEntry;
  /** Why it is protected, when it is. */
  reason: string | null;
  /** Where the last Restart stands, when it was started from here. */
  restart: RestartState | null;
}>();

const emit = defineEmits<{ close: [] }>();

const api = useApi();
const actions = useActions();
const isWatched = useWatched();

/** The port is watched (WP-18): the eye in the header is on, and the Network card says so. */
const watched = computed(() => isWatched(props.entry));

/** The ancestry, launchd first. `null` while loading, `[]` when the core does not know. */
const tree = ref<ProcessNode[] | null>(null);
watch(
  () => props.entry.pid,
  async (pid) => {
    tree.value = null;
    try {
      const nodes = await api.processTree(pid);
      if (props.entry.pid === pid) tree.value = nodes;
    } catch (err) {
      console.error("processTree failed", err);
      if (props.entry.pid === pid) tree.value = [];
    }
  },
  { immediate: true },
);

/** The framework, unless it only repeats the process name. */
const framework = computed(() => {
  const f = props.entry.framework;
  return f && f.toLowerCase() !== props.entry.processName.toLowerCase() ? f : null;
});
const uptime = computed(() => formatUptime(props.entry.startedAt));
const memory = computed(() => formatBytes(props.entry.memoryBytes));
const isPublic = computed(() => props.entry.bind === "any");
const bindNote = computed(() => {
  if (props.entry.bind === "any") return "reachable from your network";
  if (props.entry.bind === "loopback") return "isolated to this machine";
  return "one interface only";
});
const canOpen = computed(() => props.entry.protocol === "tcp");
const root = computed(() => props.entry.project?.root ?? "");
/** Restart needs something to relaunch: an unprotected process with a command and a cwd. */
const restartBlocked = computed(() => {
  const e = props.entry;
  if (e.protected) return `${e.processName} is ${props.reason ?? "protected"}: kill it from the gate instead`;
  if (!e.command || e.cwd === null) return "the core does not know the command or the working directory";
  return "";
});
const restartBusy = computed(
  () => props.restart?.phase === "killing" || props.restart?.phase === "relaunching",
);
const restartLine = computed(() => {
  const r = props.restart;
  if (!r) return null;
  switch (r.phase) {
    case "killing":
      return { text: `Stopping ${props.entry.processName} (${r.pid})…`, tone: "text-ink-2" };
    case "relaunching":
      return { text: "Relaunching from the remembered command…", tone: "text-ink-2" };
    case "started":
      return { text: `Back on :${props.entry.port} as pid ${r.newPid}.`, tone: "text-green-ink" };
    case "failed":
      return { text: `Restart failed: ${r.error}`, tone: "text-red-ink" };
  }
});

const section = "space-y-1 rounded-lg border border-line bg-canvas p-3";
const heading = "text-[11px] font-semibold uppercase tracking-wide text-ink-3";
const ghost =
  "inline-flex h-6 items-center gap-1 rounded-md border border-line-strong bg-surface px-2 text-[12px] text-ink-2 outline-none enabled:hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-40";
</script>

<template>
  <aside data-inspector class="flex h-full min-h-0 flex-col bg-surface text-[13px] text-ink">
    <header class="flex shrink-0 items-center gap-2.5 border-b border-line px-4 py-3">
      <span class="flex h-8 shrink-0 items-center rounded-lg border border-line bg-canvas px-2 font-mono text-[15px] font-semibold text-ink tabular-nums">
        :{{ entry.port }}
      </span>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5">
          <span class="truncate font-semibold text-ink">{{ entry.processName }}</span>
          <FrameworkIcon v-if="framework" :entry="entry" :size="14" />
          <span v-if="framework" class="truncate text-[12px] text-ink-2">{{ framework }}</span>
        </div>
        <div class="truncate font-mono text-[12px] text-ink-2 tabular-nums">PID {{ entry.pid }} · up {{ uptime }}</div>
      </div>
      <button
        type="button"
        data-action="watch"
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/40"
        :class="watched ? 'text-blue-ink' : 'text-ink-3 hover:text-ink'"
        :aria-pressed="watched"
        aria-label="Watch"
        :title="watched ? `Stop watching :${entry.port}` : `Watch :${entry.port} · notify when it is free`"
        @click="actions.watch(entry)"
      >
        <Eye :size="14" :stroke-width="2" />
      </button>
      <button
        type="button"
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-3 outline-none hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40"
        aria-label="Close"
        title="Close (Esc)"
        @click="emit('close')"
      >
        <X :size="14" :stroke-width="2" />
      </button>
    </header>

    <div class="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-4">
      <div class="grid grid-cols-2 gap-2.5">
        <div data-section="bind" :class="section">
          <div :class="heading">Network</div>
          <div class="flex items-center gap-1.5 truncate font-mono text-[13px] font-semibold" :class="isPublic ? 'text-red-ink' : 'text-ink'">
            <span v-if="isPublic" class="h-1.5 w-1.5 shrink-0 rounded-full bg-red" aria-hidden="true" />
            {{ entry.address }}
          </div>
          <p class="text-[12px] leading-snug text-ink-2">{{ bindNote }}</p>
          <p v-if="watched" data-watching class="text-[12px] leading-snug text-blue-ink">Watching · will notify when free</p>
        </div>
        <div data-section="resources" :class="section">
          <div :class="heading">Resources</div>
          <div class="font-mono text-[13px] font-semibold text-ink tabular-nums">{{ memory }}</div>
          <p class="text-[12px] leading-snug text-ink-2">running {{ uptime }}</p>
        </div>
      </div>

      <div data-section="project" :class="section">
        <div :class="heading">Project</div>
        <template v-if="entry.project">
          <div class="flex min-w-0 items-center gap-2">
            <span class="truncate font-semibold text-ink">{{ entry.project.name }}</span>
            <span v-if="entry.project.branch" class="flex min-w-0 items-center gap-1 truncate font-mono text-[12px] text-ink-2">
              <GitBranch :size="11" :stroke-width="2" class="shrink-0" aria-hidden="true" />{{ entry.project.branch }}
            </span>
          </div>
        </template>
        <p v-else class="text-ink-2">No project detected</p>
        <p class="truncate font-mono text-[12px] text-ink-2" :title="entry.cwd ?? undefined">cwd {{ entry.cwd ?? "unknown" }}</p>
      </div>

      <div data-section="tree" :class="section">
        <div :class="heading">Process tree</div>
        <p v-if="tree === null" class="flex items-center gap-1.5 text-[12px] text-ink-2">
          <LoaderCircle :size="12" class="animate-spin" aria-hidden="true" />reading the ancestry…
        </p>
        <p v-else-if="tree.length === 0" class="text-[12px] text-ink-2">Ancestry unknown</p>
        <ol v-else class="space-y-0.5 font-mono text-[12px]">
          <li
            v-for="(node, depth) in tree"
            :key="node.pid"
            class="break-words"
            :style="{ paddingLeft: `${depth * 12}px` }"
            :class="depth === tree.length - 1 ? 'font-semibold text-brand-ink' : 'text-ink-2'"
          >
            <span v-if="depth > 0" aria-hidden="true">└─ </span>PID {{ node.pid }} ({{ node.name }})<span v-if="depth === tree.length - 1"> [LISTENING ON :{{ entry.port }}]</span>
          </li>
        </ol>
      </div>

      <div data-section="command" :class="section">
        <div class="flex items-center justify-between">
          <div :class="heading">Full command</div>
          <button type="button" :class="ghost" :disabled="!entry.command" title="Copy the command line" @click="actions.copyCommand(entry)">
            <Copy :size="11" aria-hidden="true" />Copy
          </button>
        </div>
        <p
          class="select-text break-all rounded-md border border-line bg-surface p-2 font-mono text-[12px] leading-relaxed"
          :class="entry.command ? 'text-ink' : 'text-ink-2'"
        >
          {{ entry.command || "unknown" }}
        </p>
        <div class="flex flex-wrap gap-1.5 pt-1">
          <button type="button" :class="ghost" :disabled="!canOpen" @click="actions.openInBrowser(entry)">
            <ExternalLink :size="11" aria-hidden="true" />Open localhost:{{ entry.port }}
          </button>
          <button type="button" :class="ghost" @click="actions.copyKill(entry)">
            <Copy :size="11" aria-hidden="true" />Copy kill -9 {{ entry.pid }}
          </button>
          <button type="button" :class="ghost" :disabled="!root" @click="actions.revealFolder(entry)">
            <FolderOpen :size="11" aria-hidden="true" />Reveal folder
          </button>
        </div>
      </div>
    </div>

    <div class="shrink-0 space-y-2 border-t border-line p-3">
      <p v-if="restartLine" data-restart-status class="truncate font-mono text-[12px]" :class="restartLine.tone">
        {{ restartLine.text }}
      </p>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-line-strong bg-surface text-[13px] font-medium text-ink outline-none transition-colors enabled:hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-40"
          :disabled="restartBlocked !== '' || restartBusy"
          :title="restartBlocked || 'Kill gracefully, then start it again from the same command and folder'"
          @click="actions.restart(entry)"
        >
          <LoaderCircle v-if="restartBusy" :size="13" class="animate-spin text-blue-ink" aria-hidden="true" />
          <RotateCw v-else :size="13" :stroke-width="2" class="text-blue-ink" aria-hidden="true" />
          Restart
        </button>
        <button
          type="button"
          class="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-red-ink bg-red-ink text-[13px] font-semibold text-surface outline-none transition-colors hover:brightness-95 focus-visible:ring-2 focus-visible:ring-brand/40"
          :title="entry.protected ? 'Kill (asks first)' : 'Kill · ⌥ to force'"
          @click="actions.kill(entry, $event.altKey)"
        >
          <X :size="13" :stroke-width="2.5" aria-hidden="true" />
          Kill
        </button>
      </div>
    </div>
  </aside>
</template>

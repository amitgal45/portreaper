<script setup lang="ts">
// The slide-over for one process: bind, resources, project, ancestry, the full command, and the
// two verbs. A reka Dialog: focus stays inside, Esc and ✕ close, a click outside closes.
import { Copy, ExternalLink, FolderOpen, GitBranch, LoaderCircle, RotateCw, X } from "lucide-vue-next";
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "reka-ui";
import { computed, ref, watch } from "vue";
import { useApi } from "../api";
import { useActions } from "../composables/useActions";
import type { RestartState } from "../composables/useKillFlow";
import { formatBytes, formatUptime } from "../lib/format";
import type { PortEntry, ProcessNode } from "../types";

const props = defineProps<{
  /** The process on show, or null for closed. */
  entry: PortEntry | null;
  /** Why it is protected, when it is. */
  reason: string | null;
  /** Where the last Restart stands, when it was started from here. */
  restart: RestartState | null;
}>();

const emit = defineEmits<{ close: [] }>();

const api = useApi();
const actions = useActions();

/** The ancestry, launchd first. `null` while loading, `[]` when the core does not know. */
const tree = ref<ProcessNode[] | null>(null);
watch(
  () => props.entry?.pid,
  async (pid) => {
    tree.value = null;
    if (pid === undefined) return;
    try {
      const nodes = await api.processTree(pid);
      if (props.entry?.pid === pid) tree.value = nodes;
    } catch (err) {
      console.error("processTree failed", err);
      if (props.entry?.pid === pid) tree.value = [];
    }
  },
  { immediate: true },
);

const name = computed(() => {
  const e = props.entry;
  if (!e) return "";
  const framework =
    e.framework && e.framework.toLowerCase() !== e.processName.toLowerCase() ? e.framework : null;
  return framework ? `${e.processName} (${framework})` : e.processName;
});
const uptime = computed(() => (props.entry ? formatUptime(props.entry.startedAt) : ""));
const memory = computed(() => (props.entry ? formatBytes(props.entry.memoryBytes) : ""));
const isPublic = computed(() => props.entry?.bind === "any");
const bindNote = computed(() => {
  if (!props.entry) return "";
  if (props.entry.bind === "any") return "reachable from your network";
  if (props.entry.bind === "loopback") return "isolated to this machine";
  return "one interface only";
});
const canOpen = computed(() => props.entry?.protocol === "tcp");
const root = computed(() => props.entry?.project?.root ?? "");
/** Restart needs something to relaunch: an unprotected process with a command and a cwd. */
const restartBlocked = computed(() => {
  const e = props.entry;
  if (!e) return "";
  if (e.protected) return `${e.processName} is ${props.reason ?? "protected"}: kill it from the gate instead`;
  if (!e.command || e.cwd === null) return "the core does not know the command or the working directory";
  return "";
});
const restartBusy = computed(
  () => props.restart?.phase === "killing" || props.restart?.phase === "relaunching",
);
const restartLine = computed(() => {
  const r = props.restart;
  if (!r || !props.entry) return null;
  switch (r.phase) {
    case "killing":
      return { text: `Stopping ${props.entry.processName} (${r.pid})…`, tone: "text-ink-muted" };
    case "relaunching":
      return { text: "Relaunching from the remembered command…", tone: "text-ink-muted" };
    case "started":
      return { text: `Back on :${props.entry.port} as pid ${r.newPid}.`, tone: "text-emerald-signal" };
    case "failed":
      return { text: `Restart failed: ${r.error}`, tone: "text-coral" };
  }
});

// Biome must not see a type-only use of DialogContent here: it would demote the template's import.
const content = ref<{ $el: HTMLElement } | null>(null);
/** Focus the panel itself on open, not the ✕: nothing looks pressed, Esc still closes, Tab reaches everything. */
function focusPanel(event: Event) {
  event.preventDefault();
  content.value?.$el.focus();
}

const section = "space-y-1.5 rounded-lg border border-edge bg-void/60 p-3";
const heading = "font-mono text-[10px] uppercase tracking-wider text-ink-muted";
const chip = "inline-flex h-4 items-center gap-0.5 rounded px-1 font-mono text-[10px]";
const ghost =
  "flex h-6 items-center gap-1 rounded-md border border-edge bg-steel px-2 text-[11px] text-ink-muted outline-none enabled:hover:text-ink focus-visible:ring-2 focus-visible:ring-coral/40 disabled:opacity-40";

function onOpenChange(open: boolean) {
  if (!open) emit("close");
}
</script>

<template>
  <DialogRoot :open="entry !== null" @update:open="onOpenChange">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-30 bg-void/40" />
      <DialogContent
        ref="content"
        data-drawer
        tabindex="-1"
        class="fixed inset-y-0 right-0 z-40 flex w-[440px] max-w-full flex-col border-l border-edge bg-obsidian text-[12px] text-ink shadow-2xl shadow-void outline-none"
        @open-auto-focus="focusPanel"
      >
        <template v-if="entry">
          <header class="flex shrink-0 items-center gap-2.5 border-b border-edge px-4 py-3">
            <span class="flex h-8 shrink-0 items-center justify-center rounded-lg bg-steel px-2 font-mono text-[13px] font-bold text-ink">:{{ entry.port }}</span>
            <div class="min-w-0 flex-1">
              <DialogTitle class="truncate text-[13px] font-bold text-ink">{{ name }}</DialogTitle>
              <DialogDescription class="truncate font-mono text-[11px] text-ink-muted">
                PID {{ entry.pid }} · up {{ uptime }}
              </DialogDescription>
            </div>
            <DialogClose
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-muted outline-none hover:bg-steel hover:text-ink focus-visible:ring-2 focus-visible:ring-coral/40"
              aria-label="Close"
              title="Close (Esc)"
            >
              <X :size="14" :stroke-width="2" />
            </DialogClose>
          </header>

          <div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            <div class="grid grid-cols-2 gap-3">
              <div data-section="bind" :class="section">
                <div :class="heading">Network bind</div>
                <div class="flex items-center gap-1.5 font-mono font-bold" :class="isPublic ? 'text-coral' : 'text-ink'">
                  <span v-if="isPublic" class="h-1.5 w-1.5 animate-pulse rounded-full bg-coral" aria-hidden="true" />
                  {{ entry.address }}
                </div>
                <p class="text-[10px] text-ink-muted">{{ bindNote }}</p>
              </div>
              <div data-section="resources" :class="section">
                <div :class="heading">Resources</div>
                <div class="font-mono font-bold text-ink">{{ memory }}</div>
                <p class="text-[10px] text-ink-muted">running {{ uptime }}</p>
              </div>
            </div>

            <div data-section="project" :class="section">
              <div :class="heading">Project</div>
              <template v-if="entry.project">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="text-[13px] font-bold text-ink">{{ entry.project.name }}</span>
                  <span v-if="entry.project.branch" :class="[chip, 'border border-edge bg-steel text-ink-muted']">
                    <GitBranch :size="10" :stroke-width="2" aria-hidden="true" />{{ entry.project.branch }}
                  </span>
                  <span v-if="entry.framework" :class="[chip, 'bg-emerald-signal/15 font-semibold text-emerald-signal']">{{ entry.framework }}</span>
                </div>
              </template>
              <p v-else class="text-ink-muted">
                No project detected<span v-if="entry.framework"> · {{ entry.framework }}</span>
              </p>
              <p class="truncate font-mono text-[11px] text-ink-muted" :title="entry.cwd ?? undefined">
                cwd {{ entry.cwd ?? "unknown" }}
              </p>
            </div>

            <div data-section="tree" :class="section">
              <div :class="heading">Process tree</div>
              <p v-if="tree === null" class="flex items-center gap-1.5 text-ink-muted">
                <LoaderCircle :size="12" class="animate-spin" aria-hidden="true" />reading the ancestry…
              </p>
              <p v-else-if="tree.length === 0" class="text-ink-muted">Ancestry unknown</p>
              <ol v-else class="space-y-1 font-mono text-[11px]">
                <li
                  v-for="(node, depth) in tree"
                  :key="node.pid"
                  :style="{ paddingLeft: `${depth * 12}px` }"
                  :class="depth === tree.length - 1 ? 'font-bold text-coral' : 'text-ink-muted'"
                >
                  <span v-if="depth > 0" aria-hidden="true">└─ </span>PID {{ node.pid }} ({{ node.name }})<span v-if="depth === tree.length - 1"> [LISTENING ON :{{ entry.port }}]</span>
                </li>
              </ol>
            </div>

            <div data-section="command" :class="section">
              <div :class="heading">Full command</div>
              <p class="select-text break-words rounded-md border border-edge bg-void p-2 font-mono text-[11px] leading-relaxed" :class="entry.command ? 'text-ink' : 'text-ink-muted'">
                {{ entry.command || "unknown" }}
              </p>
              <div class="flex flex-wrap gap-1.5 pt-1">
                <button type="button" :class="ghost" :disabled="!canOpen" @click="actions.openInBrowser(entry)">
                  <ExternalLink :size="11" aria-hidden="true" />Open localhost:{{ entry.port }}
                </button>
                <button type="button" :class="ghost" @click="actions.copyKill(entry)">
                  <Copy :size="11" aria-hidden="true" />Copy kill -9 {{ entry.pid }}
                </button>
                <button type="button" :class="ghost" :disabled="!entry.command" @click="actions.copyCommand(entry)">
                  <Copy :size="11" aria-hidden="true" />Copy command
                </button>
                <button type="button" :class="ghost" :disabled="!root" @click="actions.revealFolder(entry)">
                  <FolderOpen :size="11" aria-hidden="true" />Reveal folder
                </button>
              </div>
            </div>
          </div>

          <footer class="shrink-0 space-y-2 border-t border-edge p-3">
            <p v-if="restartLine" data-restart-status class="truncate font-mono text-[11px]" :class="restartLine.tone">
              {{ restartLine.text }}
            </p>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-edge bg-steel text-[12px] font-semibold text-ink outline-none transition-colors enabled:hover:border-azure/60 focus-visible:ring-2 focus-visible:ring-coral/40 disabled:opacity-40"
                :disabled="restartBlocked !== '' || restartBusy"
                :title="restartBlocked || 'Kill gracefully, then start it again from the same command and folder'"
                @click="actions.restart(entry)"
              >
                <LoaderCircle v-if="restartBusy" :size="13" class="animate-spin text-azure" aria-hidden="true" />
                <RotateCw v-else :size="13" :stroke-width="2" class="text-azure" aria-hidden="true" />
                Restart
              </button>
              <button
                type="button"
                class="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg bg-coral text-[12px] font-bold text-void outline-none transition-colors hover:bg-coral/90 focus-visible:ring-2 focus-visible:ring-coral/40"
                :title="entry.protected ? 'Kill (asks first)' : 'Kill · ⌥ to force'"
                @click="actions.kill(entry, $event.altKey)"
              >
                <X :size="13" :stroke-width="2.5" aria-hidden="true" />
                Kill
              </button>
            </div>
          </footer>
        </template>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

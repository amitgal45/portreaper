<script setup lang="ts">
// The second confirmation for a protected process, a group with one, or a big reap. Cancel takes
// focus, so Enter twice never kills.
import {
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle,
} from "reka-ui";
import { computed } from "vue";
import type { KillTarget } from "../composables/useKillFlow";
import { formatBytes, formatPorts } from "../lib/format";
import type { PortEntry } from "../types";

const props = defineProps<{
  target: KillTarget | null;
  reasonFor: (entry: PortEntry) => string;
  portsOf: (pid: number) => number[];
}>();

const emit = defineEmits<{ confirm: []; cancel: [] }>();

const who = (e: PortEntry) => `${e.processName} (${e.pid})`;

const title = computed(() => {
  const t = props.target;
  if (!t) return "";
  switch (t.kind) {
    case "entry":
      return `Kill ${who(t.entry)}?`;
    case "group":
      return `Kill everything in ${t.group.name}?`;
    case "zombies":
      return `Reap ${t.count} zombies?`;
  }
});

const description = computed(() => {
  const t = props.target;
  if (!t) return "";
  const lines: string[] = [];
  if (t.kind === "entry") {
    const held = props.portsOf(t.entry.pid);
    lines.push(`${t.entry.processName} is ${props.reasonFor(t.entry)}.`);
    if (held.length > 0) lines.push(`It holds ${formatPorts(held).toLowerCase()}.`);
  } else if (t.kind === "group") {
    const n = t.group.pids.length;
    lines.push(
      `${n} ${n === 1 ? "process" : "processes"}: ${t.group.pids
        .map((pid) => {
          const e = t.group.entries.find((x) => x.pid === pid);
          return e ? who(e) : String(pid);
        })
        .join(", ")}.`,
    );
    const seen = new Set<number>();
    for (const e of t.group.entries) {
      if (!e.protected || seen.has(e.pid)) continue;
      seen.add(e.pid);
      lines.push(`${e.processName} is ${props.reasonFor(e)}.`);
    }
  } else {
    lines.push(`${t.count} dev servers whose terminal is gone, holding ${formatBytes(t.memoryBytes)}.`);
  }
  const force = t.kind !== "zombies" && t.force;
  lines.push(
    force ? "This sends SIGKILL at once." : "This sends SIGTERM and waits up to 3 s before SIGKILL.",
  );
  return lines.join(" ");
});

const action = computed(() => (props.target?.kind === "zombies" ? "Reap them" : "Kill anyway"));

function onOpenChange(open: boolean) {
  if (!open) emit("cancel");
}
</script>

<template>
  <AlertDialogRoot :open="target !== null" @update:open="onOpenChange">
    <AlertDialogPortal>
      <AlertDialogOverlay class="fixed inset-0 z-40 bg-void/60" />
      <AlertDialogContent
        class="fixed top-1/2 left-1/2 z-50 w-88 max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-edge bg-obsidian p-4 text-[13px] text-ink outline-none"
      >
        <AlertDialogTitle class="font-semibold">{{ title }}</AlertDialogTitle>
        <AlertDialogDescription class="mt-1.5 leading-relaxed text-ink-muted">
          {{ description }}
        </AlertDialogDescription>
        <div class="mt-4 flex justify-end gap-2">
          <AlertDialogCancel
            class="h-7 rounded-md border border-edge bg-steel px-3 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-coral/40"
          >
            Cancel
          </AlertDialogCancel>
          <!-- A plain button, not AlertDialogAction: reka's own close handler would run first and
               cancel the target through update:open before confirm could fire. The parent closes
               the dialog by clearing the target. -->
          <button
            type="button"
            class="h-7 rounded-md bg-coral px-3 font-semibold text-void outline-none hover:bg-coral/90 focus-visible:ring-2 focus-visible:ring-coral/40"
            @click="emit('confirm')"
          >
            {{ action }}
          </button>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>

import { computed, ref } from "vue";
import { formatPorts } from "../lib/format";
import type { PortEntry } from "../types";
import type { KillReport, PortGroup, PortsStore } from "./usePorts";
import type { ToastKind, Toasts } from "./useToasts";

export type KillTarget =
  | { kind: "entry"; entry: PortEntry; force: boolean }
  | { kind: "group"; group: PortGroup; force: boolean };

/** The sentence a toast carries for one outcome. */
export function killMessage(report: KillReport): { message: string; kind: ToastKind } {
  const { entry, outcome } = report;
  const who = `${entry.processName} (${entry.pid})`;
  switch (outcome.status) {
    case "killed":
      return {
        message: `Killed ${who}. ${formatPorts(report.ports)} ${report.ports.length === 1 ? "is" : "are"} free.`,
        kind: "info",
      };
    case "notFound":
      return { message: `${who} is already gone.`, kind: "info" };
    case "refused":
      return { message: `Did not kill ${who}: ${outcome.reason}.`, kind: "error" };
    case "failed":
      return { message: `Could not kill ${who}: ${outcome.error}.`, kind: "error" };
    case "transport":
      return { message: "Could not reach the core.", kind: "error" };
  }
}

export function needsConfirm(target: KillTarget): boolean {
  return target.kind === "entry" ? target.entry.protected : target.group.entries.some((e) => e.protected);
}

/**
 * The one verb. A protected target goes through `confirm` (the dialog) and dies only on
 * `confirmed()`; anything else dies at once. Every outcome becomes a toast.
 */
export function useKillFlow(ports: PortsStore, toasts: Toasts) {
  const confirm = ref<KillTarget | null>(null);
  const confirming = computed(() => confirm.value !== null);

  function report(r: KillReport) {
    const { message, kind } = killMessage(r);
    toasts.push(message, kind);
  }

  async function execute(target: KillTarget): Promise<void> {
    if (target.kind === "entry") {
      report(await ports.kill(target.entry, target.force));
      return;
    }
    for (const r of await ports.killGroup(target.group, target.force)) report(r);
  }

  function request(target: KillTarget): Promise<void> {
    if (target.kind === "entry" && ports.pending.has(target.entry.pid)) return Promise.resolve();
    if (needsConfirm(target)) {
      confirm.value = target;
      return Promise.resolve();
    }
    return execute(target);
  }

  function confirmed(): Promise<void> {
    const target = confirm.value;
    confirm.value = null;
    return target ? execute(target) : Promise.resolve();
  }

  function cancel() {
    confirm.value = null;
  }

  return { confirm, confirming, request, confirmed, cancel };
}

export type KillFlow = ReturnType<typeof useKillFlow>;

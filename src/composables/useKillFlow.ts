import { computed, ref } from "vue";
import { formatBytes, formatPorts } from "../lib/format";
import type { PortEntry } from "../types";
import type { KillReport, PortGroup, PortsStore, ReapReport } from "./usePorts";
import type { Taskline } from "./useTaskline";
import type { ToastKind, Toasts } from "./useToasts";

export type KillTarget =
  | { kind: "entry"; entry: PortEntry; force: boolean }
  | { kind: "group"; group: PortGroup; force: boolean }
  /** Reap every lost-terminal process (v0.2). Asks first when there are more than three. */
  | { kind: "zombies"; count: number; memoryBytes: number };

/** Above this many zombies, Reap asks once. */
export const REAP_CONFIRM_ABOVE = 3;

/** Where a Restart (kill, then relaunch) stands, for the drawer. */
export type RestartState =
  | { phase: "killing"; pid: number }
  | { phase: "relaunching"; pid: number }
  | { phase: "started"; pid: number; newPid: number }
  | { phase: "failed"; pid: number; error: string };

export type RestartOutcome = { status: "started"; pid: number } | { status: "failed"; error: string };

/** The sentence a toast carries for one outcome. A kill that went straight to SIGKILL says so. */
export function killMessage(report: KillReport): { message: string; kind: ToastKind } {
  const { entry, outcome } = report;
  const who = `${entry.processName} (${entry.pid})`;
  switch (outcome.status) {
    case "killed":
      return {
        message: `${outcome.graceful ? "Killed" : "Force-killed"} ${who}. ${formatPorts(report.ports)} ${report.ports.length === 1 ? "is" : "are"} free.`,
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

/** The summary toast for a reap: what came back, and how many the core would not touch. */
export function reapMessage(report: ReapReport): { message: string; kind: ToastKind } {
  const n = report.freed;
  if (n === 0 && report.refused === 0) return { message: "No zombies to reap.", kind: "info" };
  const freed =
    n === 0
      ? "Reaped nothing"
      : `Reaped ${n} ${n === 1 ? "zombie" : "zombies"}, ${formatBytes(report.memoryBytes)} back`;
  const refused = report.refused === 0 ? "" : `; ${report.refused} refused`;
  return { message: `${freed}${refused}.`, kind: report.refused === 0 ? "info" : "error" };
}

export function needsConfirm(target: KillTarget): boolean {
  switch (target.kind) {
    case "entry":
      return target.entry.protected;
    case "group":
      return target.group.entries.some((e) => e.protected);
    case "zombies":
      return target.count > REAP_CONFIRM_ABOVE;
  }
}

export interface UseKillFlowOptions {
  /** The "Kill sends SIGKILL at once" preference: what Kill and ↩ do with no ⌥ held. Default: graceful. */
  defaultForce?: () => boolean;
}

/**
 * The one verb. A protected target goes through `confirm` (the dialog) and dies only on
 * `confirmed()`; anything else dies at once. Every outcome becomes a toast. With a Taskline,
 * `restart()` is a graceful kill followed by the core's relaunch of what it just recorded.
 */
export function useKillFlow(
  ports: PortsStore,
  toasts: Toasts,
  taskline?: Taskline,
  options: UseKillFlowOptions = {},
) {
  const confirm = ref<KillTarget | null>(null);
  const confirming = computed(() => confirm.value !== null);
  const restarting = ref<RestartState | null>(null);
  const defaultForce = options.defaultForce ?? (() => false);

  /** The `force` of a kill from a Kill button or ↩: the preference is the base, ⌥ flips it either way. */
  function forceFor(alt: boolean): boolean {
    return alt !== defaultForce();
  }

  function report(r: KillReport) {
    const { message, kind } = killMessage(r);
    toasts.push(message, kind);
  }

  async function execute(target: KillTarget): Promise<void> {
    switch (target.kind) {
      case "entry":
        report(await ports.kill(target.entry, target.force));
        return;
      case "group":
        for (const r of await ports.killGroup(target.group, target.force)) report(r);
        return;
      case "zombies": {
        const { message, kind } = reapMessage(await ports.reapZombies());
        toasts.push(message, kind);
        return;
      }
    }
  }

  function request(target: KillTarget): Promise<void> {
    if (target.kind === "entry" && ports.pending.has(target.entry.pid)) return Promise.resolve();
    if (needsConfirm(target)) {
      confirm.value = target;
      return Promise.resolve();
    }
    return execute(target);
  }

  /** Always opens the dialog, protected or not. For paths where the user has not seen the row yet. */
  function ask(target: KillTarget) {
    confirm.value = target;
  }

  function confirmed(): Promise<void> {
    const target = confirm.value;
    confirm.value = null;
    return target ? execute(target) : Promise.resolve();
  }

  function cancel() {
    confirm.value = null;
  }

  /** Reap every zombie; asks first above `REAP_CONFIRM_ABOVE`. */
  function reap(): Promise<void> {
    return request({
      kind: "zombies",
      count: ports.counts.value.zombie,
      memoryBytes: ports.zombieMemoryBytes.value,
    });
  }

  /**
   * Kill gracefully, then relaunch the event the core just recorded for that pid. Never for a
   * protected row: the caller disables Restart there. The kill's outcome is toasted like any
   * other; the relaunch toasts itself through the Taskline.
   */
  async function restart(entry: PortEntry): Promise<RestartOutcome> {
    const fail = (error: string): RestartOutcome => {
      restarting.value = { phase: "failed", pid: entry.pid, error };
      return { status: "failed", error };
    };
    if (!taskline) return fail("no Taskline");
    if (entry.protected) return fail(`${entry.processName} is protected`);
    if (
      restarting.value &&
      (restarting.value.phase === "killing" || restarting.value.phase === "relaunching")
    ) {
      return fail("already restarting");
    }
    restarting.value = { phase: "killing", pid: entry.pid };
    const r = await ports.kill(entry, false);
    report(r);
    if (r.outcome.status !== "killed") return fail(killMessage(r).message);
    restarting.value = { phase: "relaunching", pid: entry.pid };
    await taskline.refresh();
    const event = taskline.latestFor(entry.pid);
    if (!event) return fail("the core recorded nothing to relaunch");
    const outcome = await taskline.relaunch(event.id);
    if (outcome.status !== "started") {
      return fail(outcome.status === "transport" ? "could not reach the core" : relaunchFailure(outcome));
    }
    restarting.value = { phase: "started", pid: entry.pid, newPid: outcome.pid };
    await ports.refresh();
    return { status: "started", pid: outcome.pid };
  }

  /** Forget the last restart's outcome (the drawer closed). */
  function clearRestart() {
    restarting.value = null;
  }

  return {
    confirm,
    confirming,
    request,
    ask,
    confirmed,
    cancel,
    reap,
    restarting,
    restart,
    clearRestart,
    forceFor,
  };
}

function relaunchFailure(outcome: { status: "notFound" } | { status: "failed"; error: string }): string {
  return outcome.status === "failed" ? outcome.error : "the core forgot the event";
}

export type KillFlow = ReturnType<typeof useKillFlow>;

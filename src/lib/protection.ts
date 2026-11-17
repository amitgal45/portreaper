import type { LaunchdJob, PortEntry } from "../types";

/**
 * Why a process is `protected`, in the words the confirm dialog uses. The contract carries only
 * the boolean, so the reason is derived from what the core does tell us: a system job (Apple's, or
 * one run from the system's folders), the launchd job that starts it again after a kill, or may
 * (the core protects every job not known to stay down), the tool, the process name, the owner and
 * the executable. When nothing matches, say "a protected process" rather than guess.
 *
 * `entry.launchd` is read with `?.`: the Quick strip's session cache can hold entries from a
 * core that did not send the field (or its `system`) yet.
 */

const CONTAINER = /docker|containerd|colima|podman|lima|orbstack/i;
const DATABASE =
  /postgres|postmaster|mysqld|mariadb|mongod|redis|memcached|elasticsearch|clickhouse|cockroach|influxd|sqlite|couchdb|neo4j|cassandra|rabbitmq|kafka|zookeeper|etcd|minio|nats|valkey/i;
const SYSTEM_PATH = /^\/(System|usr\/(sbin|libexec)|Library)\//;

export function protectionReason(entry: PortEntry, currentUser: string | null): string {
  // A piece of macOS (ControlCenter on :5000) is a system process, whatever launchd does to it: the
  // core offers nothing to stop it with, and the user has nothing to stop.
  const job = entry.launchd;
  if (job?.system) return "a system process";
  // A kill that launchd undoes (KeepAlive), or may undo (`restarts` null: nobody can tell), is the
  // reason to ask, whatever the process is.
  const restarts = job?.restarts;
  if (job && restarts !== false) {
    const again = restarts === true ? "starts again" : "may start again";
    return job.brew
      ? `a Homebrew service (${job.brew}) that launchd ${again} after a kill`
      : `a launchd job that launchd ${again} after a kill`;
  }
  const tool = entry.project?.tool ?? "";
  if (tool.toLowerCase() === "docker" || CONTAINER.test(entry.processName)) return "Docker";
  if (DATABASE.test(entry.processName) || DATABASE.test(tool) || DATABASE.test(entry.project?.name ?? "")) {
    return "a database";
  }
  const path = entry.exe ?? entry.command;
  if (entry.user === "root" || entry.user?.startsWith("_") || SYSTEM_PATH.test(path))
    return "a system process";
  if (currentUser && entry.user && entry.user !== currentUser) return "another user's process";
  return "a protected process";
}

/** What a kill does to a launchd job (`LaunchdJob.restarts`), for the row's hint and the inspector. */
export function restartsText(restarts: boolean | null | undefined): string {
  if (restarts === true) return "a kill is undone within seconds";
  if (restarts === false) return "a kill lasts until the next login";
  return "launchd may start it again";
}

/** The hint of a row's `launchd` chip: who runs it, and what a kill does to it. */
export function launchdHint(job: LaunchdJob): string {
  return `started by launchd (${job.label}): ${restartsText(job.restarts)}`;
}

/** The likeliest current user: whoever owns most of the unprotected processes. */
export function guessCurrentUser(entries: PortEntry[]): string | null {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (e.protected || !e.user) continue;
    counts.set(e.user, (counts.get(e.user) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [user, count] of counts) {
    if (count > bestCount) {
      best = user;
      bestCount = count;
    }
  }
  return best;
}

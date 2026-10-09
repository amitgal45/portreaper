import type { PortEntry } from "../types";

/**
 * Why a process is `protected`, in the words the confirm dialog uses. The contract carries only
 * the boolean, so the reason is derived from what the core does tell us: the tool, the process
 * name, the owner and the executable. When nothing matches, say "a protected process" rather
 * than guess.
 */

const CONTAINER = /docker|containerd|colima|podman|lima|orbstack/i;
const DATABASE =
  /postgres|postmaster|mysqld|mariadb|mongod|redis|memcached|elasticsearch|clickhouse|cockroach|influxd|sqlite|couchdb|neo4j|cassandra|rabbitmq|kafka|zookeeper|etcd|minio|nats|valkey/i;
const SYSTEM_PATH = /^\/(System|usr\/(sbin|libexec)|Library)\//;

export function protectionReason(entry: PortEntry, currentUser: string | null): string {
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

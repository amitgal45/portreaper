import type { PortEntry, TasklineEvent } from "../types";

/**
 * What the Quick strip shows for a query. Pure: no Vue, no DOM.
 *
 * The matching rules are the main search's (`matches` in `src/composables/usePorts.ts`, which
 * is not exported): port prefix, exact pid, and a case-insensitive substring of the process
 * name, project name, branch or command line. On top of that the strip ranks: an exact port
 * first, then port prefixes, then an exact pid, then the name matches; ties by port, then pid.
 *
 * An empty query is the pre-selection (`preselect`, v0.2): what the user most likely opened the
 * strip to kill, so that `⌘⇧K` `↵` is enough. Nothing on the machine says a bind failed in
 * someone's terminal, so "the contested port" is approximated: lost-terminal zombies first, then
 * ports a `collisionResolved` event named in the last minute, then dev servers newest first.
 */

/** One row of the strip is a pid on a port over a protocol. Same shape as the main table's key. */
export function quickKey(e: PortEntry): string {
  return `${e.pid}:${e.port}:${e.protocol}`;
}

/** How many rows the strip shows at most. 6 × 36 px on the card under the 24 px header and 44 px input, over the 24 px footer. */
export const QUICK_LIMIT = 6;

/** How long after a `collisionResolved` event its port still counts as contested. */
export const COLLISION_WINDOW_MS = 60_000;

enum Rank {
  ExactPort = 0,
  PortPrefix = 1,
  ExactPid = 2,
  Name = 3,
}

function rankOf(e: PortEntry, q: string): Rank | null {
  const port = String(e.port);
  if (port === q) return Rank.ExactPort;
  if (port.startsWith(q)) return Rank.PortPrefix;
  if (String(e.pid) === q) return Rank.ExactPid;
  const haystacks = [e.processName, e.project?.name ?? "", e.project?.branch ?? "", e.command];
  return haystacks.some((h) => h.toLowerCase().includes(q)) ? Rank.Name : null;
}

/** The query as the matcher sees it: trimmed and lowercased. `""` means "no query". */
export function normalizeQuery(raw: string): string {
  return raw.trim().toLowerCase();
}

/** True when the query is only digits: the strip then shows it in the mono face and says "Nothing on :N". */
export function isNumericQuery(raw: string): boolean {
  return /^\d+$/.test(raw.trim());
}

/** The ranked matches for a non-empty query, at most `limit`. An empty query gives `recents()`. */
export function rankMatches(entries: PortEntry[], rawQuery: string, limit = QUICK_LIMIT): PortEntry[] {
  const q = normalizeQuery(rawQuery);
  if (!q) return recents(entries, limit);
  const ranked: { e: PortEntry; rank: Rank }[] = [];
  for (const e of entries) {
    const rank = rankOf(e, q);
    if (rank !== null) ranked.push({ e, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.e.port - b.e.port || a.e.pid - b.e.pid);
  return ranked.slice(0, limit).map((r) => r.e);
}

/** Newest first; unknown start times last; ties by port, then pid. */
function byRecency(a: PortEntry, b: PortEntry): number {
  return (b.startedAt ?? -Infinity) - (a.startedAt ?? -Infinity) || a.port - b.port || a.pid - b.pid;
}

/**
 * The most recently started entries that are not protected, newest first. What an empty query
 * showed in v0.1; `preselect` without zombies or collisions is exactly this.
 */
export function recents(entries: PortEntry[], limit = QUICK_LIMIT): PortEntry[] {
  return entries
    .filter((e) => !e.protected)
    .sort(byRecency)
    .slice(0, limit);
}

/** A lost-terminal server: the shell that started it is gone, launchd adopted it, nothing protects it. */
export function isZombie(e: PortEntry): boolean {
  return e.orphan && !e.protected;
}

/**
 * The ports a `collisionResolved` event named in the last `windowMs`: PortReaper freed them and
 * something else took them since. `nowMs` and `atMs` are unix milliseconds.
 */
export function collisionPorts(
  events: TasklineEvent[],
  nowMs: number,
  windowMs = COLLISION_WINDOW_MS,
): Set<number> {
  const ports = new Set<number>();
  for (const ev of events) {
    if (ev.kind === "collisionResolved" && nowMs - ev.atMs <= windowMs) ports.add(ev.port);
  }
  return ports;
}

enum Tier {
  Zombie = 0,
  Collision = 1,
  Recent = 2,
}

function tierOf(e: PortEntry, collisions: ReadonlySet<number>): Tier {
  if (isZombie(e)) return Tier.Zombie;
  if (collisions.has(e.port)) return Tier.Collision;
  return Tier.Recent;
}

/**
 * The rows for an empty query, in the order the user most likely wants them: lost-terminal
 * zombies, then the ports in `collisions` (see `collisionPorts`), then the rest; inside a tier
 * newest first. Protected entries never appear unasked, as before: a query reaches them.
 */
export function preselect(
  entries: PortEntry[],
  collisions: ReadonlySet<number> = new Set(),
  limit = QUICK_LIMIT,
): PortEntry[] {
  return entries
    .filter((e) => !e.protected)
    .map((e) => ({ e, tier: tierOf(e, collisions) }))
    .sort((a, b) => a.tier - b.tier || byRecency(a.e, b.e))
    .slice(0, limit)
    .map((x) => x.e);
}

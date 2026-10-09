import type { PortEntry } from "../types";

/**
 * What the Quick strip shows for a query. Pure: no Vue, no DOM.
 *
 * The matching rules are the main search's (`matches` in `src/composables/usePorts.ts`, which
 * is not exported): port prefix, exact pid, and a case-insensitive substring of the process
 * name, project name, branch or command line. On top of that the strip ranks: an exact port
 * first, then port prefixes, then an exact pid, then the name matches; ties by port, then pid.
 */

/** One row of the strip is a pid on a port over a protocol. Same shape as the main table's key. */
export function quickKey(e: PortEntry): string {
  return `${e.pid}:${e.port}:${e.protocol}`;
}

/** How many rows the strip shows at most. 6 × 40 px under the 56 px input and over the 24 px footer. */
export const QUICK_LIMIT = 6;

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

/**
 * The rows for an empty query: the most recently started entries that are not protected,
 * newest first. Unknown start times go last; ties by port.
 */
export function recents(entries: PortEntry[], limit = QUICK_LIMIT): PortEntry[] {
  return entries
    .filter((e) => !e.protected)
    .sort(
      (a, b) => (b.startedAt ?? -Infinity) - (a.startedAt ?? -Infinity) || a.port - b.port || a.pid - b.pid,
    )
    .slice(0, limit);
}

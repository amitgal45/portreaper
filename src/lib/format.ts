/** Pure formatting helpers for the table. No DOM, no Vue. */

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/** `412 * 1024 * 1024` → `"412 MB"`. Whole numbers below a gigabyte, one decimal above. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < KB) return `${Math.round(bytes)} B`;
  if (bytes < MB) return `${Math.round(bytes / KB)} kB`;
  if (bytes < GB) return `${Math.round(bytes / MB)} MB`;
  const gb = bytes / GB;
  return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`;
}

/**
 * How long a process has been up, in one unit: `45 s`, `20 min`, `26 h`, `3 d`.
 * `startedAt` is unix seconds (the contract); `nowSeconds` defaults to the clock.
 */
export function formatUptime(startedAt: number | null, nowSeconds: number = Date.now() / 1000): string {
  if (startedAt === null || !Number.isFinite(startedAt)) return "—";
  const s = Math.max(0, Math.floor(nowSeconds - startedAt));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

/**
 * A command line short enough for one row: every path collapses to its last segment, whitespace
 * collapses, and the result is cut at `max` characters with an ellipsis.
 * `node /Users/amit/work/shop-api/node_modules/.bin/next dev` → `node next dev`.
 */
export function shortCommand(command: string, max = 72): string {
  const compact = command
    .trim()
    .replace(/\S*\/(\S+)/g, "$1")
    .replace(/\s+/g, " ");
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** `[3000]` → `Port 3000`, `[5432, 6379]` → `Ports 5432 and 6379`, three or more → `Ports 1, 2 and 3`. */
export function formatPorts(ports: number[]): string {
  if (ports.length === 0) return "";
  if (ports.length === 1) return `Port ${ports[0]}`;
  const head = ports.slice(0, -1).join(", ");
  return `Ports ${head} and ${ports[ports.length - 1]}`;
}

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

/** A path segment that is a macOS bundle. Their names carry spaces (`Google Chrome.app`). */
const BUNDLE = /\.(app|framework|xpc|appex|bundle|plugin|kext|prefPane|qlgenerator|systemextension|dext)$/i;

/**
 * The words of a command line. Double and single quotes group words, a backslash escapes the next
 * character. The core joins argv with plain spaces (no quoting), so a macOS path with a space in a
 * bundle segment arrives split; words are joined back while the next word containing a `/` opens
 * with a bundle segment (`Chrome.app/Contents/…`), which no argument of its own does.
 */
export function splitCommand(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (c === "\\" && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return joinBundlePaths(words);
}

function joinBundlePaths(words: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < words.length) {
    let acc = words[i] as string;
    let next = i + 1;
    if (acc.includes("/")) {
      for (;;) {
        let k = next;
        while (k < words.length && !(words[k] as string).includes("/")) k++;
        if (k >= words.length) break;
        const candidate = words[k] as string;
        if (!BUNDLE.test(candidate.slice(0, candidate.indexOf("/")))) break;
        acc = `${acc} ${words.slice(next, k + 1).join(" ")}`;
        next = k + 1;
      }
    }
    out.push(acc);
    i = next;
  }
  return out;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return name || path;
}

function dirname(path: string): string {
  const at = path.lastIndexOf("/");
  if (at < 0) return "";
  return at === 0 ? "/" : path.slice(0, at);
}

/** A word of a command line as the row shows it: a path becomes its basename, `--key=path` keeps its key. */
function shortWord(word: string): string {
  if (!word.includes("/") || word.includes("://")) return word;
  const eq = word.indexOf("=");
  if (word.startsWith("-") && eq > 0) return `${word.slice(0, eq + 1)}${basename(word.slice(eq + 1))}`;
  return basename(word);
}

/**
 * A command line short enough for one row, and the full line for its tooltip. The executable
 * shows as its basename, then its arguments with every path as a basename; the text is cut at
 * `max` characters with an ellipsis. `node /Users/amit/work/shop-api/node_modules/.bin/next dev`
 * → `node next dev`.
 */
export function shortCommand(command: string, max = 60): { text: string; title: string } {
  const title = command.trim();
  const text = splitCommand(title).map(shortWord).join(" ");
  if (text.length <= max) return { text, title };
  return { text: `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`, title };
}

/**
 * Where the executable lives: the directory of `exe` when the core knows it, else of the command
 * line's first word when that is a path, else empty. For rows whose command adds nothing to the
 * process name.
 */
export function executableDir(exe: string | null, command: string): string {
  if (exe?.includes("/")) return dirname(exe);
  const first = splitCommand(command)[0];
  return first?.includes("/") ? dirname(first) : "";
}

/** `[3000]` → `Port 3000`, `[5432, 6379]` → `Ports 5432 and 6379`, three or more → `Ports 1, 2 and 3`. */
export function formatPorts(ports: number[]): string {
  if (ports.length === 0) return "";
  if (ports.length === 1) return `Port ${ports[0]}`;
  const head = ports.slice(0, -1).join(", ");
  return `Ports ${head} and ${ports[ports.length - 1]}`;
}

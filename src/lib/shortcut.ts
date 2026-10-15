/**
 * Keyboard chords the way `Settings.quickShortcut` stores them: the global-shortcut plugin's
 * syntax (`CmdOrCtrl+Shift+K`), with its glyphs for the screen (`⌘⇧K`). The recorder turns a
 * keydown into a chord here and asks `chordProblem` before it saves one.
 */

/** The four modifiers, in the order a stored chord names them. `CmdOrCtrl` is ⌘ on a Mac. */
const MODIFIERS = ["CmdOrCtrl", "Control", "Alt", "Shift"] as const;
export type Modifier = (typeof MODIFIERS)[number];

/** The plugin's aliases, so a chord typed by hand or by an older build still reads. */
const ALIASES: Record<string, Modifier> = {
  cmdorctrl: "CmdOrCtrl",
  commandorcontrol: "CmdOrCtrl",
  command: "CmdOrCtrl",
  cmd: "CmdOrCtrl",
  super: "CmdOrCtrl",
  meta: "CmdOrCtrl",
  control: "Control",
  ctrl: "Control",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};

const GLYPH: Record<Modifier, string> = { Control: "⌃", Alt: "⌥", CmdOrCtrl: "⌘", Shift: "⇧" };
/** The order the glyphs read in: ⌃⌥⌘⇧, the way the app writes ⌘⇧K everywhere. */
const GLYPH_ORDER: readonly Modifier[] = ["Control", "Alt", "CmdOrCtrl", "Shift"];

/** Chords macOS keeps for itself: close, quit, hide, minimise. */
const RESERVED = new Set(["CmdOrCtrl+W", "CmdOrCtrl+Q", "CmdOrCtrl+H", "CmdOrCtrl+M"]);

export interface Chord {
  /** In `MODIFIERS` order, each at most once. */
  modifiers: Modifier[];
  /** One upper-case letter or one digit. */
  key: string;
}

/** The key a keydown names: a letter or a digit, else null. The physical key first (⌥K types ˚). */
function keyOf(e: Pick<KeyboardEvent, "key" | "code">): string | null {
  const physical = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(e.code ?? "");
  if (physical) return (physical[1] ?? physical[2]) as string;
  return /^[a-z0-9]$/i.test(e.key ?? "") ? e.key.toUpperCase() : null;
}

function join(modifiers: readonly Modifier[], key: string): string {
  return [...modifiers, key].join("+");
}

/**
 * The chord a keydown makes, in the plugin's syntax (`CmdOrCtrl+Shift+K`), or null while only
 * modifiers are down or the key is not a letter or a digit. A bare letter is a chord here; the
 * recorder refuses it through `chordProblem`.
 */
export function chordFromKeyboardEvent(
  e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): string | null {
  const key = keyOf(e);
  if (key === null) return null;
  const modifiers: Modifier[] = [];
  if (e.metaKey) modifiers.push("CmdOrCtrl");
  if (e.ctrlKey) modifiers.push("Control");
  if (e.altKey) modifiers.push("Alt");
  if (e.shiftKey) modifiers.push("Shift");
  return join(modifiers, key);
}

/** Reads a stored chord. Null when a part is not a modifier, or the key is not one letter or digit. */
export function parseChord(chord: string): Chord | null {
  const parts = chord.split("+").map((p) => p.trim());
  const last = parts.pop();
  if (!last || !/^[a-z0-9]$/i.test(last)) return null;
  const found = new Set<Modifier>();
  for (const part of parts) {
    const modifier = ALIASES[part.toLowerCase()];
    if (!modifier) return null;
    found.add(modifier);
  }
  return { modifiers: MODIFIERS.filter((m) => found.has(m)), key: last.toUpperCase() };
}

/** `CmdOrCtrl+Shift+K` → `⌘⇧K`. A chord that does not parse is shown as it is. */
export function formatChord(chord: string): string {
  const parsed = parseChord(chord);
  if (!parsed) return chord;
  const glyphs = GLYPH_ORDER.filter((m) => parsed.modifiers.includes(m)).map((m) => GLYPH[m]);
  return `${glyphs.join("")}${parsed.key}`;
}

/**
 * Why the recorder will not save `chord`, in one line for the row, or null when it may. A chord
 * needs ⌘, ⌃ or ⌥ (Shift alone would swallow typing everywhere), and ⌘W, ⌘Q, ⌘H and ⌘M are the
 * system's.
 */
export function chordProblem(chord: string): string | null {
  const parsed = parseChord(chord);
  if (!parsed) return "Not a shortcut.";
  if (!parsed.modifiers.some((m) => m !== "Shift")) return "Add ⌘, ⌃ or ⌥.";
  const canonical = join(parsed.modifiers, parsed.key);
  if (RESERVED.has(canonical)) return `${formatChord(canonical)} belongs to macOS.`;
  return null;
}

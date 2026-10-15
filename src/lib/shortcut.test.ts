import { describe, expect, it } from "vitest";
import { chordFromKeyboardEvent, chordProblem, formatChord, parseChord } from "./shortcut";

/** A keydown the way the browser reports it: `code` is the physical key, `key` the typed character. */
function key(code: string, init: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  const typed = code.startsWith("Key") ? code.slice(3) : code.startsWith("Digit") ? code.slice(5) : code;
  return new KeyboardEvent("keydown", { code, key: init.key ?? typed.toLowerCase(), ...init });
}

describe("chordFromKeyboardEvent", () => {
  it("⌘⇧K is CmdOrCtrl+Shift+K, in the plugin's syntax and order", () => {
    expect(chordFromKeyboardEvent(key("KeyK", { metaKey: true, shiftKey: true }))).toBe("CmdOrCtrl+Shift+K");
  });

  it("⌃⌥K is Control+Alt+K: the ⌃ key is Control, not CmdOrCtrl", () => {
    // With ⌥ held, macOS types a dead key (˚); the physical key is what counts.
    expect(chordFromKeyboardEvent(key("KeyK", { ctrlKey: true, altKey: true, key: "˚" }))).toBe(
      "Control+Alt+K",
    );
  });

  it("modifiers alone are not a chord", () => {
    expect(chordFromKeyboardEvent(key("ShiftLeft", { key: "Shift", shiftKey: true }))).toBeNull();
    expect(chordFromKeyboardEvent(key("MetaLeft", { key: "Meta", metaKey: true }))).toBeNull();
    expect(chordFromKeyboardEvent(key("ControlLeft", { key: "Control", ctrlKey: true }))).toBeNull();
    expect(chordFromKeyboardEvent(key("AltLeft", { key: "Alt", altKey: true }))).toBeNull();
  });

  it("takes letters and digits, nothing else", () => {
    expect(chordFromKeyboardEvent(key("Digit3", { metaKey: true }))).toBe("CmdOrCtrl+3");
    expect(
      chordFromKeyboardEvent(key("KeyP", { metaKey: true, ctrlKey: true, altKey: true, shiftKey: true })),
    ).toBe("CmdOrCtrl+Control+Alt+Shift+P");
    expect(chordFromKeyboardEvent(key("F5", { metaKey: true, key: "F5" }))).toBeNull();
    expect(chordFromKeyboardEvent(key("Space", { metaKey: true, key: " " }))).toBeNull();
    expect(chordFromKeyboardEvent(key("Escape", { key: "Escape" }))).toBeNull();
  });

  it("falls back to the typed character when the physical code is not a letter key (other layouts)", () => {
    expect(chordFromKeyboardEvent(key("", { key: "q", metaKey: true }))).toBe("CmdOrCtrl+Q");
    expect(chordFromKeyboardEvent(key("", { key: "é", metaKey: true }))).toBeNull();
  });

  it("a bare letter is a chord too; the recorder is what refuses it", () => {
    expect(chordFromKeyboardEvent(key("KeyK"))).toBe("K");
  });
});

describe("parseChord", () => {
  it("reads the plugin's syntax with its aliases, in any order", () => {
    expect(parseChord("CmdOrCtrl+Shift+K")).toEqual({ modifiers: ["CmdOrCtrl", "Shift"], key: "K" });
    expect(parseChord("Shift+Command+k")).toEqual({ modifiers: ["CmdOrCtrl", "Shift"], key: "K" });
    expect(parseChord("Ctrl+Option+P")).toEqual({ modifiers: ["Control", "Alt"], key: "P" });
    expect(parseChord("Super+1")).toEqual({ modifiers: ["CmdOrCtrl"], key: "1" });
  });

  it("is null for junk", () => {
    expect(parseChord("")).toBeNull();
    expect(parseChord("CmdOrCtrl+")).toBeNull();
    expect(parseChord("Shift")).toBeNull();
    expect(parseChord("Hyper+K")).toBeNull();
    expect(parseChord("CmdOrCtrl+KK")).toBeNull();
  });
});

describe("formatChord", () => {
  it("shows the Mac glyphs: ⌃ ⌥ ⌘ ⇧ then the key", () => {
    expect(formatChord("CmdOrCtrl+Shift+K")).toBe("⌘⇧K");
    expect(formatChord("Control+Alt+K")).toBe("⌃⌥K");
    expect(formatChord("CmdOrCtrl+Shift+P")).toBe("⌘⇧P");
    expect(formatChord("Shift+Alt+Control+CmdOrCtrl+3")).toBe("⌃⌥⌘⇧3");
    expect(formatChord("K")).toBe("K");
  });

  it("leaves what it cannot read as it is", () => {
    expect(formatChord("Hyper+K")).toBe("Hyper+K");
    expect(formatChord("")).toBe("");
  });
});

describe("chordProblem", () => {
  it("accepts a chord with ⌘, ⌃ or ⌥ and a letter or digit", () => {
    expect(chordProblem("CmdOrCtrl+Shift+K")).toBeNull();
    expect(chordProblem("Control+Alt+K")).toBeNull();
    expect(chordProblem("Alt+3")).toBeNull();
    expect(chordProblem("CmdOrCtrl+Shift+W")).toBeNull();
  });

  it("refuses a chord without ⌘, ⌃ or ⌥: Shift alone would swallow typing", () => {
    expect(chordProblem("K")).toBe("Add ⌘, ⌃ or ⌥.");
    expect(chordProblem("Shift+K")).toBe("Add ⌘, ⌃ or ⌥.");
  });

  it("refuses ⌘W, ⌘Q, ⌘H and ⌘M, which macOS keeps", () => {
    expect(chordProblem("CmdOrCtrl+W")).toBe("⌘W belongs to macOS.");
    expect(chordProblem("CmdOrCtrl+Q")).toBe("⌘Q belongs to macOS.");
    expect(chordProblem("CmdOrCtrl+H")).toBe("⌘H belongs to macOS.");
    expect(chordProblem("CmdOrCtrl+M")).toBe("⌘M belongs to macOS.");
  });

  it("refuses what it cannot read", () => {
    expect(chordProblem("Hyper+K")).toBe("Not a shortcut.");
  });
});

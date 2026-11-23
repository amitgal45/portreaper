import type { CategoryFilter } from "./usePorts";

/** ⌘1–⌘4, in order (spec item 7): the sidebar's "Ports" categories. The sidebar shows the hints. */
export const CATEGORY_SHORTCUTS: readonly CategoryFilter[] = ["all", "dev", "ai", "db"];

export interface KeyboardHandlers {
  /** ↑ */
  up(): void;
  /** ↓ */
  down(): void;
  /** Enter: kill the selection (the confirm rule still applies). */
  enter(): void;
  /** ⌘⌫: force-kill the selection. Returns false to leave the key to the input it was typed in. */
  forceKill(): boolean;
  /** Esc: clear the search, then the selection. */
  escape(): void;
  /** ⌘F */
  focusSearch(): void;
  /** ⌘R */
  refresh(): void;
  /** ⌘, : the Preferences view. */
  preferences(): void;
  /** ⌘1–⌘4: show the Studio on `CATEGORY_SHORTCUTS[index]`, like a click on its sidebar item. */
  category(index: number): void;
  /** A digit typed outside any input: start a search with it. */
  digit(digit: string): void;
}

export interface UseKeyboardOptions {
  /** When false, every key is left alone (a dialog is open). */
  enabled?: () => boolean;
  target?: Pick<Window, "addEventListener" | "removeEventListener">;
}

const EDITABLE = "input, textarea, select, [contenteditable='true'], [contenteditable='']";
/** Focus inside a reka-ui menu or dialog belongs to that layer. */
const OVERLAY =
  "[role='menu'], [role='menuitem'], [role='dialog'], [role='alertdialog'], [data-reka-popper-content-wrapper]";

function isEditable(target: EventTarget | null): boolean {
  return target instanceof Element && target.matches(EDITABLE);
}

function inOverlay(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(OVERLAY) !== null;
}

/**
 * The 0-based category of a ⌘-digit, or null. The key's character ("1"–"4") or its place on the
 * digit row (`Digit1`–`Digit4`): on AZERTY the digit row types "&", "é", '"', "'" without Shift.
 */
function categoryIndex(event: KeyboardEvent): number | null {
  const count = CATEGORY_SHORTCUTS.length;
  const byKey = /^[1-9]$/.exec(event.key);
  if (byKey && Number(byKey[0]) <= count) return Number(byKey[0]) - 1;
  const byCode = /^Digit([1-9])$/.exec(event.code);
  if (byCode && Number(byCode[1]) <= count) return Number(byCode[1]) - 1;
  return null;
}

/**
 * The window-level keys. Arrows, Enter and Esc work from inside the search box too, so the whole
 * flow is "type, ↓, Enter". Digits outside any input jump to the search; with ⌘ the first four
 * pick a category (by key or by place on the digit row), from the search box too. Nothing fires while a dialog or menu owns the focus.
 * Call `start()` on mount and `stop()` on unmount.
 */
export function useKeyboard(handlers: KeyboardHandlers, options: UseKeyboardOptions = {}) {
  const enabled = options.enabled ?? (() => true);
  const target = options.target ?? (typeof window === "undefined" ? null : window);

  function handle(event: KeyboardEvent) {
    if (event.defaultPrevented || !enabled() || inOverlay(event.target)) return;
    const editable = isEditable(event.target);
    const meta = event.metaKey || event.ctrlKey;

    if (meta && !event.shiftKey && !event.altKey) {
      const key = event.key.toLowerCase();
      const index = categoryIndex(event);
      if (key === "f") {
        event.preventDefault();
        handlers.focusSearch();
      } else if (key === "r") {
        event.preventDefault();
        handlers.refresh();
      } else if (key === ",") {
        event.preventDefault();
        handlers.preferences();
      } else if (event.key === "Backspace") {
        if (handlers.forceKill()) event.preventDefault();
      } else if (index !== null) {
        event.preventDefault();
        handlers.category(index);
      }
      return;
    }
    if (event.altKey || meta) return;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        handlers.down();
        return;
      case "ArrowUp":
        event.preventDefault();
        handlers.up();
        return;
      case "Enter":
        // A focused button handles its own Enter; the list's Enter is for the selection.
        if (event.target instanceof Element && event.target.matches("button, a, [role='button']")) return;
        event.preventDefault();
        handlers.enter();
        return;
      case "Escape":
        event.preventDefault();
        handlers.escape();
        return;
      default:
        if (!editable && /^[0-9]$/.test(event.key)) {
          event.preventDefault();
          handlers.digit(event.key);
        }
    }
  }

  return {
    handle,
    start() {
      target?.addEventListener("keydown", handle as EventListener);
    },
    stop() {
      target?.removeEventListener("keydown", handle as EventListener);
    },
  };
}

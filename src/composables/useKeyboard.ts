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
 * The window-level keys. Arrows, Enter and Esc work from inside the search box too, so the whole
 * flow is "type, ↓, Enter". Digits outside any input jump to the search. Nothing fires while a
 * dialog or menu owns the focus. Call `start()` on mount and `stop()` on unmount.
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
      if (key === "f") {
        event.preventDefault();
        handlers.focusSearch();
      } else if (key === "r") {
        event.preventDefault();
        handlers.refresh();
      } else if (event.key === "Backspace") {
        if (handlers.forceKill()) event.preventDefault();
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

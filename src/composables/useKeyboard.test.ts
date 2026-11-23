import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "../api/mock";
import { type KeyboardHandlers, useKeyboard } from "./useKeyboard";
import { usePorts } from "./usePorts";

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function handlers() {
  return {
    up: vi.fn<() => void>(),
    down: vi.fn<() => void>(),
    enter: vi.fn<() => void>(),
    forceKill: vi.fn<() => boolean>(() => true),
    escape: vi.fn<() => void>(),
    focusSearch: vi.fn<() => void>(),
    refresh: vi.fn<() => void>(),
    preferences: vi.fn<() => void>(),
    category: vi.fn<(index: number) => void>(),
    digit: vi.fn<(digit: string) => void>(),
  } satisfies KeyboardHandlers;
}

describe("useKeyboard", () => {
  let h: ReturnType<typeof handlers>;
  let keyboard: ReturnType<typeof useKeyboard>;
  let enabled = true;

  beforeEach(() => {
    enabled = true;
    h = handlers();
    keyboard = useKeyboard(h, { enabled: () => enabled });
    keyboard.start();
  });
  afterEach(() => {
    keyboard.stop();
    document.body.innerHTML = "";
  });

  it("maps the keys", () => {
    press("ArrowDown");
    press("ArrowUp");
    press("Enter");
    press("Escape");
    expect(h.down).toHaveBeenCalledTimes(1);
    expect(h.up).toHaveBeenCalledTimes(1);
    expect(h.enter).toHaveBeenCalledTimes(1);
    expect(h.escape).toHaveBeenCalledTimes(1);
    press("f", { metaKey: true });
    press("r", { metaKey: true });
    press("Backspace", { metaKey: true });
    expect(h.focusSearch).toHaveBeenCalledTimes(1);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.forceKill).toHaveBeenCalledTimes(1);
  });

  it("⌘, opens Preferences, from the search input too; a bare comma does not", () => {
    const comma = press(",", { metaKey: true });
    expect(h.preferences).toHaveBeenCalledTimes(1);
    expect(comma.defaultPrevented).toBe(true);
    const input = document.createElement("input");
    document.body.appendChild(input);
    press(",", { metaKey: true }, input);
    expect(h.preferences).toHaveBeenCalledTimes(2);
    press(",");
    press(",", { metaKey: true, shiftKey: true });
    expect(h.preferences).toHaveBeenCalledTimes(2);
  });

  it("⌘1–⌘4 pick the category by its index (All ports, Dev servers, Local AI, Databases)", () => {
    const events = ["1", "2", "3", "4"].map((digit) => press(digit, { metaKey: true }));
    expect(h.category.mock.calls).toEqual([[0], [1], [2], [3]]);
    expect(events.map((e) => e.defaultPrevented)).toEqual([true, true, true, true]);
    expect(h.digit).not.toHaveBeenCalled();
    // The keys ⌘F, ⌘R, ⌘, and ⌘⌫ are untouched.
    expect(h.focusSearch).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.preferences).not.toHaveBeenCalled();
    expect(h.forceKill).not.toHaveBeenCalled();
  });

  it("⌘1–⌘4 work from inside the search input, like ⌘F", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    const event = press("2", { metaKey: true }, input);
    press("4", { metaKey: true }, input);
    expect(h.category.mock.calls).toEqual([[1], [3]]);
    expect(event.defaultPrevented).toBe(true);
    expect(h.digit).not.toHaveBeenCalled();
  });

  it("⌘ with Shift or Alt and a digit does nothing, and ⌘5–⌘9, ⌘0 are left alone", () => {
    const ignored = [
      press("1", { metaKey: true, shiftKey: true }),
      press("!", { metaKey: true, shiftKey: true }),
      press("2", { metaKey: true, altKey: true }),
      press("™", { metaKey: true, altKey: true }),
      press("3", { metaKey: true, shiftKey: true, altKey: true }),
      press("5", { metaKey: true }),
      press("9", { metaKey: true }),
      press("0", { metaKey: true }),
    ];
    expect(h.category).not.toHaveBeenCalled();
    expect(h.digit).not.toHaveBeenCalled();
    expect(ignored.map((e) => e.defaultPrevented)).toEqual(ignored.map(() => false));
  });

  it("a bare digit still starts a search, the four included; ⌘1 does nothing while a dialog or menu has the focus", () => {
    for (const digit of ["1", "2", "3", "4"]) press(digit);
    expect(h.digit.mock.calls).toEqual([["1"], ["2"], ["3"], ["4"]]);
    expect(h.category).not.toHaveBeenCalled();

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inside = document.createElement("button");
    dialog.appendChild(inside);
    document.body.appendChild(dialog);
    press("1", { metaKey: true }, inside);
    enabled = false;
    press("1", { metaKey: true });
    expect(h.category).not.toHaveBeenCalled();
  });

  it("sends a digit typed outside an input to the search, not one typed inside", () => {
    press("3");
    expect(h.digit).toHaveBeenCalledWith("3");
    const input = document.createElement("input");
    document.body.appendChild(input);
    press("4", {}, input);
    expect(h.digit).toHaveBeenCalledTimes(1);
    press("a");
    expect(h.digit).toHaveBeenCalledTimes(1);
  });

  it("lets arrows, Enter and Esc through from the search input", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    const down = press("ArrowDown", {}, input);
    press("Enter", {}, input);
    press("Escape", {}, input);
    expect(down.defaultPrevented).toBe(true);
    expect(h.down).toHaveBeenCalledTimes(1);
    expect(h.enter).toHaveBeenCalledTimes(1);
    expect(h.escape).toHaveBeenCalledTimes(1);
  });

  it("leaves Enter to a focused button and ⌘⌫ to the input when there is nothing to kill", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    press("Enter", {}, button);
    expect(h.enter).not.toHaveBeenCalled();
    h.forceKill.mockReturnValueOnce(false);
    const event = press("Backspace", { metaKey: true });
    expect(event.defaultPrevented).toBe(false);
  });

  it("does nothing while disabled or inside a menu or dialog", () => {
    enabled = false;
    press("Enter");
    expect(h.enter).not.toHaveBeenCalled();
    enabled = true;
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    const item = document.createElement("div");
    menu.appendChild(item);
    document.body.appendChild(menu);
    press("Enter", {}, item);
    press("Escape", {}, item);
    expect(h.enter).not.toHaveBeenCalled();
    expect(h.escape).not.toHaveBeenCalled();
  });

  it("stops listening after stop()", () => {
    keyboard.stop();
    press("ArrowDown");
    expect(h.down).not.toHaveBeenCalled();
    keyboard.start();
  });
});

describe("useKeyboard with usePorts", () => {
  it("↑/↓ clamp on the list and Enter kills the selection", async () => {
    const api = createMockApi();
    const killProcess = vi.spyOn(api, "killProcess");
    const store = usePorts(api, { storage: null });
    await store.refresh();
    const keyboard = useKeyboard({
      up: store.selectPrev,
      down: store.selectNext,
      enter: () => {
        if (store.selected.value) void store.kill(store.selected.value);
      },
      forceKill: () => false,
      escape: () => {},
      focusSearch: () => {},
      refresh: () => {},
      preferences: () => {},
      category: () => {},
      digit: () => {},
    });
    keyboard.start();
    // The last row: Ollama, a protected brew service, in the last group.
    press("ArrowUp");
    expect(store.selected.value?.port).toBe(11434);
    press("ArrowDown");
    expect(store.selected.value?.port).toBe(11434);
    for (let i = 0; i < 20; i++) press("ArrowUp");
    expect(store.selected.value?.port).toBe(3000);
    const startedAt = store.selected.value?.startedAt;
    press("Enter");
    expect(killProcess).toHaveBeenCalledWith({ pid: 48213, force: false, startedAt });
    keyboard.stop();
  });
});

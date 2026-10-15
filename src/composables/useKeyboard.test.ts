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
      digit: () => {},
    });
    keyboard.start();
    press("ArrowUp");
    expect(store.selected.value?.port).toBe(7000);
    press("ArrowDown");
    expect(store.selected.value?.port).toBe(7000);
    for (let i = 0; i < 20; i++) press("ArrowUp");
    expect(store.selected.value?.port).toBe(3000);
    press("Enter");
    expect(killProcess).toHaveBeenCalledWith({ pid: 48213, force: false });
    keyboard.stop();
  });
});

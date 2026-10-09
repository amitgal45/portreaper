import { afterEach, describe, expect, it, vi } from "vitest";
import { hideCurrentWindow } from "./window";

const { hide, getCurrentWindow } = vi.hoisted(() => {
  const hide = vi.fn(async () => {});
  return { hide, getCurrentWindow: vi.fn(() => ({ hide })) };
});
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow }));

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  vi.clearAllMocks();
});

describe("hideCurrentWindow", () => {
  it("is a no-op in a browser tab", async () => {
    expect(await hideCurrentWindow()).toBe(false);
    expect(getCurrentWindow).not.toHaveBeenCalled();
  });

  it("hides the current window inside Tauri", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    expect(await hideCurrentWindow()).toBe(true);
    expect(getCurrentWindow).toHaveBeenCalledTimes(1);
    expect(hide).toHaveBeenCalledTimes(1);
  });
});

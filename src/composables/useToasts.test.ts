import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToasts } from "./useToasts";

describe("useToasts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("lasts four seconds", () => {
    const { toasts, push } = useToasts();
    push("Killed node (1). Port 3000 is free.");
    expect(toasts.value).toHaveLength(1);
    vi.advanceTimersByTime(3999);
    expect(toasts.value).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(toasts.value).toHaveLength(0);
  });

  it("stacks three at most, dropping the oldest", () => {
    const { toasts, push } = useToasts();
    push("one");
    push("two");
    push("three");
    push("four");
    expect(toasts.value.map((t) => t.message)).toEqual(["two", "three", "four"]);
  });

  it("can be dismissed early", () => {
    const { toasts, push, dismiss } = useToasts();
    const t = push("gone", "error");
    expect(t.kind).toBe("error");
    dismiss(t.id);
    expect(toasts.value).toHaveLength(0);
    vi.advanceTimersByTime(5000);
    expect(toasts.value).toHaveLength(0);
  });
});

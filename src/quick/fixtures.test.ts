import { afterEach, describe, expect, it, vi } from "vitest";
import { API_KEY } from "../api";
import { MOCK_ENTRIES } from "../api/mock";
import { fixtureApi, OLLAMA, provideFixture } from "./fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fixtures", () => {
  it("?fixture=ai is the mock plus the Ollama row; anything else is no fixture", async () => {
    const seeded = fixtureApi("?fixture=ai");
    expect(seeded).not.toBeNull();
    const ports = (await seeded?.listPorts())?.map((e) => e.port);
    expect(ports).toEqual([...MOCK_ENTRIES.map((e) => e.port), OLLAMA.port]);
    expect(fixtureApi("")).toBeNull();
    expect(fixtureApi("?fixture=nope")).toBeNull();
    expect(fixtureApi("?other=1")).toBeNull();
  });

  it("provides the seeded api to the app in a browser, and nothing inside Tauri", () => {
    const provide = vi.fn();
    provideFixture({ provide }, "?fixture=ai");
    expect(provide).toHaveBeenCalledTimes(1);
    expect(provide.mock.calls[0]?.[0]).toBe(API_KEY);

    provide.mockClear();
    provideFixture({ provide }, "");
    expect(provide).not.toHaveBeenCalled();

    vi.stubGlobal("window", { ...window, __TAURI_INTERNALS__: {} });
    provideFixture({ provide }, "?fixture=ai");
    expect(provide).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { SETTINGS_CHANGED_EVENT } from "../api/events";
import { createMockApi, MOCK_ENTRIES } from "../api/mock";
import type { LaunchdJob, PortApi, PortEntry, TasklineEvent } from "../types";
import { armedText, QUICK_CACHE_KEY, type QuickCache, useQuick } from "./useQuick";

const { hideCurrentWindow } = vi.hoisted(() => ({ hideCurrentWindow: vi.fn(async () => false) }));
vi.mock("../api/window", () => ({ hideCurrentWindow }));
// The core's `settings:changed`, delivered by hand once a test plays the Tauri window.
const { listen } = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
const tauri = window as unknown as Record<string, unknown>;

const key = (k: string, init: KeyboardEventInit = {}) =>
  new KeyboardEvent("keydown", { key: k, cancelable: true, ...init });

/**
 * What an empty query shows on the mock: the lost-terminal :5174 and :4000 first (newest first),
 * then the rest newest first, nothing protected (Ollama, a brew service launchd restarts, is), six at most.
 */
const PRESELECTED = [5174, 4000, 5173, 3000, 8080, 9335];

const CONTROL_CENTER_EXE = "/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter";

/** ControlCenter on :5000 (AirPlay Receiver) as the core sends it: Apple's job, a system one. */
const controlCenter: PortEntry = {
  ...(MOCK_ENTRIES.find((e) => e.port === 7000) as PortEntry),
  port: 5000,
  pid: 635,
  processName: "ControlCenter",
  command: CONTROL_CENTER_EXE,
  exe: CONTROL_CENTER_EXE,
  parentPid: 1,
  protected: true,
  launchd: { label: "com.apple.controlcenter", restarts: null, brew: null, stopCommand: null, system: true },
};

/** A strip that has loaded once and is not polling. */
async function loaded(api: PortApi = createMockApi()) {
  const quick = useQuick(api, { isVisible: () => false });
  await quick.refresh();
  return quick;
}

const collision = (port: number, agoMs: number): TasklineEvent => ({
  id: port,
  atMs: Date.now() - agoMs,
  kind: "collisionResolved",
  port,
  protocol: "tcp",
  pid: 1,
  processName: "node",
  project: null,
  memoryBytes: 0,
  durationMs: 0,
  message: "",
  relaunchable: false,
});

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useQuick: matching and selection", () => {
  it("shows the pre-selection when the query is empty: the zombies first, then newest first, nothing protected", async () => {
    const quick = await loaded();
    expect(quick.loaded.value).toBe(true);
    expect(quick.matches.value.map((e) => e.port)).toEqual(PRESELECTED);
    expect(quick.matches.value.some((e) => e.protected)).toBe(false);
    expect(quick.selected.value?.port).toBe(5174);
  });

  it("ranks an exact port before a prefix before a name, and selects the first match", async () => {
    const extra: PortEntry = { ...(MOCK_ENTRIES[0] as PortEntry), port: 30, pid: 77, processName: "thirty" };
    const named: PortEntry = { ...(MOCK_ENTRIES[0] as PortEntry), port: 9999, pid: 78, processName: "x30y" };
    const quick = await loaded(createMockApi([...MOCK_ENTRIES, extra, named]));
    quick.query.value = "30";
    await nextTick();
    expect(quick.matches.value.map((e) => e.port)).toEqual([30, 3000, 9999]);
    expect(quick.selected.value?.port).toBe(30);
  });

  it("↓ and ↑ move the selection and clamp at the ends", async () => {
    const quick = await loaded();
    quick.handleKey(key("ArrowDown"));
    expect(quick.selected.value?.port).toBe(4000);
    quick.handleKey(key("ArrowUp"));
    quick.handleKey(key("ArrowUp"));
    expect(quick.selected.value?.port).toBe(5174);
    for (let i = 0; i < 9; i++) quick.handleKey(key("ArrowDown"));
    expect(quick.selected.value?.port).toBe(9335);
  });

  it("names the empty states", async () => {
    const quick = await loaded();
    expect(quick.emptyText.value).toBeNull();
    quick.query.value = "99";
    await nextTick();
    expect(quick.emptyText.value).toBe("Nothing on :99");
    quick.query.value = "zzz";
    await nextTick();
    expect(quick.emptyText.value).toBe("Nothing matches");
    const empty = await loaded(createMockApi([]));
    expect(empty.emptyText.value).toBe("No listening ports.");
  });
});

describe("useQuick: pre-selection from the Taskline", () => {
  it("a port a collisionResolved event named in the last minute goes after the zombies, before the rest", async () => {
    const api = createMockApi();
    vi.spyOn(api, "tasklineEvents").mockResolvedValue([collision(8080, 30_000), collision(3000, 61_000)]);
    const quick = useQuick(api, { isVisible: () => false });
    quick.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(quick.matches.value.map((e) => e.port)).toEqual([5174, 4000, 8080, 5173, 3000, 9335]);
    expect(quick.selected.value?.port).toBe(5174);
    quick.stop();
  });

  it("asks the Taskline once per show: on start and on focus, never on a poll", async () => {
    const api = createMockApi();
    const tasklineEvents = vi.spyOn(api, "tasklineEvents");
    const quick = useQuick(api, { isVisible: () => true });
    quick.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(tasklineEvents).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6000);
    expect(tasklineEvents).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(tasklineEvents).toHaveBeenCalledTimes(2);
    quick.stop();
  });

  it("falls back to zombies, then newest, when the Taskline rejects", async () => {
    const api = createMockApi();
    vi.spyOn(api, "tasklineEvents").mockRejectedValue(new Error("no taskline"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const quick = useQuick(api, { isVisible: () => false });
    quick.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(quick.matches.value.map((e) => e.port)).toEqual(PRESELECTED);
    expect(quick.error.value).toBeNull();
    quick.stop();
  });
});

describe("useQuick: Enter", () => {
  it("frees the selected port gracefully, shows the result for 180 ms, then clears and hides", async () => {
    const api = createMockApi();
    const freePort = vi.spyOn(api, "freePort");
    const quick = await loaded(api);
    quick.query.value = "3000";
    await nextTick();

    quick.handleKey(key("Enter"));
    await vi.advanceTimersByTimeAsync(0);
    expect(freePort).toHaveBeenCalledWith(3000, false);
    expect(quick.result.value).toEqual({
      key: "48213:3000:tcp",
      text: "Freed :3000 · node (48213)",
      ok: true,
    });
    expect(quick.query.value).toBe("3000");
    expect(hideCurrentWindow).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(179);
    expect(quick.result.value).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(quick.result.value).toBeNull();
    expect(quick.query.value).toBe("");
    expect(hideCurrentWindow).toHaveBeenCalledTimes(1);
    expect(quick.matches.value.some((e) => e.port === 3000)).toBe(false);
  });

  it("⌥Enter forces", async () => {
    const api = createMockApi();
    const freePort = vi.spyOn(api, "freePort");
    const quick = await loaded(api);
    quick.query.value = "5173";
    await nextTick();
    quick.handleKey(key("Enter", { altKey: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(freePort).toHaveBeenCalledWith(5173, true);
  });

  it("does nothing with no match, and ignores a second Enter while one is in flight", async () => {
    const api = createMockApi();
    let release: (value: Awaited<ReturnType<PortApi["freePort"]>>) => void = () => {};
    const freePort = vi.spyOn(api, "freePort").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const quick = await loaded(api);
    quick.query.value = "nothing";
    await nextTick();
    quick.handleKey(key("Enter"));
    expect(freePort).not.toHaveBeenCalled();

    quick.query.value = "3000";
    await nextTick();
    quick.handleKey(key("Enter"));
    quick.handleKey(key("Enter"));
    expect(freePort).toHaveBeenCalledTimes(1);
    expect(quick.busy.value).toBe(true);
    release([{ status: "killed", pid: 48213, graceful: true, waitedMs: 0 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(quick.busy.value).toBe(false);
    expect(quick.result.value?.ok).toBe(true);
  });

  it("shows a refusal for 2 s; the query and the strip stay, nothing hides", async () => {
    const api = createMockApi();
    vi.spyOn(api, "freePort").mockResolvedValue([
      { status: "refused", pid: 48213, reason: "permission denied" },
    ]);
    const quick = await loaded(api);
    quick.query.value = "3000";
    await nextTick();
    quick.handleKey(key("Enter"));
    await vi.advanceTimersByTimeAsync(0);
    expect(quick.result.value).toEqual({
      key: "48213:3000:tcp",
      text: "Did not kill node (48213): permission denied",
      ok: false,
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(quick.result.value).not.toBeNull();
    expect(hideCurrentWindow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(quick.result.value).toBeNull();
    expect(quick.query.value).toBe("3000");
    expect(hideCurrentWindow).not.toHaveBeenCalled();
    // Not killed: the row is still there, ⌥Enter can try again.
    expect(quick.entries.value.some((e) => e.port === 3000)).toBe(true);
    expect(quick.selected.value?.port).toBe(3000);
  });

  it("a failure stays 2 s too, and the pids that did die leave the list when it clears", async () => {
    const api = createMockApi();
    vi.spyOn(api, "freePort").mockResolvedValue([
      { status: "killed", pid: 48213, graceful: true, waitedMs: 0 },
      { status: "failed", pid: 51022, error: "EPERM" },
    ]);
    const quick = await loaded(api);
    quick.query.value = "3000";
    await nextTick();
    quick.handleKey(key("Enter"));
    await vi.advanceTimersByTimeAsync(0);
    expect(quick.result.value).toEqual({
      key: "48213:3000:tcp",
      text: "Could not kill node (51022): EPERM",
      ok: false,
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(quick.result.value).toBeNull();
    expect(quick.query.value).toBe("3000");
    expect(hideCurrentWindow).not.toHaveBeenCalled();
    expect(quick.entries.value.some((e) => e.pid === 48213)).toBe(false);
    expect(quick.entries.value.some((e) => e.pid === 51022)).toBe(true);
  });

  it("says when the core cannot be reached, for 2 s, and hides nothing", async () => {
    const api = createMockApi();
    vi.spyOn(api, "freePort").mockRejectedValue(new Error("ipc down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const quick = await loaded(api);
    quick.query.value = "3000";
    await nextTick();
    quick.handleKey(key("Enter"));
    await vi.advanceTimersByTimeAsync(0);
    expect(quick.result.value).toEqual({
      key: "48213:3000:tcp",
      text: "Could not reach the core",
      ok: false,
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(quick.result.value).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(quick.result.value).toBeNull();
    expect(quick.query.value).toBe("3000");
    expect(hideCurrentWindow).not.toHaveBeenCalled();
  });

  it("names every process when a port had several, and says when it was already free", async () => {
    const api = createMockApi();
    const quick = await loaded(api);
    quick.query.value = "3000";
    await nextTick();
    vi.spyOn(api, "freePort").mockResolvedValueOnce([
      { status: "killed", pid: 48213, graceful: true, waitedMs: 0 },
      { status: "killed", pid: 51022, graceful: true, waitedMs: 0 },
    ]);
    quick.handleKey(key("Enter"));
    await vi.advanceTimersByTimeAsync(0);
    expect(quick.result.value?.text).toBe("Freed :3000 · node (48213), node (51022)");
    await vi.advanceTimersByTimeAsync(180);

    quick.query.value = "8080";
    await nextTick();
    vi.spyOn(api, "freePort").mockResolvedValueOnce([]);
    quick.handleKey(key("Enter"));
    await vi.advanceTimersByTimeAsync(0);
    expect(quick.result.value?.text).toBe(":8080 is already free");
  });

  it("kills a portless (port: 0 / stdio) orphan by pid via killProcess and reports Killed without :0", async () => {
    const mcp: PortEntry = {
      ...(MOCK_ENTRIES[0] as PortEntry),
      port: 0,
      pid: 61204,
      address: "stdio",
      processName: "mcp-server-filesystem",
      command: "mcp-server-filesystem /Users/amit/work",
      orphan: true,
      protected: false,
      category: "ai",
      framework: "MCP",
    };
    const api = createMockApi([...MOCK_ENTRIES, mcp]);
    const killProcess = vi.spyOn(api, "killProcess");
    const freePort = vi.spyOn(api, "freePort");
    const quick = await loaded(api);
    quick.query.value = "stdio";
    await nextTick();
    expect(quick.selected.value?.pid).toBe(61204);

    quick.handleKey(key("Enter"));
    await vi.advanceTimersByTimeAsync(0);
    expect(killProcess).toHaveBeenCalledWith({ pid: 61204, force: false });
    expect(freePort).not.toHaveBeenCalled();
    expect(quick.result.value).toEqual({
      key: "61204:0:tcp",
      text: "Killed mcp-server-filesystem (61204)",
      ok: true,
    });
  });
});

describe("useQuick: a protected entry", () => {
  it("arms on the first Enter, kills on the second within 5 s", async () => {
    const api = createMockApi();
    const freePort = vi.spyOn(api, "freePort");
    const quick = await loaded(api);
    quick.query.value = "5432";
    await nextTick();
    expect(quick.selected.value?.protected).toBe(true);

    quick.handleKey(key("Enter"));
    await vi.advanceTimersByTimeAsync(0);
    expect(freePort).not.toHaveBeenCalled();
    expect(quick.armed.value).toEqual({
      key: "11710:5432:tcp",
      text: "This is Docker (com.docker.backend).",
      hint: "Press Enter again to kill it.",
    });

    await vi.advanceTimersByTimeAsync(4000);
    quick.handleKey(key("Enter"));
    await vi.advanceTimersByTimeAsync(0);
    expect(freePort).toHaveBeenCalledWith(5432, false);
    expect(quick.armed.value).toBeNull();
    expect(quick.result.value?.text).toBe("Freed :5432 · com.docker.backend (11710)");
  });

  it("disarms after 5 s, on any other key, and when the query changes; modifiers alone do not", async () => {
    const api = createMockApi();
    const freePort = vi.spyOn(api, "freePort");
    const quick = await loaded(api);
    quick.query.value = "5432";
    await nextTick();

    quick.handleKey(key("Enter"));
    expect(quick.armed.value).not.toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(quick.armed.value).toBeNull();

    quick.handleKey(key("Enter"));
    expect(quick.armed.value).not.toBeNull();
    quick.handleKey(key("Alt"));
    quick.handleKey(key("Shift"));
    expect(quick.armed.value).not.toBeNull();
    quick.handleKey(key("ArrowDown"));
    expect(quick.armed.value).toBeNull();

    quick.handleKey(key("Enter"));
    expect(quick.armed.value).not.toBeNull();
    quick.handleKey(key("a"));
    expect(quick.armed.value).toBeNull();

    quick.handleKey(key("Enter"));
    expect(quick.armed.value).not.toBeNull();
    quick.query.value = "543";
    await nextTick();
    expect(quick.armed.value).toBeNull();

    expect(freePort).not.toHaveBeenCalled();
  });

  it("a brew service launchd restarts says so when armed, and names the core's command that stops it", async () => {
    const api = createMockApi();
    const freePort = vi.spyOn(api, "freePort");
    const quick = await loaded(api);
    quick.query.value = "ollama";
    await nextTick();
    expect(quick.selected.value?.port).toBe(11434);
    expect(quick.selected.value?.protected).toBe(true);

    quick.handleKey(key("Enter"));
    await vi.advanceTimersByTimeAsync(0);
    expect(freePort).not.toHaveBeenCalled();
    expect(quick.armed.value).toEqual({
      key: "32014:11434:tcp",
      text: "ollama restarts after a kill (launchd). Enter again to kill it anyway;",
      hint: "brew services stop ollama stops it.",
    });
    // The row shows the text, then the hint: one sentence.
    const armed = quick.armed.value;
    expect(`${armed?.text} ${armed?.hint}`).toBe(
      "ollama restarts after a kill (launchd). Enter again to kill it anyway; brew services stop ollama stops it.",
    );

    // Kill anyway is the second Enter, as for any protected row.
    quick.handleKey(key("Enter"));
    await vi.advanceTimersByTimeAsync(0);
    expect(freePort).toHaveBeenCalledWith(11434, false);
    expect(quick.result.value?.text).toBe("Freed :11434 · ollama (32014)");
  });

  it("armedText: a restarting job without a stop command, a job that stays down, and a cached entry", () => {
    const ollama = MOCK_ENTRIES.find((e) => e.port === 11434) as PortEntry;
    const job = ollama.launchd as LaunchdJob;
    expect(armedText({ ...ollama, launchd: { ...job, stopCommand: null } }, "amit")).toEqual({
      text: "ollama restarts after a kill (launchd).",
      hint: "Enter again to kill it anyway.",
    });
    const protectedText = {
      text: "This is a protected process (ollama).",
      hint: "Press Enter again to kill it.",
    };
    expect(armedText({ ...ollama, launchd: { ...job, restarts: false } }, "amit")).toEqual(protectedText);
    // The session cache can hold an entry from a core that did not send `launchd` yet.
    const cached = { ...ollama, launchd: undefined } as unknown as PortEntry;
    expect(armedText(cached, "amit")).toEqual(protectedText);
  });

  it("armedText: a job nobody can tell about may restart, with the stop hint only when the core built one", () => {
    const ollama = MOCK_ENTRIES.find((e) => e.port === 11434) as PortEntry;
    const vague: LaunchdJob = { ...(ollama.launchd as LaunchdJob), restarts: null };
    expect(armedText({ ...ollama, launchd: vague }, "amit")).toEqual({
      text: "ollama may restart after a kill (launchd). Enter again to kill it anyway;",
      hint: "brew services stop ollama stops it.",
    });
    expect(armedText({ ...ollama, launchd: { ...vague, stopCommand: null } }, "amit")).toEqual({
      text: "ollama may restart after a kill (launchd).",
      hint: "Enter again to kill it anyway.",
    });
  });

  it("armedText: a system job gets the ordinary protected text, whatever launchd does to it", () => {
    const protectedText = {
      text: "This is a system process (ControlCenter).",
      hint: "Press Enter again to kill it.",
    };
    expect(armedText(controlCenter, "amit")).toEqual(protectedText);
    const apple = controlCenter.launchd as LaunchdJob;
    expect(armedText({ ...controlCenter, launchd: { ...apple, restarts: true } }, "amit")).toEqual(
      protectedText,
    );
    // A cached entry from a core that sent no `system`: the launchd text, as before.
    const older = {
      ...controlCenter,
      launchd: { label: "com.apple.controlcenter", restarts: true, brew: null, stopCommand: null },
    } as unknown as PortEntry;
    expect(armedText(older, "amit")).toEqual({
      text: "ControlCenter restarts after a kill (launchd).",
      hint: "Enter again to kill it anyway.",
    });
  });

  it("ControlCenter on :5000, Apple's job: the first Enter arms it with the protected text, the second kills", async () => {
    const api = createMockApi(MOCK_ENTRIES.map((e) => (e.port === 7000 ? controlCenter : e)));
    const freePort = vi.spyOn(api, "freePort");
    const quick = await loaded(api);
    quick.query.value = "5000";
    await nextTick();
    expect(quick.selected.value?.pid).toBe(635);
    expect(quick.selected.value?.protected).toBe(true);

    quick.handleKey(key("Enter"));
    await vi.advanceTimersByTimeAsync(0);
    expect(freePort).not.toHaveBeenCalled();
    expect(quick.armed.value).toEqual({
      key: "635:5000:tcp",
      text: "This is a system process (ControlCenter).",
      hint: "Press Enter again to kill it.",
    });
    expect(quick.armed.value?.text).not.toContain("(launchd)");

    quick.handleKey(key("Enter"));
    await vi.advanceTimersByTimeAsync(0);
    expect(freePort).toHaveBeenCalledWith(5000, false);
    expect(freePort).toHaveBeenCalledTimes(1);
  });

  it("a job nobody can tell about asks first: the first Enter arms it with may restart, the second kills", async () => {
    const ollama = MOCK_ENTRIES.find((e) => e.port === 11434) as PortEntry;
    const job = ollama.launchd as LaunchdJob;
    const unknown: PortEntry = { ...ollama, launchd: { ...job, restarts: null } };
    const api = createMockApi(MOCK_ENTRIES.map((e) => (e.port === 11434 ? unknown : e)));
    const freePort = vi.spyOn(api, "freePort");
    const quick = await loaded(api);
    quick.query.value = "ollama";
    await nextTick();
    expect(quick.selected.value?.protected).toBe(true);

    quick.handleKey(key("Enter"));
    await vi.advanceTimersByTimeAsync(0);
    expect(freePort).not.toHaveBeenCalled();
    expect(quick.armed.value).toEqual({
      key: "32014:11434:tcp",
      text: "ollama may restart after a kill (launchd). Enter again to kill it anyway;",
      hint: "brew services stop ollama stops it.",
    });

    quick.handleKey(key("Enter"));
    await vi.advanceTimersByTimeAsync(0);
    expect(freePort).toHaveBeenCalledWith(11434, false);
  });

  it("⌥Enter on an armed row forces", async () => {
    const api = createMockApi();
    const freePort = vi.spyOn(api, "freePort");
    const quick = await loaded(api);
    quick.query.value = "7000";
    await nextTick();
    quick.handleKey(key("Enter"));
    expect(quick.armed.value?.text).toBe("This is a system process (ControlCenter).");
    quick.handleKey(key("Alt"));
    quick.handleKey(key("Enter", { altKey: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(freePort).toHaveBeenCalledWith(7000, true);
  });
});

describe("useQuick: Esc", () => {
  it("disarms first, then clears the query, then hides the window", async () => {
    const quick = await loaded();
    quick.query.value = "5432";
    await nextTick();
    quick.handleKey(key("Enter"));
    expect(quick.armed.value).not.toBeNull();

    quick.handleKey(key("Escape"));
    expect(quick.armed.value).toBeNull();
    expect(quick.query.value).toBe("5432");
    expect(hideCurrentWindow).not.toHaveBeenCalled();

    quick.handleKey(key("Escape"));
    expect(quick.query.value).toBe("");
    expect(hideCurrentWindow).not.toHaveBeenCalled();

    quick.handleKey(key("Escape"));
    expect(hideCurrentWindow).toHaveBeenCalledTimes(1);
  });
});

describe("useQuick: refresh", () => {
  it("lists on start, on window focus, and every 2 s while visible; pauses when hidden", async () => {
    const api = createMockApi();
    const listPorts = vi.spyOn(api, "listPorts");
    let visible = true;
    const quick = useQuick(api, { isVisible: () => visible });
    quick.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(listPorts).toHaveBeenCalledTimes(1);
    expect(quick.loaded.value).toBe(true);

    await vi.advanceTimersByTimeAsync(2000);
    expect(listPorts).toHaveBeenCalledTimes(2);

    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(listPorts).toHaveBeenCalledTimes(3);

    visible = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(6000);
    expect(listPorts).toHaveBeenCalledTimes(3);

    visible = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(listPorts).toHaveBeenCalledTimes(4);

    quick.stop();
    await vi.advanceTimersByTimeAsync(4000);
    window.dispatchEvent(new Event("focus"));
    expect(listPorts).toHaveBeenCalledTimes(4);
  });

  it("keeps the last list and reports the error when a poll fails; the next tick clears it", async () => {
    const api = createMockApi();
    const quick = useQuick(api, { isVisible: () => true });
    quick.start();
    await vi.advanceTimersByTimeAsync(0);
    vi.spyOn(api, "listPorts").mockRejectedValueOnce(new Error("core went away"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(2000);
    expect(quick.error.value).toBe("core went away");
    expect(quick.matches.value).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(2000);
    expect(quick.error.value).toBeNull();
    quick.stop();
  });

  it("a stale poll does not resurrect a killed pid", async () => {
    const api = createMockApi();
    const quick = await loaded(api);
    quick.query.value = "3000";
    await nextTick();
    // The poll that answers next was built before the kill: it still lists pid 48213.
    vi.spyOn(api, "listPorts").mockResolvedValueOnce(MOCK_ENTRIES.map((e) => ({ ...e })));
    quick.handleKey(key("Enter"));
    await vi.advanceTimersByTimeAsync(180);
    await quick.refresh();
    expect(quick.entries.value.some((e) => e.pid === 48213)).toBe(false);
  });

  it("the window-level listener drives the keys", async () => {
    const api = createMockApi();
    const freePort = vi.spyOn(api, "freePort");
    const quick = useQuick(api, { isVisible: () => false });
    quick.start();
    await vi.advanceTimersByTimeAsync(0);
    const event = key("Enter");
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(freePort).toHaveBeenCalledWith(5174, false);
    quick.stop();
  });
});

describe("useQuick: the cached list", () => {
  it("paints the cached list before the first poll answers; the poll replaces it and refills the cache", async () => {
    const api = createMockApi();
    const write = vi.fn();
    const cache: QuickCache = { read: () => MOCK_ENTRIES.slice(0, 2).map((e) => ({ ...e })), write };
    const quick = useQuick(api, { isVisible: () => false, cache });
    expect(quick.loaded.value).toBe(true);
    expect(quick.matches.value.map((e) => e.port)).toEqual([5173, 3000]);
    expect(quick.selected.value?.port).toBe(5173);
    await quick.refresh();
    expect(quick.matches.value.map((e) => e.port)).toEqual(PRESELECTED);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toHaveLength(MOCK_ENTRIES.length);
  });

  it("by default the cache is sessionStorage: the next strip in the session paints from it, and a bad one is ignored", async () => {
    const first = await loaded();
    expect(sessionStorage.getItem(QUICK_CACHE_KEY)).not.toBeNull();
    expect(first.entries.value).toHaveLength(MOCK_ENTRIES.length);

    const second = useQuick(createMockApi([]), { isVisible: () => false });
    expect(second.loaded.value).toBe(true);
    expect(second.matches.value.map((e) => e.port)).toEqual(PRESELECTED);
    await second.refresh();
    expect(second.matches.value).toEqual([]);
    expect(second.emptyText.value).toBe("No listening ports.");

    sessionStorage.setItem(QUICK_CACHE_KEY, "{not json");
    const third = useQuick(createMockApi(), { isVisible: () => false });
    expect(third.loaded.value).toBe(false);
    expect(third.entries.value).toEqual([]);

    sessionStorage.setItem(QUICK_CACHE_KEY, JSON.stringify({ a: 1 }));
    const fourth = useQuick(createMockApi(), { isVisible: () => false });
    expect(fourth.loaded.value).toBe(false);
  });

  it("a port hidden since the cache was written leaves the painted rows and the cache once getSettings answers, before any poll", async () => {
    const api = createMockApi();
    await api.setSettings({ ...(await api.getSettings()), hiddenPorts: [5173] });
    // The first poll is still out the whole time: only the hidden list can take 5173 away.
    const never = () => new Promise<PortEntry[]>(() => {});
    const listPorts = vi.spyOn(api, "listPorts").mockImplementation(never);
    const write = vi.fn();
    const cache: QuickCache = { read: () => MOCK_ENTRIES.map((e) => ({ ...e })), write };
    const quick = useQuick(api, { isVisible: () => false, cache });
    expect(quick.matches.value.map((e) => e.port)).toEqual(PRESELECTED);

    quick.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(listPorts).toHaveBeenCalledTimes(1);
    expect(quick.entries.value.some((e) => e.port === 5173)).toBe(false);
    // Nothing moves up into the six: the seventh, Ollama, is a brew service launchd restarts, and
    // a protected row is never preselected.
    expect(quick.matches.value.map((e) => e.port)).toEqual([5174, 4000, 3000, 8080, 9335]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toHaveLength(MOCK_ENTRIES.length - 1);
    quick.stop();
  });

  it("a cached row is never resurrected after its kill", async () => {
    const api = createMockApi();
    const quick = await loaded(api);
    quick.query.value = "3000";
    await nextTick();
    quick.handleKey(key("Enter"));
    await vi.advanceTimersByTimeAsync(180);
    const cached = JSON.parse(sessionStorage.getItem(QUICK_CACHE_KEY) ?? "[]") as PortEntry[];
    expect(cached.some((e) => e.pid === 48213)).toBe(false);
  });
});

describe("useQuick: hidden ports", () => {
  afterEach(() => {
    listen.mockReset();
    delete tauri.__TAURI_INTERNALS__;
  });

  it("follows settings:changed: a port hidden while the strip is up leaves it, the cache and every later poll at once", async () => {
    tauri.__TAURI_INTERNALS__ = {};
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    const api = createMockApi();
    const base = await api.getSettings();
    // The start's own read answers late, after the event: it must not undo what the event said.
    let answer: (settings: Awaited<ReturnType<PortApi["getSettings"]>>) => void = () => {};
    vi.spyOn(api, "getSettings").mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const quick = useQuick(api, { isVisible: () => false });
    quick.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen.mock.calls[0]?.[0]).toBe(SETTINGS_CHANGED_EVENT);
    expect(quick.entries.value.some((e) => e.port === 3000)).toBe(true);

    const deliver = listen.mock.calls[0]?.[1] as (event: { payload: unknown }) => void;
    deliver({ payload: { ...base, hiddenPorts: [3000] } });
    expect(quick.entries.value.some((e) => e.port === 3000)).toBe(false);
    const cached = JSON.parse(sessionStorage.getItem(QUICK_CACHE_KEY) ?? "[]") as PortEntry[];
    expect(cached.some((e) => e.port === 3000)).toBe(false);

    answer({ ...base, hiddenPorts: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(quick.entries.value.some((e) => e.port === 3000)).toBe(false);
    // This mock core was never told, so its next answer still lists :3000, like a poll that left
    // before the change: the strip keeps it out.
    await quick.refresh();
    expect(quick.entries.value.some((e) => e.port === 3000)).toBe(false);
    expect(quick.entries.value).toHaveLength(MOCK_ENTRIES.length - 1);

    // Shown again: the next poll has it.
    deliver({ payload: { ...base, hiddenPorts: [] } });
    await quick.refresh();
    expect(quick.entries.value.some((e) => e.port === 3000)).toBe(true);

    quick.stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

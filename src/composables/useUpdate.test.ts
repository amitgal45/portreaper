import { afterEach, describe, expect, it, vi } from "vitest";
import { UPDATE_AVAILABLE_EVENT, UPDATE_ERROR_EVENT, UPDATE_PROGRESS_EVENT } from "../api/events";
import { createMockApi, MOCK_UPDATE } from "../api/mock";
import { bannerText, demoUpdate, percentOf, useUpdate } from "./useUpdate";

const { listen } = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

const tauri = window as unknown as Record<string, unknown>;

describe("demoUpdate", () => {
  afterEach(() => {
    delete tauri.__TAURI_INTERNALS__;
  });

  it("starts the banner from the mock update for ?update=1 in a browser, and from nothing otherwise", () => {
    expect(demoUpdate("?update=1")).toEqual(MOCK_UPDATE);
    expect(demoUpdate("?fixture=x&update=1")).toEqual(MOCK_UPDATE);
    expect(demoUpdate("")).toBeNull();
    expect(demoUpdate("?update=0")).toBeNull();
  });

  it("does nothing inside Tauri, where the core is the only source", () => {
    tauri.__TAURI_INTERNALS__ = {};
    expect(demoUpdate("?update=1")).toBeNull();
  });
});

describe("percentOf", () => {
  it("floors, caps at 100 and is null without a total", () => {
    expect(percentOf(42, 100)).toBe(42);
    expect(percentOf(999, 1000)).toBe(99);
    expect(percentOf(1200, 1000)).toBe(100);
    expect(percentOf(0, 100)).toBe(0);
    expect(percentOf(10, null)).toBeNull();
    expect(percentOf(10, 0)).toBeNull();
  });
});

describe("bannerText", () => {
  it("has one line per state", () => {
    expect(bannerText({ phase: "idle" })).toBeNull();
    expect(bannerText({ phase: "available", info: MOCK_UPDATE })).toBe("PortReaper 0.3.0 is ready");
    expect(
      bannerText({ phase: "downloading", info: MOCK_UPDATE, downloaded: 42, total: 100, installed: false }),
    ).toBe("Downloading… 42%");
    expect(
      bannerText({
        phase: "downloading",
        info: MOCK_UPDATE,
        downloaded: 3 * 1024 * 1024,
        total: null,
        installed: false,
      }),
    ).toBe("Downloading… 3 MB");
    expect(
      bannerText({ phase: "downloading", info: MOCK_UPDATE, downloaded: 100, total: 100, installed: true }),
    ).toBe("Restarting…");
    expect(
      bannerText({ phase: "error", info: MOCK_UPDATE, message: "The update could not be verified" }),
    ).toBe("The update could not be verified");
  });
});

describe("useUpdate", () => {
  afterEach(() => {
    listen.mockReset();
    delete tauri.__TAURI_INTERNALS__;
  });

  it("starts idle, or ready from a seed", () => {
    expect(useUpdate(createMockApi()).state.value).toEqual({ phase: "idle" });
    expect(useUpdate(createMockApi(), { seed: MOCK_UPDATE }).state.value).toEqual({
      phase: "available",
      info: MOCK_UPDATE,
    });
  });

  it("install walks ready → downloading → Restarting… on the mock", async () => {
    const api = createMockApi();
    vi.spyOn(api, "installUpdate").mockResolvedValue(undefined);
    const update = useUpdate(api, { seed: MOCK_UPDATE });
    const installing = update.install();
    expect(update.state.value).toEqual({
      phase: "downloading",
      info: MOCK_UPDATE,
      downloaded: 0,
      total: null,
      installed: false,
    });
    await installing;
    expect(update.state.value).toMatchObject({ phase: "downloading", installed: true });
    expect(bannerText(update.state.value)).toBe("Restarting…");
  });

  it("a rejected install is the error state, and Retry installs again", async () => {
    const api = createMockApi();
    const installUpdate = vi
      .spyOn(api, "installUpdate")
      .mockRejectedValueOnce(new Error("Couldn't reach the update server"))
      .mockRejectedValueOnce("plain string")
      .mockResolvedValueOnce(undefined);
    const update = useUpdate(api, { seed: MOCK_UPDATE });
    await update.install();
    expect(update.state.value).toEqual({
      phase: "error",
      info: MOCK_UPDATE,
      message: "Couldn't reach the update server",
    });
    await update.install();
    expect(update.state.value).toMatchObject({ phase: "error", message: "plain string" });
    await update.install();
    expect(update.state.value).toMatchObject({ phase: "downloading", installed: true });
    expect(installUpdate).toHaveBeenCalledTimes(3);
  });

  it("does not install while idle or already downloading", async () => {
    const api = createMockApi();
    let finish: () => void = () => {};
    const installUpdate = vi
      .spyOn(api, "installUpdate")
      .mockImplementation(() => new Promise<void>((r) => (finish = r)));
    const idle = useUpdate(api);
    await idle.install();
    expect(installUpdate).not.toHaveBeenCalled();

    const update = useUpdate(api, { seed: MOCK_UPDATE });
    const first = update.install();
    await update.install();
    expect(installUpdate).toHaveBeenCalledTimes(1);
    finish();
    await first;
  });

  it("the core's events: a new find shows the banner, progress moves it, a failure offers Retry", () => {
    const update = useUpdate(createMockApi());
    // The core announces before it downloads: progress or an error while idle is dropped.
    update.progress({ downloaded: 1, total: 2 });
    update.failed({ message: "nope" });
    expect(update.state.value).toEqual({ phase: "idle" });

    update.available(MOCK_UPDATE);
    expect(update.state.value).toEqual({ phase: "available", info: MOCK_UPDATE });
    update.progress({ downloaded: 42, total: 100 });
    expect(update.state.value).toEqual({
      phase: "downloading",
      info: MOCK_UPDATE,
      downloaded: 42,
      total: 100,
      installed: false,
    });
    // The six-hour check announces the same release again: the download is left alone.
    update.available(MOCK_UPDATE);
    expect(update.state.value).toMatchObject({ phase: "downloading", downloaded: 42 });
    update.failed({ message: "The update could not be verified" });
    expect(update.state.value).toEqual({
      phase: "error",
      info: MOCK_UPDATE,
      message: "The update could not be verified",
    });
    // A newer find after a failure replaces it.
    const newer = { ...MOCK_UPDATE, version: "0.3.1" };
    update.available(newer);
    expect(update.state.value).toEqual({ phase: "available", info: newer });
  });

  it("subscribes to the three events inside Tauri, once, and unsubscribes on stop", async () => {
    tauri.__TAURI_INTERNALS__ = {};
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    const update = useUpdate(createMockApi());
    update.start();
    update.start();
    await Promise.resolve();
    expect(listen.mock.calls.map((c) => c[0])).toEqual([
      UPDATE_AVAILABLE_EVENT,
      UPDATE_PROGRESS_EVENT,
      UPDATE_ERROR_EVENT,
    ]);

    const deliver = (index: number, payload: unknown) => {
      const handler = listen.mock.calls[index]?.[1] as ((event: { payload: unknown }) => void) | undefined;
      if (!handler) throw new Error(`no listener ${index}`);
      handler({ payload });
    };
    deliver(0, MOCK_UPDATE);
    deliver(1, { downloaded: 5, total: 10 });
    expect(update.state.value).toMatchObject({ phase: "downloading", downloaded: 5, total: 10 });
    deliver(2, { message: "Couldn't reach the update server" });
    expect(update.state.value).toMatchObject({ phase: "error" });

    update.stop();
    expect(unlisten).toHaveBeenCalledTimes(3);
  });

  it("is a no-op outside Tauri", () => {
    const update = useUpdate(createMockApi());
    update.start();
    expect(listen).not.toHaveBeenCalled();
    update.stop();
  });
});

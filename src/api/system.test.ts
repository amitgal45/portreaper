import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText, openInBrowser, revealFolder } from "./system";

const { writeText, openUrl, revealItemInDir } = vi.hoisted(() => ({
  writeText: vi.fn(async (_text: string) => {}),
  openUrl: vi.fn(async (_url: string) => {}),
  revealItemInDir: vi.fn(async (_path: string) => {}),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl, revealItemInDir }));

function insideTauri() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
}

/**
 * happy-dom puts a real `Clipboard` behind a getter on `Navigator.prototype`. An own property on
 * `navigator` shadows it for one test; deleting it in `afterEach` brings the getter back.
 */
function stubClipboard(clipboard: { writeText: (text: string) => Promise<void> } | undefined) {
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
}

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  Reflect.deleteProperty(navigator, "clipboard");
  vi.clearAllMocks();
});

describe("openInBrowser", () => {
  it("is a no-op in a browser tab", async () => {
    expect(await openInBrowser(3000)).toBe(false);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("opens http://localhost:<port> inside Tauri", async () => {
    insideTauri();
    expect(await openInBrowser(3000)).toBe(true);
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith("http://localhost:3000");
  });
});

describe("copyText", () => {
  it("copies with the clipboard plugin inside Tauri, not navigator.clipboard", async () => {
    const browserWriteText = vi.fn(async (_text: string) => {});
    stubClipboard({ writeText: browserWriteText });
    insideTauri();
    expect(await copyText("kill -9 4242")).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("kill -9 4242");
    expect(browserWriteText).not.toHaveBeenCalled();
  });

  it("copies with navigator.clipboard in a browser tab, not the plugin", async () => {
    const browserWriteText = vi.fn(async (_text: string) => {});
    stubClipboard({ writeText: browserWriteText });
    expect(await copyText("kill -9 4242")).toBe(true);
    expect(browserWriteText).toHaveBeenCalledTimes(1);
    expect(browserWriteText).toHaveBeenCalledWith("kill -9 4242");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("resolves false and calls nothing with no navigator.clipboard", async () => {
    stubClipboard(undefined);
    expect(navigator.clipboard).toBeUndefined();
    expect(await copyText("kill -9 4242")).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("revealFolder", () => {
  it("is a no-op in a browser tab", async () => {
    expect(await revealFolder("/Users/amit/work/shop")).toBe(false);
    expect(revealItemInDir).not.toHaveBeenCalled();
  });

  it("is a no-op inside Tauri with an empty path", async () => {
    insideTauri();
    expect(await revealFolder("")).toBe(false);
    expect(revealItemInDir).not.toHaveBeenCalled();
  });

  it("reveals the folder in Finder inside Tauri", async () => {
    insideTauri();
    expect(await revealFolder("/Users/amit/work/shop")).toBe(true);
    expect(revealItemInDir).toHaveBeenCalledTimes(1);
    expect(revealItemInDir).toHaveBeenCalledWith("/Users/amit/work/shop");
  });
});

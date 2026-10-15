import { API_KEY, isTauri } from "../api";
import { createMockApi, MOCK_ENTRIES } from "../api/mock";
import type { PortApi, PortEntry } from "../types";

/**
 * Rows the shared mock lacks, for the strip's own tests and screenshots: `src/api/mock.ts` is
 * WP-11's, so what the HUD needs beyond :3000, :5432 and :5174 is seeded here. In a browser
 * (`pnpm dev`, Playwright) `quick.html?fixture=ai` adds them; inside Tauri nothing here runs.
 */

const now = Math.floor(Date.now() / 1000);

/** A local model server holding 4.9 GB: the one row where the chip says how much memory a kill gives back. */
export const OLLAMA: PortEntry = {
  port: 11434,
  protocol: "tcp",
  bind: "loopback",
  address: "127.0.0.1",
  pid: 7012,
  processName: "ollama",
  command: "/Applications/Ollama.app/Contents/Resources/ollama serve",
  cwd: "/Users/amit",
  exe: "/Applications/Ollama.app/Contents/Resources/ollama",
  user: "amit",
  memoryBytes: Math.round(4.9 * 1024 * 1024 * 1024),
  startedAt: now - 40 * 60,
  parentPid: 1,
  orphan: false,
  project: null,
  protected: false,
  category: "ai",
  framework: "Ollama",
};

export const FIXTURES: Record<string, PortEntry[]> = {
  ai: [OLLAMA],
};

/** The mock seeded with the fixture `?fixture=<name>` asks for, or `null` when the page should use the default api. */
export function fixtureApi(search: string): PortApi | null {
  const name = new URLSearchParams(search).get("fixture");
  const extra = name ? FIXTURES[name] : undefined;
  return extra ? createMockApi([...MOCK_ENTRIES, ...extra]) : null;
}

/** Provides the fixture's api to `app` when the page asked for one and this is not the real window. */
export function provideFixture(
  app: { provide(key: typeof API_KEY, value: PortApi): unknown },
  search: string,
): void {
  if (isTauri()) return;
  const seeded = fixtureApi(search);
  if (seeded) app.provide(API_KEY, seeded);
}

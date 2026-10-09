import { describe, expect, it } from "vitest";
import { createMockApi, MOCK_ENTRIES } from "./mock";

describe("mock api", () => {
  it("lists a believable machine", async () => {
    const api = createMockApi();
    const entries = await api.listPorts();
    expect(entries.length).toBe(MOCK_ENTRIES.length);
    expect(entries.find((e) => e.port === 3000)?.project?.branch).toBe("feature/cart");
  });

  it("a killed pid disappears on the next list", async () => {
    const api = createMockApi();
    const outcome = await api.killProcess({ pid: 48213, force: false });
    expect(outcome.status).toBe("killed");
    expect((await api.listPorts()).some((e) => e.pid === 48213)).toBe(false);
  });

  it("freeing a port kills each pid once", async () => {
    const api = createMockApi();
    const outcomes = await api.freePort(5432, false);
    expect(outcomes).toHaveLength(1);
    expect((await api.listPorts()).some((e) => e.port === 6379)).toBe(false);
  });

  it("does not mutate the seed", async () => {
    const api = createMockApi();
    await api.killProcess({ pid: 51022, force: true });
    expect(MOCK_ENTRIES.some((e) => e.pid === 51022)).toBe(true);
  });
});

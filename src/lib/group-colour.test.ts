import { describe, expect, it } from "vitest";
import { createMockApi } from "../api/mock";
import { groupEntries } from "../composables/usePorts";
import { groupColour } from "./group-colour";

describe("groupColour", () => {
  it("is one of the five pill colours and stable for a name", () => {
    const palette = ["bg-blue", "bg-orange", "bg-purple", "bg-green", "bg-red"];
    for (const name of ["shop-api", "portreaper", "@specmate/api", "ollama", ""]) {
      expect(palette).toContain(groupColour(name));
      expect(groupColour(name)).toBe(groupColour(name));
    }
  });

  it("spreads the mock's groups over several colours", async () => {
    const groups = groupEntries(await createMockApi().listPorts());
    const colours = new Set(groups.map((g) => groupColour(g.name)));
    expect(colours.size).toBeGreaterThanOrEqual(3);
  });
});

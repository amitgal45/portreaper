import { describe, expect, it } from "vitest";
import { MOCK_ENTRIES } from "../api/mock";
import type { PortEntry } from "../types";
import { guessCurrentUser, protectionReason } from "./protection";

const byPort = (port: number): PortEntry => {
  const found = MOCK_ENTRIES.find((e) => e.port === port);
  if (!found) throw new Error(`no mock entry on ${port}`);
  return found;
};

describe("protectionReason", () => {
  it("names Docker, system processes and databases", () => {
    expect(protectionReason(byPort(5432), "amit")).toBe("Docker");
    expect(protectionReason(byPort(7000), "amit")).toBe("a system process");
    expect(protectionReason(byPort(53), "amit")).toBe("a system process");
    expect(protectionReason({ ...byPort(5432), processName: "postgres", project: null }, "amit")).toBe(
      "a database",
    );
  });

  it("recognises another user's process only when it knows who we are", () => {
    const foreign = { ...byPort(9335), user: "bob", protected: true };
    expect(protectionReason(foreign, "amit")).toBe("another user's process");
    expect(protectionReason(foreign, null)).toBe("a protected process");
    expect(protectionReason({ ...foreign, user: "amit" }, "amit")).toBe("a protected process");
  });
});

describe("guessCurrentUser", () => {
  it("is whoever owns the dev servers", () => {
    expect(guessCurrentUser(MOCK_ENTRIES)).toBe("amit");
    expect(guessCurrentUser([])).toBeNull();
    expect(guessCurrentUser(MOCK_ENTRIES.filter((e) => e.protected))).toBeNull();
  });
});

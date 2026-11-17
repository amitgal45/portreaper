import { describe, expect, it } from "vitest";
import { MOCK_ENTRIES } from "../api/mock";
import type { LaunchdJob, PortEntry } from "../types";
import { guessCurrentUser, launchdHint, protectionReason, restartsText } from "./protection";

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

  it("names a launchd job that starts again after a kill first: a Homebrew service by its formula", () => {
    // The mock's ollama is `brew services` ollama, KeepAlive.
    expect(protectionReason(byPort(11434), "amit")).toBe(
      "a Homebrew service (ollama) that launchd starts again after a kill",
    );
    const agent: LaunchdJob = {
      label: "com.example.agent",
      restarts: true,
      brew: null,
      stopCommand:
        "launchctl disable gui/501/com.example.agent && launchctl bootout gui/501/com.example.agent",
    };
    expect(protectionReason({ ...byPort(11434), launchd: agent }, "amit")).toBe(
      "a launchd job that launchd starts again after a kill",
    );
    // Before everything else: a brew service that is a database still asks because of launchd.
    const redis = { ...byPort(5432), processName: "redis-server", project: null };
    const brewRedis: LaunchdJob = { ...agent, label: "homebrew.mxcl.redis", brew: "redis" };
    expect(protectionReason({ ...redis, launchd: brewRedis }, "amit")).toBe(
      "a Homebrew service (redis) that launchd starts again after a kill",
    );
  });

  it("falls back to the other rules for a job that stays down, an unknown one, or an entry without the field", () => {
    const job = byPort(11434).launchd as LaunchdJob;
    expect(protectionReason({ ...byPort(11434), launchd: { ...job, restarts: false } }, "amit")).toBe(
      "a protected process",
    );
    expect(protectionReason({ ...byPort(11434), launchd: { ...job, restarts: null } }, "amit")).toBe(
      "a protected process",
    );
    // An entry the Quick strip cached before the core sent `launchd`.
    const cached = { ...byPort(11434), launchd: undefined } as unknown as PortEntry;
    expect(protectionReason(cached, "amit")).toBe("a protected process");
  });

  it("recognises another user's process only when it knows who we are", () => {
    const foreign = { ...byPort(9335), user: "bob", protected: true };
    expect(protectionReason(foreign, "amit")).toBe("another user's process");
    expect(protectionReason(foreign, null)).toBe("a protected process");
    expect(protectionReason({ ...foreign, user: "amit" }, "amit")).toBe("a protected process");
  });
});

describe("restartsText and launchdHint", () => {
  it("say what a kill does to the job", () => {
    expect(restartsText(true)).toBe("a kill is undone within seconds");
    expect(restartsText(false)).toBe("a kill lasts until the next login");
    expect(restartsText(null)).toBe("launchd may start it again");
    expect(restartsText(undefined)).toBe("launchd may start it again");
    expect(launchdHint(byPort(11434).launchd as LaunchdJob)).toBe(
      "started by launchd (homebrew.mxcl.ollama): a kill is undone within seconds",
    );
    const job: LaunchdJob = { label: "com.example.agent", restarts: null, brew: null, stopCommand: null };
    expect(launchdHint(job)).toBe("started by launchd (com.example.agent): launchd may start it again");
  });
});

describe("guessCurrentUser", () => {
  it("is whoever owns the dev servers", () => {
    expect(guessCurrentUser(MOCK_ENTRIES)).toBe("amit");
    expect(guessCurrentUser([])).toBeNull();
    expect(guessCurrentUser(MOCK_ENTRIES.filter((e) => e.protected))).toBeNull();
  });
});

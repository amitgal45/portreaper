import { describe, expect, it } from "vitest";
import { MOCK_ENTRIES } from "../api/mock";
import type { LaunchdJob, PortEntry } from "../types";
import {
  guessCurrentUser,
  jobText,
  launchdHint,
  offeredStopCommand,
  protectionReason,
  restartsText,
} from "./protection";

const byPort = (port: number): PortEntry => {
  const found = MOCK_ENTRIES.find((e) => e.port === port);
  if (!found) throw new Error(`no mock entry on ${port}`);
  return found;
};

const CONTROL_CENTER_EXE = "/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter";

/** ControlCenter on :5000 (AirPlay Receiver) as the core sends it: Apple's job, a system one. */
const controlCenter: PortEntry = {
  ...byPort(7000),
  port: 5000,
  pid: 635,
  processName: "ControlCenter",
  command: CONTROL_CENTER_EXE,
  exe: CONTROL_CENTER_EXE,
  parentPid: 1,
  protected: true,
  launchd: { label: "com.apple.controlcenter", restarts: null, brew: null, stopCommand: null, system: true },
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
      system: false,
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

  it("names a launchd job nobody can tell about as one that launchd may start again", () => {
    // `restarts: null` (`brew services run`, a conditional KeepAlive, a job's child): the core asks first.
    const job = byPort(11434).launchd as LaunchdJob;
    expect(protectionReason({ ...byPort(11434), launchd: { ...job, restarts: null } }, "amit")).toBe(
      "a Homebrew service (ollama) that launchd may start again after a kill",
    );
    const agent: LaunchdJob = {
      label: "com.example.agent",
      restarts: null,
      brew: null,
      stopCommand: null,
      system: false,
    };
    expect(protectionReason({ ...byPort(11434), launchd: agent }, "amit")).toBe(
      "a launchd job that launchd may start again after a kill",
    );
  });

  it("names ControlCenter on :5000, Apple's job, a system process, not a launchd job that may come back", () => {
    expect(protectionReason(controlCenter, "amit")).toBe("a system process");
    // Whatever launchd does to it: `system` comes before the launchd rules.
    const apple = controlCenter.launchd as LaunchdJob;
    expect(protectionReason({ ...controlCenter, launchd: { ...apple, restarts: true } }, "amit")).toBe(
      "a system process",
    );
    // The core's flag decides, not the path: Apple's label from a Homebrew exe is a system process too.
    const homebrewExe = { ...byPort(11434), exe: "/opt/homebrew/bin/x", command: "/opt/homebrew/bin/x" };
    const appleJob: LaunchdJob = { ...apple, label: "COM.APPLE.x", restarts: true };
    expect(protectionReason({ ...homebrewExe, launchd: appleJob }, "amit")).toBe("a system process");
    expect(protectionReason({ ...homebrewExe, launchd: { ...appleJob, system: false } }, "amit")).toBe(
      "a launchd job that launchd starts again after a kill",
    );
    // A cached entry from a core that sent no `system`: the launchd rules, as before.
    const older = {
      ...homebrewExe,
      launchd: { label: "com.example.agent", restarts: true, brew: null, stopCommand: null },
    } as unknown as PortEntry;
    expect(protectionReason(older, "amit")).toBe("a launchd job that launchd starts again after a kill");
  });

  it("falls back to the other rules for a job that stays down, or an entry without the field", () => {
    const job = byPort(11434).launchd as LaunchdJob;
    expect(protectionReason({ ...byPort(11434), launchd: { ...job, restarts: false } }, "amit")).toBe(
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
    const job: LaunchdJob = {
      label: "com.example.agent",
      restarts: null,
      brew: null,
      stopCommand: null,
      system: false,
    };
    expect(launchdHint(job)).toBe("started by launchd (com.example.agent): launchd may start it again");
  });

  it("call a system job a system process, as the kill dialog and the strip do", () => {
    const apple = controlCenter.launchd as LaunchdJob;
    expect(jobText(apple)).toBe("a system process");
    expect(jobText({ ...apple, restarts: true })).toBe("a system process");
    expect(launchdHint(apple)).toBe("started by launchd (com.apple.controlcenter): a system process");
    expect(jobText(byPort(11434).launchd as LaunchdJob)).toBe("a kill is undone within seconds");
  });
});

describe("offeredStopCommand", () => {
  it("hands over the core's command, never one for a system job, and nothing without a job", () => {
    const ollama = byPort(11434).launchd as LaunchdJob;
    expect(offeredStopCommand(ollama)).toBe("brew services stop ollama");
    // A buggy core that sent a command for ControlCenter: nothing is offered.
    const disable =
      "launchctl disable gui/501/com.apple.controlcenter && launchctl bootout gui/501/com.apple.controlcenter";
    const apple = controlCenter.launchd as LaunchdJob;
    expect(offeredStopCommand({ ...apple, stopCommand: disable })).toBeNull();
    expect(offeredStopCommand(apple)).toBeNull();
    expect(offeredStopCommand(null)).toBeNull();
    expect(offeredStopCommand(undefined)).toBeNull();
  });
});

describe("guessCurrentUser", () => {
  it("is whoever owns the dev servers", () => {
    expect(guessCurrentUser(MOCK_ENTRIES)).toBe("amit");
    expect(guessCurrentUser([])).toBeNull();
    expect(guessCurrentUser(MOCK_ENTRIES.filter((e) => e.protected))).toBeNull();
  });
});

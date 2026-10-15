import { describe, expect, it } from "vitest";
import {
  executableDir,
  formatBytes,
  formatPorts,
  formatTime,
  formatUptime,
  shortCommand,
  splitCommand,
} from "./format";

describe("formatBytes", () => {
  it("renders megabytes as whole numbers", () => {
    expect(formatBytes(412 * 1024 * 1024)).toBe("412 MB");
    expect(formatBytes(48 * 1024 * 1024)).toBe("48 MB");
  });

  it("picks the unit by size", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(900 * 1024)).toBe("900 kB");
    expect(formatBytes(1200 * 1024 * 1024)).toBe("1.2 GB");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2 GB");
    expect(formatBytes(12.4 * 1024 * 1024 * 1024)).toBe("12 GB");
  });

  it("does not crash on garbage", () => {
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});

describe("formatUptime", () => {
  const now = 1_700_000_000;

  it("uses one unit", () => {
    expect(formatUptime(now - 45, now)).toBe("45 s");
    expect(formatUptime(now - 20 * 60, now)).toBe("20 min");
    expect(formatUptime(now - 26 * 3600, now)).toBe("26 h");
    expect(formatUptime(now - 3 * 24 * 3600, now)).toBe("3 d");
  });

  it("rounds down and never goes negative", () => {
    expect(formatUptime(now - 119, now)).toBe("1 min");
    expect(formatUptime(now - 47 * 3600 - 59 * 60, now)).toBe("47 h");
    expect(formatUptime(now + 30, now)).toBe("0 s");
  });

  it("shows a dash when the core does not know", () => {
    expect(formatUptime(null, now)).toBe("—");
  });
});

const CHROME =
  "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/chrome_crashpad_handler";

describe("splitCommand", () => {
  it("splits on whitespace and keeps quoted and escaped spaces inside a word", () => {
    expect(splitCommand("node dist/main.js --port=8080")).toEqual(["node", "dist/main.js", "--port=8080"]);
    expect(splitCommand('"/Applications/Visual Studio Code.app/Contents/MacOS/Electron" --inspect')).toEqual([
      "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
      "--inspect",
    ]);
    expect(splitCommand("'/Volumes/My Disk/run' --name 'a b'")).toEqual([
      "/Volumes/My Disk/run",
      "--name",
      "a b",
    ]);
    expect(splitCommand("/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --x")).toEqual([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "--x",
    ]);
  });

  it("keeps an unquoted macOS bundle path whole (the core joins argv with plain spaces)", () => {
    expect(splitCommand(`${CHROME} --monitor-self-annotation=ptype=crashpad-handler`)).toEqual([
      CHROME,
      "--monitor-self-annotation=ptype=crashpad-handler",
    ]);
    // A path argument with a space in a bundle segment, too.
    expect(splitCommand("open -a /Applications/Google Chrome.app/Contents/MacOS/Google")).toEqual([
      "open",
      "-a",
      "/Applications/Google Chrome.app/Contents/MacOS/Google",
    ]);
  });

  it("handles empty input and runs of whitespace", () => {
    expect(splitCommand("")).toEqual([]);
    expect(splitCommand("   ")).toEqual([]);
    expect(splitCommand("  node   dist/main.js  ")).toEqual(["node", "dist/main.js"]);
  });
});

describe("shortCommand", () => {
  it("shows the executable's basename and its arguments, paths as basenames", () => {
    expect(shortCommand("node /Users/amit/work/shop-api/node_modules/.bin/next dev").text).toBe(
      "node next dev",
    );
    expect(shortCommand("/Applications/Docker.app/Contents/MacOS/com.docker.backend").text).toBe(
      "com.docker.backend",
    );
    expect(shortCommand("/usr/sbin/mDNSResponder").text).toBe("mDNSResponder");
    expect(shortCommand("node dist/main.js").text).toBe("node main.js");
  });

  it("keeps a path with spaces whole", () => {
    expect(shortCommand(`${CHROME} --flag`).text).toBe("chrome_crashpad_handler --flag");
    expect(
      shortCommand('"/Applications/Visual Studio Code.app/Contents/MacOS/Electron" --inspect').text,
    ).toBe("Electron --inspect");
  });

  it("carries the full command line as the tooltip", () => {
    const { text, title } = shortCommand(`  ${CHROME} --flag  `);
    expect(text).toBe("chrome_crashpad_handler --flag");
    expect(title).toBe(`${CHROME} --flag`);
    expect(shortCommand("node dist/main.js").title).toBe("node dist/main.js");
  });

  it("shortens the value of a --key=path flag and leaves URLs alone", () => {
    expect(shortCommand("node --config=/etc/app/config.json server.js").text).toBe(
      "node --config=config.json server.js",
    );
    expect(shortCommand("curl http://localhost:3000/health").text).toBe("curl http://localhost:3000/health");
  });

  it("keeps flags and collapses whitespace", () => {
    expect(shortCommand("  node   dist/main.js --port=8080 ").text).toBe("node main.js --port=8080");
  });

  it("truncates at 60 by default, with an ellipsis", () => {
    expect(shortCommand("a".repeat(100), 20).text).toBe(`${"a".repeat(19)}…`);
    expect(shortCommand(`node ${"x".repeat(80)}`).text).toHaveLength(60);
    expect(shortCommand("")).toEqual({ text: "", title: "" });
  });
});

describe("executableDir", () => {
  it("prefers the exe the core reported", () => {
    expect(executableDir("/usr/sbin/mDNSResponder", "mDNSResponder")).toBe("/usr/sbin");
    expect(executableDir("/opt/homebrew/bin/node", "node server.js")).toBe("/opt/homebrew/bin");
  });

  it("falls back to the command's executable when exe is unknown", () => {
    expect(executableDir(null, "/Applications/Docker.app/Contents/MacOS/com.docker.backend")).toBe(
      "/Applications/Docker.app/Contents/MacOS",
    );
    expect(executableDir(null, `${CHROME} --flag`)).toBe(
      "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers",
    );
    expect(executableDir(null, "/sbin/launchd")).toBe("/sbin");
  });

  it("is empty when neither says where the executable lives", () => {
    expect(executableDir(null, "node server.js")).toBe("");
    expect(executableDir(null, "")).toBe("");
    expect(executableDir("", "")).toBe("");
  });
});

describe("formatPorts", () => {
  it("reads like a sentence", () => {
    expect(formatPorts([3000])).toBe("Port 3000");
    expect(formatPorts([5432, 6379])).toBe("Ports 5432 and 6379");
    expect(formatPorts([1, 2, 3])).toBe("Ports 1, 2 and 3");
    expect(formatPorts([])).toBe("");
  });
});

describe("formatTime", () => {
  it("is the local wall clock with seconds, zero-padded", () => {
    // Built in local time so the expectation holds in every zone.
    expect(formatTime(new Date(2026, 9, 15, 17, 52, 14).getTime())).toBe("17:52:14");
    expect(formatTime(new Date(2026, 0, 1, 0, 5, 9).getTime())).toBe("00:05:09");
    expect(formatTime(Number.NaN)).toBe("—");
  });
});

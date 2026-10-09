import { describe, expect, it } from "vitest";
import { formatBytes, formatPorts, formatUptime, shortCommand } from "./format";

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

describe("shortCommand", () => {
  it("collapses paths to their last segment", () => {
    expect(shortCommand("node /Users/amit/work/shop-api/node_modules/.bin/next dev")).toBe("node next dev");
    expect(shortCommand("/Applications/Docker.app/Contents/MacOS/com.docker.backend")).toBe(
      "com.docker.backend",
    );
    expect(shortCommand("/usr/sbin/mDNSResponder")).toBe("mDNSResponder");
  });

  it("keeps flags and collapses whitespace", () => {
    expect(shortCommand("  node   dist/main.js --port=8080 ")).toBe("node main.js --port=8080");
  });

  it("truncates with an ellipsis", () => {
    expect(shortCommand("a".repeat(100), 20)).toBe(`${"a".repeat(19)}…`);
    expect(shortCommand("")).toBe("");
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

/// <reference types="node" />
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bumpCask } from "../../scripts/bump-cask.mjs";

/**
 * packaging/homebrew/portreaper.rb is the template for Casks/portreaper.rb in the tap
 * (amitgal45/homebrew-tap). scripts/update-tap.sh, run by the release workflow, runs
 * scripts/bump-cask.mjs on it with the release's version and the SHA-256 of its notarized DMG, and
 * writes the result to the tap.
 * Pinned here: the template carries a real checksum and the URL of the DMG the release publishes,
 * and the script changes those two lines and nothing else.
 */

// Vitest runs from the project root; import.meta.url is rewritten under happy-dom, so anchor on cwd.
const root = process.cwd();
const template = readFileSync(resolve(root, "packaging/homebrew/portreaper.rb"), "utf8");

const sha = "a".repeat(64);

/** The lines of `text` whose first word (after the indentation) is `key`. */
function lines(text: string, key: string): string[] {
  return text.split("\n").filter((line) => line.trimStart().startsWith(`${key} `));
}

const versionLine = lines(template, "version")[0] ?? "";
const shaLine = lines(template, "sha256")[0] ?? "";

describe("the cask template", () => {
  it("has one version line and one sha256 line with a real checksum, not :no_check", () => {
    expect(lines(template, "version")).toHaveLength(1);
    expect(versionLine).toMatch(/^\s*version "\d+\.\d+\.\d+"$/);
    expect(lines(template, "sha256")).toHaveLength(1);
    expect(shaLine).toMatch(/^\s*sha256 "[0-9a-f]{64}"$/);
    expect(template).not.toContain(":no_check");
  });

  it("downloads the universal DMG the release publishes", () => {
    // `PortReaper_X.Y.Z_universal.dmg`: the artifact name in release.yml's tauri-action comment.
    const url =
      "https://github.com/amitgal45/portreaper/releases/download/v#{version}/PortReaper_#{version}_universal.dmg";
    expect(lines(template, "url").map((line) => line.trim())).toContain(`url "${url}"`);
  });
});

describe("bumpCask", () => {
  it("sets the version and the sha256 and changes no other line", () => {
    const before = template.split("\n");
    const after = bumpCask(template, "0.5.0", sha).split("\n");
    expect(after).toHaveLength(before.length);
    const changed = after.filter((line, i) => line !== before[i]);
    expect(changed).toEqual(['  version "0.5.0"', `  sha256 "${sha}"`]);
  });

  it("keeps each line's indentation and every other byte", () => {
    const text = 'cask "x" do\r\n\tversion "1.0.0"\n\n    sha256 :no_check\n  url "u"\nend';
    expect(bumpCask(text, "2.3.4", sha)).toBe(
      `cask "x" do\r\n\tversion "2.3.4"\n\n    sha256 "${sha}"\n  url "u"\nend`,
    );
  });

  it("accepts a template still on sha256 :no_check, the old form", () => {
    const old = template.replace(shaLine, "  sha256 :no_check");
    expect(old).toContain("sha256 :no_check");
    expect(bumpCask(old, "0.5.0", sha)).toBe(bumpCask(template, "0.5.0", sha));
  });

  it("refuses a version that is not a plain X.Y.Z", () => {
    for (const version of ["0.5", "v0.5.0", "0.5.0\n", ""]) {
      expect(() => bumpCask(template, version, sha)).toThrow(/^version must be X\.Y\.Z/);
    }
  });

  it("refuses a sha256 that is not 64 lowercase hex digits", () => {
    for (const bad of ["a".repeat(63), "A".repeat(64), "g".repeat(64), `${sha}\n`]) {
      expect(() => bumpCask(template, "0.5.0", bad)).toThrow(/^sha256 must be 64 lowercase hex digits/);
    }
  });

  it("refuses a template without exactly one version line", () => {
    const none = template.replace(`${versionLine}\n`, "");
    const two = template.replace(`${versionLine}\n`, `${versionLine}\n${versionLine}\n`);
    expect(none).not.toBe(template);
    expect(two).not.toBe(template);
    expect(() => bumpCask(none, "0.5.0", sha)).toThrow(/exactly one `version "X\.Y\.Z"` line, found 0/);
    expect(() => bumpCask(two, "0.5.0", sha)).toThrow(/exactly one `version "X\.Y\.Z"` line, found 2/);
  });

  it("refuses a template without a sha256 line", () => {
    const none = template.replace(`${shaLine}\n`, "");
    expect(none).not.toBe(template);
    expect(() => bumpCask(none, "0.5.0", sha)).toThrow(/exactly one `sha256 .*` line, found 0/);
  });
});

/** `node scripts/bump-cask.mjs <args>`, the way scripts/update-tap.sh runs it. */
function cli(...args: string[]) {
  // No inherited NODE_OPTIONS: a warning it caused would come before the script's own stderr.
  const env = { ...process.env, NODE_OPTIONS: "" };
  return spawnSync(process.execPath, ["scripts/bump-cask.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    env,
  });
}

describe("scripts/bump-cask.mjs on the command line", () => {
  it("prints the bumped cask and exits 0", () => {
    const run = cli("packaging/homebrew/portreaper.rb", "0.5.0", sha);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(bumpCask(template, "0.5.0", sha));
  });

  it("exits 2 with the usage on wrong arguments, and 1 with the reason on a refusal", () => {
    const usage = cli("packaging/homebrew/portreaper.rb", "0.5.0");
    expect(usage.status).toBe(2);
    expect(usage.stdout).toBe("");
    expect(usage.stderr).toMatch(/^usage: node scripts\/bump-cask\.mjs <template> <version> <sha256>/);
    const refused = cli("packaging/homebrew/portreaper.rb", "v0.5.0", sha);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toMatch(/^bump-cask: version must be X\.Y\.Z/);
  });
});

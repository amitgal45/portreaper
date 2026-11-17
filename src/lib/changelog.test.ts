/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The top section of CHANGELOG.md is the release body and the update dialog's notes. The dialog
 * shows the first 12 non-empty lines, at most 600 characters (`update::summarize`, called with
 * those limits in update.rs); anything longer is cut with "…". Pinned here: the section for the
 * current version fits, so a user who updates reads every item, and the details stay in the README.
 */

// Vitest runs from the project root; import.meta.url is rewritten under happy-dom, so anchor on cwd.
const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

/** The body of `## <version>` as the release workflow's awk takes it: up to the next `## `. */
function section(changelog: string, version: string): string {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  expect(start, `CHANGELOG.md has a ## ${version} section`).toBeGreaterThan(-1);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/** What the dialog keeps, the way update::summarize counts it. */
function dialogLines(notes: string): string[] {
  return notes
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "");
}

describe("the current version's CHANGELOG section", () => {
  const version = (JSON.parse(read("package.json")) as { version: string }).version;
  const lines = dialogLines(section(read("CHANGELOG.md"), version));

  it("fits the update dialog whole: at most 12 non-empty lines and 600 characters", () => {
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(12);
    expect([...lines.join("\n")].length).toBeLessThanOrEqual(600);
  });
});

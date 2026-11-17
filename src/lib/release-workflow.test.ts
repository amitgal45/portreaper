/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * No secret is read without the owner's approval: every secret lives in the `release` environment,
 * which waits for that approval, and every job that names a secret names that environment. A job
 * that reads a secret outside it would read a repository secret, which a workflow on any branch can.
 * Pinned here, by reading the workflow files as text: a new job, or a secret added to an existing
 * one, cannot slip past the environment unnoticed.
 */

// Vitest runs from the project root; import.meta.url is rewritten under happy-dom, so anchor on cwd.
const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

/** The `jobs:` map of a workflow, as `{ name: body }`, split on the two-space job keys. */
function jobs(workflow: string): Record<string, string> {
  const start = workflow.indexOf("\njobs:\n");
  expect(start).toBeGreaterThan(-1);
  const body = workflow.slice(start + "\njobs:\n".length);
  const out: Record<string, string> = {};
  let name: string | null = null;
  for (const line of body.split("\n")) {
    const key = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (key?.[1]) {
      name = key[1];
      out[name] = "";
    } else if (name !== null) {
      out[name] += `${line}\n`;
    }
  }
  return out;
}

/** The secrets a job names, `GITHUB_TOKEN` aside (the run's own token, not a stored secret). */
function secretsOf(job: string): string[] {
  const names = [...job.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1] ?? "");
  return [...new Set(names)].filter((n) => n !== "GITHUB_TOKEN").sort();
}

describe("the release workflow's secrets", () => {
  const release = jobs(read(".github/workflows/release.yml"));

  it("are read only in jobs of the release environment", () => {
    const readers = Object.entries(release).filter(([, job]) => secretsOf(job).length > 0);
    expect(readers.map(([name]) => name).sort()).toEqual(["release", "tap"]);
    for (const [name, job] of readers) {
      expect(job, name).toMatch(/^ {4}environment: release\s*$/m);
    }
  });

  it("run once per run: a tag runs `release`, a manual run runs `tap`, never both", () => {
    expect(release.release).toMatch(/^ {4}if: github\.event_name == 'push'\s*$/m);
    expect(release.tap).toMatch(/^ {4}if: github\.event_name == 'workflow_dispatch'\s*$/m);
  });

  it("are the ones the release needs, and TAP_TOKEN is checked before anything is built", () => {
    expect(secretsOf(release.release ?? "")).toEqual([
      "APPLE_CERTIFICATE",
      "APPLE_CERTIFICATE_PASSWORD",
      "APPLE_ID",
      "APPLE_PASSWORD",
      "APPLE_SIGNING_IDENTITY",
      "APPLE_TEAM_ID",
      "TAP_TOKEN",
      "TAURI_SIGNING_PRIVATE_KEY",
      "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    ]);
    expect(secretsOf(release.tap ?? "")).toEqual(["TAP_TOKEN"]);
    // The first step of `release` is the token check, before any action has run.
    const steps = (release.release ?? "").split(/^ {6}- /m).slice(1);
    expect(steps[0]).toMatch(/^name: The tap token must reach amitgal45\/homebrew-tap/);
    expect(steps[0]).toContain("secrets.TAP_TOKEN");
  });

  it("are never read by CI, which runs every pull request and every branch", () => {
    expect(read(".github/workflows/ci.yml")).not.toMatch(/secrets\./);
  });
});

/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * No secret is read outside main and `v*` tags: every secret lives in the `release` environment,
 * whose deployment rules admit only those refs, and every job that names a secret names it. A job
 * that reads a secret outside it would read a repository secret, which a workflow on any branch can.
 * Pinned here, by reading every workflow file as text: a new job, a new workflow, or a secret added
 * to an existing step cannot slip past the environment unnoticed. The settings are the guarantee;
 * this test keeps the workflows from undoing them.
 */

// Vitest runs from the project root; import.meta.url is rewritten under happy-dom, so anchor on cwd.
const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const workflowDir = ".github/workflows";
const workflows = readdirSync(resolve(root, workflowDir))
  .filter((f) => /\.ya?ml$/.test(f))
  .sort();

/** The lines that are not YAML comments. */
const code = (text: string) =>
  text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

/**
 * The `jobs:` map of a workflow, as `{ name: body }`. Every line indented by exactly two spaces
 * starts a job; one whose key is not a plain `name:` fails the test instead of being merged into
 * the job above it.
 */
function jobs(workflow: string): Record<string, string> {
  const start = workflow.indexOf("\njobs:\n");
  expect(start).toBeGreaterThan(-1);
  const body = workflow.slice(start + "\njobs:\n".length);
  const out: Record<string, string> = {};
  let name: string | null = null;
  for (const line of body.split("\n")) {
    if (/^ {2}\S/.test(line) && !/^ {2}#/.test(line)) {
      const key = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
      expect(key, `a job key the test cannot read: ${JSON.stringify(line)}`).not.toBeNull();
      name = key?.[1] ?? null;
      if (name) out[name] = "";
    } else if (/^\S/.test(line)) {
      name = null;
    } else if (name !== null) {
      out[name] += `${line}\n`;
    }
  }
  return out;
}

/** Any way a job can reach a stored secret: `secrets.X`, `secrets['X']`, `toJSON(secrets)`, `inherit`. */
const SECRET_ACCESS = /secrets\s*[.[]|toJSON\(\s*secrets|secrets:\s*inherit/i;

/** The secrets a job names, upper-cased, `GITHUB_TOKEN` aside (the run's own token). */
function secretsOf(job: string): string[] {
  const names = [
    ...code(job).matchAll(/secrets\s*(?:\.\s*([A-Za-z0-9_]+)|\[\s*['"]([A-Za-z0-9_]+)['"]\s*\])/gi),
  ].map((m) => (m[1] ?? m[2] ?? "").toUpperCase());
  return [...new Set(names)].filter((n) => n !== "GITHUB_TOKEN").sort();
}

/** The steps of a job, split on its `      - ` list items. */
const steps = (job: string) => job.split(/^ {6}- /m).slice(1);

describe("the workflows' secrets", () => {
  const release = jobs(read(`${workflowDir}/release.yml`));

  it("are named only by release.yml", () => {
    expect(workflows).toContain("release.yml");
    for (const file of workflows.filter((f) => f !== "release.yml")) {
      expect(code(read(`${workflowDir}/${file}`)), file).not.toMatch(SECRET_ACCESS);
    }
  });

  it("are read only by the two jobs of the release environment, and only those two are in it", () => {
    const readers = Object.entries(release).filter(([, job]) => SECRET_ACCESS.test(code(job)));
    expect(readers.map(([name]) => name).sort()).toEqual(["release", "tap"]);
    const inEnvironment = Object.entries(release).filter(([, job]) => /^ {4}environment:/m.test(code(job)));
    expect(inEnvironment.map(([name]) => name).sort()).toEqual(["release", "tap"]);
    for (const [name, job] of inEnvironment) {
      expect(code(job), name).toMatch(/^ {4}environment: release\s*$/m);
    }
  });

  it("run once per run: a tag runs `release`, a manual run runs `tap`, never both", () => {
    expect(code(release.release ?? "")).toMatch(/^ {4}if: github\.event_name == 'push'\s*$/m);
    expect(code(release.tap ?? "")).toMatch(/^ {4}if: github\.event_name == 'workflow_dispatch'\s*$/m);
  });

  it("are the ones the release needs, and TAP_TOKEN only in the first and the last step", () => {
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

    const releaseSteps = steps(release.release ?? "");
    expect(releaseSteps[0]).toMatch(/^name: The tap token must reach amitgal45\/homebrew-tap/);
    const tapStepsOfRelease = releaseSteps.flatMap((s, i) =>
      /secrets\.TAP_TOKEN/i.test(code(s)) ? [i] : [],
    );
    expect(tapStepsOfRelease).toEqual([0, releaseSteps.length - 1]);

    const tapSteps = steps(release.tap ?? "");
    const tapStepsOfTap = tapSteps.flatMap((s, i) => (/secrets\.TAP_TOKEN/i.test(code(s)) ? [i] : []));
    expect(tapStepsOfTap).toEqual([tapSteps.length - 1]);
  });

  it("catches a secret the parser would otherwise miss", () => {
    // The checks above must see these forms too. `$` is kept apart from `{{` so the strings are
    // not read as template placeholders.
    const $ = "$";
    for (const form of [
      `${$}{{ secrets.tap_token }}`,
      `${$}{{ secrets['TAP_TOKEN'] }}`,
      `${$}{{ toJSON(secrets) }}`,
      "secrets: inherit",
    ]) {
      expect(SECRET_ACCESS.test(form), form).toBe(true);
    }
    expect(secretsOf(`x: ${$}{{ secrets.tap_token }}\ny: ${$}{{ secrets['APPLE_ID'] }}\n`)).toEqual([
      "APPLE_ID",
      "TAP_TOKEN",
    ]);
    expect(() =>
      jobs("on: push\njobs:\n  ok:\n    runs-on: x\n  leak: # a comment\n    runs-on: x\n"),
    ).toThrow();
  });
});

/**
 * Releases in this repository are immutable: a published release can never gain, replace or lose
 * a file, and its tag name can never be used again. v0.5.0 was lost to publishing first and
 * uploading after. So tauri-action creates a draft, one step publishes it once the four files are
 * on it, and that step runs before the tap step, which downloads the DMG from the published
 * release. Returns what is wrong with a release job's order; empty when it is right.
 */
function draftThenPublish(job: string): string[] {
  const all = steps(job).map(code);
  const build = all.findIndex((s) => /uses: tauri-apps\/tauri-action@/.test(s));
  if (build < 0) return ["no tauri-action step"];
  const problems: string[] = [];
  if (!/^ {10}releaseDraft: true\s*$/m.test(all[build] ?? ""))
    problems.push("tauri-action does not create a draft");
  if (!/^id: build\s*$/m.test(all[build] ?? "")) problems.push("tauri-action has no `id: build`");
  const publish = all.findIndex((s) => /^name: Publish the draft once every file is on it\s*$/m.test(s));
  if (publish < 0) return [...problems, "no step publishes the draft"];
  const tap = all.findIndex((s) => /^name: Update the Homebrew tap\s*$/m.test(s));
  if (publish < build) problems.push("the draft is published before tauri-action creates it");
  if (tap < 0 || publish > tap) problems.push("the tap step does not run after the release is published");
  const step = all[publish] ?? "";
  if (!step.includes("steps.build.outputs.releaseId"))
    problems.push("the publish step does not use tauri-action's release id");
  if (!/-F draft=false/.test(step)) problems.push("the publish step does not publish");
  // `$` is kept apart from `{` so the name is not read as a template placeholder.
  const $ = "$";
  for (const file of [
    `PortReaper_${$}{version}_universal.dmg`,
    "PortReaper_universal.app.tar.gz ",
    "PortReaper_universal.app.tar.gz.sig",
    "latest.json",
  ]) {
    if (!step.includes(file)) problems.push(`the publish step does not check for ${file.trim()}`);
  }
  return problems;
}

describe("the release", () => {
  const job = jobs(read(`${workflowDir}/release.yml`)).release ?? "";

  it("is a draft until every file is on it, and published before the tap step reads it", () => {
    expect(draftThenPublish(job)).toEqual([]);
  });

  it("catches the order that lost v0.5.0, and the other ways to break it", () => {
    expect(draftThenPublish(job.replace("releaseDraft: true", "releaseDraft: false"))).toEqual([
      "tauri-action does not create a draft",
    ]);
    expect(
      draftThenPublish(job.replace("name: Publish the draft once every file is on it", "name: Publish")),
    ).toEqual(["no step publishes the draft"]);
    expect(
      draftThenPublish(job.replace("PortReaper_universal.app.tar.gz.sig latest.json", "latest.json")),
    ).toEqual(["the publish step does not check for PortReaper_universal.app.tar.gz.sig"]);

    // The publish step moved after the tap step, which would download from a draft.
    const [head, ...rest] = job.split(/^ {6}- /m);
    const at = rest.findIndex((s) => s.startsWith("name: Publish the draft"));
    expect(at).toBeGreaterThan(-1);
    const moved = [head, ...rest.slice(0, at), ...rest.slice(at + 1), rest[at]].join("      - ");
    expect(draftThenPublish(moved)).toEqual(["the tap step does not run after the release is published"]);
  });
});

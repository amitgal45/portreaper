/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The release recipe bumps three version fields in one commit (CLAUDE.md). The updater compares
 * `latest.json`'s version with the running app's, which is `tauri.conf.json`'s, and the release
 * workflow names the tag and the artifacts from it too, so a half-bumped release must not ship.
 * Also pinned here: what the updater needs to find and verify a release.
 */

// Vitest runs from the project root; import.meta.url is rewritten under happy-dom, so anchor on cwd.
const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const pkg = JSON.parse(read("package.json")) as { version: string };
const conf = JSON.parse(read("src-tauri/tauri.conf.json")) as {
  version: string;
  bundle: { createUpdaterArtifacts?: boolean; targets?: string[] };
  plugins?: { updater?: { endpoints?: string[]; pubkey?: string } };
};
/** Merged over tauri.conf.json by the release workflow only (`--config`). */
const releaseConf = JSON.parse(read("src-tauri/tauri.release.conf.json")) as {
  bundle?: { createUpdaterArtifacts?: boolean };
};
const cargo = read("src-tauri/Cargo.toml");

/** The `version = "…"` line of the `[package]` table, not a dependency's. */
function cargoVersion(manifest: string): string | null {
  // Tables start at a `[name]` line; split there and keep the one that is `[package]`.
  const table = manifest.split(/^\[/m).find((t) => t.startsWith("package]"));
  return table?.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? null;
}

describe("version parity", () => {
  it("package.json, tauri.conf.json and Cargo.toml carry one version", () => {
    expect(cargoVersion(cargo)).not.toBeNull();
    expect(conf.version).toBe(pkg.version);
    expect(cargoVersion(cargo)).toBe(pkg.version);
  });

  it("the version is a plain X.Y.Z, which the tag and the updater compare", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("reads the [package] table and not a dependency's version", () => {
    const manifest =
      '[package]\nname = "x"\nversion = "1.2.3"\n\n[dependencies]\nserde = { version = "1" }\n';
    expect(cargoVersion(manifest)).toBe("1.2.3");
    expect(cargoVersion('[dependencies]\nserde = { version = "1" }\n')).toBeNull();
  });
});

describe("updater configuration", () => {
  it("points at the GitHub release's latest.json and carries a public key", () => {
    const updater = conf.plugins?.updater;
    expect(updater?.endpoints).toEqual([
      "https://github.com/amitgal45/portreaper/releases/latest/download/latest.json",
    ]);
    // The base64 of `~/.tauri/portreaper.key.pub` (an "untrusted comment: minisign public key" file).
    expect(updater?.pubkey).toMatch(/^[A-Za-z0-9+/=]{100,}$/);
    expect(Buffer.from(updater?.pubkey ?? "", "base64").toString("utf8")).toMatch(
      /^untrusted comment: minisign public key: /,
    );
  });

  it("builds the signed updater artifact in the release job only, next to the app and the dmg", () => {
    // With it on, the Tauri CLI refuses to build without the private key; CI's unsigned build
    // (`pnpm tauri build --bundles app`, no key) must keep passing, so the base config leaves it off.
    expect(conf.bundle.createUpdaterArtifacts).toBeUndefined();
    expect(releaseConf.bundle?.createUpdaterArtifacts).toBe(true);
    expect(conf.bundle.targets).toEqual(["app", "dmg"]);
  });
});

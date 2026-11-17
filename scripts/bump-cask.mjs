// Sets the version and the DMG's SHA-256 in the Homebrew cask template. The release workflow's
// `cask` job runs it as
//
//   node scripts/bump-cask.mjs packaging/homebrew/portreaper.rb X.Y.Z <sha256> > portreaper.rb
//
// and its `tap` job writes the output to Casks/portreaper.rb in amitgal45/homebrew-tap. Only the `version` and
// `sha256` lines change; every other byte of the template is kept, so the cask is edited in the
// template and the tap only ever receives a copy of it.
//
// No dependencies: the job runs it with Node alone, without installing anything.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const VERSION = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;
// One line each. `[ \t]*` rather than `\s*` for the indentation: `\s` also matches a newline, so
// with `^` in multiline mode the match could start on a blank line above.
const VERSION_LINE = /^([ \t]*)version "[^"\n]*"$/gm;
// `:no_check` is the form the template had before it pinned a real checksum.
const SHA256_LINE = /^([ \t]*)sha256 (?::no_check|"[0-9a-f]{64}")$/gm;

/**
 * Returns the cask `text` with its `version` and `sha256` lines set to `version` and `sha256`,
 * each line keeping its indentation. Every other byte is unchanged.
 *
 * Throws when `version` is not a plain X.Y.Z, when `sha256` is not 64 lowercase hex digits, or
 * when the text has not exactly one `version "…"` line and exactly one `sha256` line.
 *
 * @param {string} text The cask template (packaging/homebrew/portreaper.rb).
 * @param {string} version The release version, X.Y.Z (the tag without its `v`).
 * @param {string} sha256 The SHA-256 of the release's DMG, 64 lowercase hex digits.
 * @returns {string} The cask for that release.
 */
export function bumpCask(text, version, sha256) {
  if (!VERSION.test(version)) {
    throw new Error(`version must be X.Y.Z (digits only, no "v"), got ${JSON.stringify(version)}`);
  }
  if (!SHA256.test(sha256)) {
    throw new Error(`sha256 must be 64 lowercase hex digits, got ${JSON.stringify(sha256)}`);
  }
  const versions = text.match(VERSION_LINE)?.length ?? 0;
  if (versions !== 1) {
    throw new Error(`the cask must have exactly one \`version "X.Y.Z"\` line, found ${versions}`);
  }
  const sums = text.match(SHA256_LINE)?.length ?? 0;
  if (sums !== 1) {
    throw new Error(
      `the cask must have exactly one \`sha256 "<64 hex>"\` or \`sha256 :no_check\` line, found ${sums}`,
    );
  }
  // Replacer functions, so nothing in the new values is read as a `$&`-style pattern.
  return text
    .replace(VERSION_LINE, (_line, indent) => `${indent}version "${version}"`)
    .replace(SHA256_LINE, (_line, indent) => `${indent}sha256 "${sha256}"`);
}

/** The command line: the new cask on stdout, 2 on wrong arguments, 1 on any error. */
function main(args) {
  if (args.length !== 3) {
    console.error("usage: node scripts/bump-cask.mjs <template> <version> <sha256>");
    return 2;
  }
  const [template, version, sha256] = args;
  try {
    process.stdout.write(bumpCask(readFileSync(template, "utf8"), version, sha256));
    return 0;
  } catch (error) {
    console.error(`bump-cask: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// Run only as `node scripts/bump-cask.mjs …`, not when a test imports bumpCask. `exitCode`
// rather than `process.exit()`, so stdout is flushed before Node exits.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}

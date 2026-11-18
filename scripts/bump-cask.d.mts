// Types for scripts/bump-cask.mjs. tsconfig.json has no `allowJs`, so without this file the
// import in src/lib/cask.test.ts is an implicit `any`, which `strict` refuses.

/** Returns the cask `text` with its `version` and `sha256` lines set; see scripts/bump-cask.mjs. */
export function bumpCask(text: string, version: string, sha256: string): string;

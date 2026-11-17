#!/usr/bin/env bash
# Writes Casks/portreaper.rb in amitgal45/homebrew-tap for one published release: the cask
# template (packaging/homebrew/portreaper.rb) with the release's version and the SHA-256 of the DMG
# the release published, through the GitHub Contents API (one commit, no clone, no credentials on
# disk). .github/workflows/release.yml runs it at the end of the `release` job (a tag push) and in
# the `tap` job (a manual run from main that backfills or retries one release).
#
#   TAG=vX.Y.Z RELEASE_TOKEN=<github.token> TAP_TOKEN=<secret> scripts/update-tap.sh
#
# RELEASE_TOKEN reads the release in this repository; TAP_TOKEN writes the tap and is handed to
# `gh` for the tap's calls only. The run stops at the first problem; a re-run with the same tag
# writes nothing when the tap already has this cask.
set -euo pipefail

: "${TAG:?TAG is not set}"
: "${RELEASE_TOKEN:?RELEASE_TOKEN is not set}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
if [ -z "${TAP_TOKEN:-}" ]; then
  echo "::error::the TAP_TOKEN secret is not set in the release environment. Store a fine-grained token for amitgal45/homebrew-tap with Contents: Read and write as the environment secret TAP_TOKEN, then run Release by hand from main with this tag." >&2
  exit 1
fi

re='^v[0-9]+\.[0-9]+\.[0-9]+$'
if ! [[ "$TAG" =~ $re ]]; then
  echo "::error::the tag must be vX.Y.Z, got $(printf '%q' "$TAG")" >&2
  exit 1
fi
version="${TAG#v}"
work="${RUNNER_TEMP:-$(mktemp -d)}/tap"
mkdir -p "$work/dmg"

# The cask's sha256 is the hash of what users download: the DMG asset the release published, not a
# rebuild. GitHub records its own SHA-256 of every uploaded asset (`digest`); when it has one, the
# two must agree, which catches a download corrupted on the way (an asset replaced on GitHub gets a
# new digest, so this does not catch that). Older assets may carry none.
name="PortReaper_${version}_universal.dmg"
GH_TOKEN="$RELEASE_TOKEN" gh release download "$TAG" --repo "$GITHUB_REPOSITORY" --pattern "$name" --dir "$work/dmg"
sha="$(shasum -a 256 "$work/dmg/$name" | cut -d' ' -f1)"
assets="$(GH_TOKEN="$RELEASE_TOKEN" gh api "repos/$GITHUB_REPOSITORY/releases/tags/$TAG" --jq '.assets[] | [.name, (.digest // "")] | @tsv')"
digest="$(printf '%s\n' "$assets" | awk -F'\t' -v n="$name" '$1 == n { print $2 }')"
case "$digest" in
  "" | null) echo "::notice::GitHub has no digest for $name; using the downloaded file's SHA-256 $sha unchecked" ;;
  "sha256:$sha") echo "$name: SHA-256 $sha, the same as GitHub's digest" ;;
  *)
    echo "::error::$name: the downloaded file's SHA-256 is $sha, but GitHub's digest is $digest" >&2
    exit 1
    ;;
esac

node scripts/bump-cask.mjs packaging/homebrew/portreaper.rb "$version" "$sha" > "$work/portreaper.rb"
# Never write a cask that is empty or lacks this release's pair, whatever the script did.
if ! grep -qxF "  version \"$version\"" "$work/portreaper.rb" || ! grep -qxF "  sha256 \"$sha\"" "$work/portreaper.rb"; then
  echo "::error::scripts/bump-cask.mjs did not produce a cask with version $version and sha256 $sha" >&2
  exit 1
fi
cat "$work/portreaper.rb"

api=repos/amitgal45/homebrew-tap/contents/Casks/portreaper.rb
# The current file's blob sha, which the API needs to replace it; none on the first write, which
# creates the file.
current=""
blob='^[0-9a-f]{40}$'
if found="$(GH_TOKEN="$TAP_TOKEN" gh api "$api" --jq .sha)" && [[ "$found" =~ $blob ]]; then
  current="$found"
  # The same cask already there (a re-run): stop rather than make an empty commit.
  GH_TOKEN="$TAP_TOKEN" gh api "$api" --jq .content | base64 --decode > "$work/tap-current.rb"
  if cmp -s "$work/tap-current.rb" "$work/portreaper.rb"; then
    echo "::notice::Casks/portreaper.rb in amitgal45/homebrew-tap is already the cask for $version; nothing to write"
    exit 0
  fi
else
  echo "No readable Casks/portreaper.rb in the tap; writing it as a new file."
fi
content="$(base64 < "$work/portreaper.rb" | tr -d '\n')"
args=(-X PUT "$api" -f message="portreaper $version" -f content="$content")
if [ -n "$current" ]; then
  args+=(-f sha="$current")
fi
GH_TOKEN="$TAP_TOKEN" gh api "${args[@]}" --jq .commit.html_url

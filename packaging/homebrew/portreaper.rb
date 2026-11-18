# The template for Casks/portreaper.rb in the tap (amitgal45/homebrew-tap). On every release,
# .github/workflows/release.yml runs scripts/update-tap.sh, which copies this file from
# amitgal45/portreaper, sets `version` and `sha256` to the release and the SHA-256 of its
# notarized DMG (scripts/bump-cask.mjs), and writes the result to the tap. The template keeps the
# last pair written into it by hand (0.4.0); the tap's copy is the one `brew` reads. Everything else changes in
# the template first: the next release overwrites the tap's copy.
cask "portreaper" do
  version "0.4.0"
  sha256 "598cc53160fb453e51988797c49546f8fde14dff2125e62f3c7a49f45d955765"

  url "https://github.com/amitgal45/portreaper/releases/download/v#{version}/PortReaper_#{version}_universal.dmg"
  name "PortReaper"
  desc "Kill listening ports and orphaned AI/MCP background processes in one click"
  homepage "https://github.com/amitgal45/portreaper"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  # The minimum, as a symbol: Homebrew 7 deprecates the `">= :monterey"` string form and warns
  # on every command that reads the cask.
  depends_on macos: :monterey

  app "PortReaper.app"

  zap trash: [
    "~/Library/Application Support/dev.amitgal.portreaper",
    "~/Library/Caches/dev.amitgal.portreaper",
    "~/Library/Preferences/dev.amitgal.portreaper.plist",
    "~/Library/Saved Application State/dev.amitgal.portreaper.savedState",
  ]
end

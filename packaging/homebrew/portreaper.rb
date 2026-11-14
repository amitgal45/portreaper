cask "portreaper" do
  version "0.4.0"
  sha256 :no_check # Updated automatically by the release workflow with the notarized DMG's SHA-256

  url "https://github.com/amitgal45/portreaper/releases/download/v#{version}/PortReaper_#{version}_universal.dmg"
  name "PortReaper"
  desc "Kill listening ports and orphaned AI/MCP background processes in one click"
  homepage "https://github.com/amitgal45/portreaper"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: ">= :monterey"

  app "PortReaper.app"

  zap trash: [
    "~/Library/Application Support/dev.amitgal.portreaper",
    "~/Library/Caches/dev.amitgal.portreaper",
    "~/Library/Preferences/dev.amitgal.portreaper.plist",
    "~/Library/Saved Application State/dev.amitgal.portreaper.savedState",
  ]
end

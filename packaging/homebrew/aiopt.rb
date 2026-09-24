# Source of `Casks/aiopt.rb` in the rushteam/homebrew-tap repository, so
# `brew install --cask rushteam/tap/aiopt` installs the macOS build from a GitHub Release.
#
# Bump `version` and `sha256` for every release (docs/dev-rules/development-workflow.md §6):
#   shasum -a 256 AiOpt-darwin-arm64-<version>.zip
#
# This cask belongs in our own tap only. The build is not signed with a Developer ID or
# notarized, so the postflight step clears the quarantine flag Homebrew puts on every cask
# download; otherwise Gatekeeper refuses the app as "damaged". Official homebrew/cask rejects a
# cask that bypasses Gatekeeper. Once the builds are signed and notarized, drop the postflight.
cask "aiopt" do
  version "1.0.0"
  sha256 "d1e956e2cd9b8fc39aa872b71e521389bf3fcba3ef14ccc8eb8796386c3ec6e3"

  url "https://github.com/rushteam/aiopt/releases/download/v#{version}/AiOpt-darwin-arm64-#{version}.zip"
  name "AiOpt"
  desc "Route AI coding agent CLIs to the model providers you choose"
  homepage "https://github.com/rushteam/aiopt"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on arch: :arm64
  depends_on macos: :monterey

  app "AiOpt.app"

  postflight_steps do
    run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{appdir}}/AiOpt.app"]
  end

  # Holds the encrypted provider keys. Agent config files AiOpt wrote are left alone; use
  # Restore default in the app first if you want them back.
  zap trash: [
    "~/Library/Application Support/AiOpt",
    "~/Library/Logs/AiOpt",
    "~/Library/Preferences/dev.aiopt.app.plist",
    "~/Library/Saved Application State/dev.aiopt.app.savedState",
  ]

  caveats <<~EOS
    AiOpt is not signed with an Apple Developer ID or notarized. This cask clears the
    macOS quarantine flag after installing, so Gatekeeper does not block the first launch.
  EOS
end

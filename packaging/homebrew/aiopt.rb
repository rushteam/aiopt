# AiOpt's Homebrew cask. The source is packaging/homebrew/aiopt.rb in rushteam/aiopt; the
# published copy is Casks/aiopt.rb in rushteam/homebrew-tap, which
# `brew install --cask rushteam/tap/aiopt` reads.
#
# Change the cask in rushteam/aiopt only. The tap's sync workflow copies it and fills in
# `version` and `sha256` from the latest published Release, so neither needs a hand bump
# (rushteam/aiopt, docs/dev-rules/development-workflow.md §6).
#
# This cask belongs in our own tap only. The build is not signed with a Developer ID or
# notarized, so the postflight step clears the quarantine flag Homebrew puts on every cask
# download; otherwise Gatekeeper refuses the app as "damaged". Official homebrew/cask rejects a
# cask that bypasses Gatekeeper. Once the builds are signed and notarized, drop the postflight.
cask "aiopt" do
  version "1.0.2"
  sha256 "8c34284d824b741c64063b7dce3bd41f03215cef4b4fd2bf27099e425ea88e48"

  url "https://github.com/rushteam/aiopt/releases/download/v#{version}/AiOpt-#{version}-arm64.dmg"
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

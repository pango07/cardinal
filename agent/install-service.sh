#!/usr/bin/env bash
# Installs cardinal-mac as a launchd user agent so it starts at login and restarts if it dies.
# Usage: mac/install-service.sh owner/repo [owner/repo ...]
#        mac/install-service.sh --uninstall
set -euo pipefail

label="com.cardinal.mac"
plist="$HOME/Library/LaunchAgents/$label.plist"
here="$(cd "$(dirname "$0")" && pwd)"
logdir="$HOME/Library/Logs/cardinal-mac"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$plist"
  echo "removed $label"
  exit 0
fi
[[ $# -ge 1 ]] || { echo "usage: $0 owner/repo [owner/repo ...] | --uninstall" >&2; exit 64; }

node_bin="$(command -v node)"
tart_bin="${CARDINAL_TART:-$(command -v tart || echo "$HOME/.local/bin/tart")}"
gh_token="${GITHUB_TOKEN:-$(gh auth token)}"
repos="$(IFS=,; echo "$*")"
mkdir -p "$logdir" "$(dirname "$plist")"

# launchd agents don't get your shell PATH or `gh` keychain access, so the token and paths go in the plist.
cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/caffeinate</string><string>-s</string>
    <string>$node_bin</string><string>$here/src/main.ts</string><string>run</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$node_bin"):/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>CARDINAL_TART</key><string>$tart_bin</string>
    <key>CARDINAL_MAC_REPOS</key><string>$repos</string>
    <key>GITHUB_TOKEN</key><string>$gh_token</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$logdir/agent.log</string>
  <key>StandardErrorPath</key><string>$logdir/agent.log</string>
</dict></plist>
PLIST
chmod 600 "$plist"   # it holds the token

launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "installed $label for $repos"
echo "logs: tail -f $logdir/agent.log"
echo "note: the token in the plist is a snapshot of 'gh auth token'; re-run this script if you re-login."

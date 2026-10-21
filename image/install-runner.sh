#!/usr/bin/env bash
# Installs actions/runner (linux-x64) into $HOME, verifying the tarball's SHA256.
# Usage: install-runner.sh [latest|<version>]   e.g. install-runner.sh 2.329.0
set -euo pipefail

version="${1:-latest}"
arch="linux-x64"
api="https://api.github.com/repos/actions/runner/releases"

if [[ "$version" == "latest" ]]; then
  release_json="$(curl -fsSL "$api/latest")"
else
  release_json="$(curl -fsSL "$api/tags/v${version#v}")"
fi

version="$(jq -r '.tag_name' <<<"$release_json")"
version="${version#v}"
asset="actions-runner-${arch}-${version}.tar.gz"
url="$(jq -r --arg n "$asset" '.assets[] | select(.name == $n) | .browser_download_url' <<<"$release_json")"
[[ -n "$url" && "$url" != "null" ]] || { echo "no asset $asset in release v$version" >&2; exit 1; }

# Release notes embed hashes as <!-- BEGIN SHA linux-x64 -->hex<!-- END SHA linux-x64 -->.
# Fall back to the asset's API digest ("sha256:hex") if the notes format ever changes.
expected="$(jq -r '.body' <<<"$release_json" \
  | sed -n "s/.*<!-- BEGIN SHA ${arch} -->\([0-9a-f]\{64\}\)<!-- END SHA ${arch} -->.*/\1/p" | head -n1)"
if [[ -z "$expected" ]]; then
  expected="$(jq -r --arg n "$asset" '.assets[] | select(.name == $n) | .digest // empty' <<<"$release_json")"
  expected="${expected#sha256:}"
fi
[[ "$expected" =~ ^[0-9a-f]{64}$ ]] || { echo "could not find SHA256 for $asset" >&2; exit 1; }

echo "installing actions/runner v$version ($asset)"
curl -fsSL -o "/tmp/$asset" "$url"
echo "$expected  /tmp/$asset" | sha256sum -c -
tar -xzf "/tmp/$asset" -C "$HOME"
rm "/tmp/$asset"
echo "$version" > "$HOME/.runner-version"

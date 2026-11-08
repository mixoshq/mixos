#!/bin/bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Builds MixOS Launcher.app, and a .dmg to hand to someone, from this Swift
# package: `swift build`, then the bundle around it. No Xcode project.
#
#   ./build.sh               this Mac's architecture
#   ./build.sh --universal   Apple silicon and Intel in one app
#
# Writes dist/MixOS Launcher.app and dist/MixOS-Launcher-<version>.dmg. The
# app is signed ad hoc only, so the first open is Control-click > Open; see
# README.md.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
APP="MixOS Launcher"
DIST="$HERE/dist"
BUNDLE="$DIST/$APP.app"

archs=()
if [[ "${1:-}" == "--universal" ]]; then
  archs=(--arch arm64 --arch x86_64)
elif [[ -n "${1:-}" ]]; then
  echo "Unknown option $1. Usage: ./build.sh [--universal]" >&2
  exit 1
fi

# The version and the Node floor come from package.json, so the app says what
# release it was built from and setup checks for the Node this MixOS needs.
version=$(sed -nE 's/^  "version": "([^"]+)".*/\1/p' "$REPO/package.json" | head -1)
node_major=$(sed -nE 's/.*"node": ">=([0-9]+)".*/\1/p' "$REPO/package.json" | head -1)
if [[ -z "$version" || -z "$node_major" ]]; then
  echo "Could not read version and engines.node from $REPO/package.json." >&2
  exit 1
fi

echo "Building ${APP} ${version}…"
swift build -c release --package-path "$HERE" "${archs[@]+"${archs[@]}"}"
bin_dir=$(swift build -c release --package-path "$HERE" "${archs[@]+"${archs[@]}"}" --show-bin-path)

rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"
cp "$bin_dir/MixOSLauncher" "$BUNDLE/Contents/MacOS/MixOSLauncher"
sed -e "s/__VERSION__/$version/g" -e "s/__NODE_MAJOR__/$node_major/g" "$HERE/Info.plist" \
  > "$BUNDLE/Contents/Info.plist"

# The icon and the in-app logo are MixOS's own mark, from public/logo.png:
# make-icon.swift draws it onto a macOS icon tile at every size, and the app
# shows the logo itself on its welcome screen, in setup and in the menu bar.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
iconset="$work/AppIcon.iconset"
swift "$HERE/make-icon.swift" "$REPO/public/logo.png" "$iconset"
iconutil -c icns "$iconset" -o "$BUNDLE/Contents/Resources/AppIcon.icns"
cp "$REPO/public/logo.png" "$BUNDLE/Contents/Resources/MixOSLogo.png"

# Ad hoc: enough for Apple silicon to run it, and for Gatekeeper to offer
# Control-click > Open. A Developer ID signature and notarization would make
# the first open an ordinary double-click; that needs an Apple account.
codesign --force --sign - "$BUNDLE"

stage="$work/dmg"
mkdir -p "$stage"
cp -R "$BUNDLE" "$stage/"
ln -s /Applications "$stage/Applications"
dmg="$DIST/MixOS-Launcher-$version.dmg"
rm -f "$dmg"
hdiutil create -volname "$APP" -srcfolder "$stage" -format UDZO -quiet "$dmg"

echo ""
echo "Built:"
echo "  $BUNDLE"
echo "  $dmg"
echo ""
echo "Open the .dmg and drag MixOS Launcher to Applications. The first time,"
echo "Control-click it and choose Open."

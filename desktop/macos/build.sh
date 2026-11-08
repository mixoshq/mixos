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
# Writes dist/MixOS Launcher.app and dist/MixOS-Launcher-<version>.dmg, an
# installer that opens on a drag-to-Applications window. The app is signed ad
# hoc only; see README.md for what that means on another Mac.

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

# Ad hoc: enough for Apple silicon to run it. It is not notarized — that
# needs a Developer ID from an Apple Developer account — so a copy downloaded
# onto another Mac is stopped the first time it opens, until it is allowed in
# System Settings > Privacy & Security. A copy built here opens at once.
codesign --force --sign - "$BUNDLE"

# ── The installer ───────────────────────────────────────────────────────────
#
# A .dmg that opens on one window: the app on the left, Applications on the
# right, and an arrow between them, over a background with the MixOS mark.
# dmgbuild writes that layout (dmg-settings.py); the background is drawn from
# public/logo.png (make-dmg-background.swift). Both get the same numbers from
# here — the window's size in points, and where Finder centres each icon — so
# the icons always sit at the ends of the arrow.
width=660
height=420
app_x=170
apps_x=490
icon_y=200

dmg="$DIST/MixOS-Launcher-$version.dmg"
rm -f "$dmg"

# dmgbuild needs Python 3.10 or later, and macOS's own python3 is older. uv
# brings a Python of its own; failing that, any python3 new enough gets a
# virtualenv here, kept between builds. Pinned, like everything else the
# build fetches.
DMGBUILD="dmgbuild==1.6.7"
dmgbuild=()
if command -v uv >/dev/null 2>&1; then
  dmgbuild=(uv tool run --quiet --from "$DMGBUILD" dmgbuild)
elif command -v python3 >/dev/null 2>&1 && python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then
  venv="$HERE/.build/dmgbuild-venv"
  if [[ ! -x "$venv/bin/dmgbuild" ]]; then
    python3 -m venv "$venv"
    "$venv/bin/pip" install --quiet "$DMGBUILD"
  fi
  dmgbuild=("$venv/bin/dmgbuild")
fi

if (( ${#dmgbuild[@]} )); then
  swift "$HERE/make-dmg-background.swift" "$REPO/public/logo.png" "$work/background" \
    "$width" "$height" "$app_x" "$apps_x" "$icon_y"
  "${dmgbuild[@]}" -s "$HERE/dmg-settings.py" \
    -D app="$BUNDLE" \
    -D volume_icon="$BUNDLE/Contents/Resources/AppIcon.icns" \
    -D background="$work/background/background.png" \
    -D width="$width" -D height="$height" \
    -D app_x="$app_x" -D apps_x="$apps_x" -D icon_y="$icon_y" \
    "$APP" "$dmg" >/dev/null
else
  # Still a working installer, without the window: the app and an
  # Applications link, in Finder's default layout.
  echo "Note: no uv and no Python 3.10+, so the .dmg has no installer window." >&2
  echo "      \`brew install uv\` and build again for the full one." >&2
  stage="$work/dmg"
  mkdir -p "$stage"
  cp -R "$BUNDLE" "$stage/"
  ln -s /Applications "$stage/Applications"
  hdiutil create -volname "$APP" -srcfolder "$stage" -format UDZO -quiet "$dmg"
fi

echo ""
echo "Built:"
echo "  $BUNDLE"
echo "  $dmg"
echo ""
echo "Open the .dmg and drag MixOS Launcher into Applications. On another Mac,"
echo "the first open is stopped because the app isn't notarized: allow it in"
echo "System Settings > Privacy & Security > Open Anyway."

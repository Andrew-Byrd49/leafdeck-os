#!/bin/bash
# Leafdeck OS runs on castlabs' build of Electron ("Electron for Content Security"), which adds Widevine, the DRM that
# Spotify, Netflix and other streaming sites require. Stock Electron has none, so those sites say the device can't play.
# The Windows app keeps stock Electron (package.json); this puts the castlabs build of the same version in
# os/electron-wv/, which os/leafdeck-session (development) and os/image/build.sh use when it's there.
# Run again after updating Electron. The Widevine module itself is downloaded by Electron on first start (main.cjs).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
DEST="$HERE/electron-wv"
VERSION=$(node -p "require('$REPO/node_modules/electron/package.json').version")
TAG="v$VERSION+wvcus"

if [ -f "$DEST/version" ] && [ "$(cat "$DEST/version")" = "$VERSION+wvcus" ]; then
  echo "castlabs Electron $TAG is already in $DEST"
  exit 0
fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
URL="https://github.com/castlabs/electron-releases/releases/download/v$VERSION%2Bwvcus/electron-v$VERSION%2Bwvcus-linux-x64.zip"
echo "Downloading castlabs Electron $TAG"
curl -fL --progress-bar -o "$TMP/electron.zip" "$URL" || {
  echo "No castlabs release $TAG yet (https://github.com/castlabs/electron-releases/releases)." >&2
  exit 1
}
mkdir "$TMP/out"
unzip -q "$TMP/electron.zip" -d "$TMP/out"
echo "$VERSION+wvcus" > "$TMP/out/version"
rm -rf "$DEST"
mv "$TMP/out" "$DEST"
echo "castlabs Electron $TAG is in $DEST"

#!/bin/sh
# Builds cage with Leafdeck OS's patches and installs it to /usr/local/bin, ahead of Fedora's /usr/bin/cage.
#
# touch-output.patch: each touchscreen covers its own screen, turned with it (the Yoga Book 9's top panel is mounted
# upside down). wlroots never passes on udev's WL_OUTPUT (os/70-leafdeck-touch.rules) for libinput devices, so stock
# cage spreads every touchscreen over the whole desktop, and it doesn't turn touches with a rotated screen.
#
# native-windows.patch: programs' real windows inside Leafdeck's own window frames, instead of full screen over Leafdeck
# (or, before, a VNC picture of them on the app display). Leafdeck connects to the control socket in
# LEAFDECK_COMPOSITOR (electron/compositor.cjs, public/js/nativewin.js); the protocol is at the top of leafdeck.c.
# Without Leafdeck connected, cage behaves as stock cage does. It also pins Leafdeck's windows to screens (`screen`,
# `mainscreen`: one surface per screen, electron/screens.cjs) and holds the pointer on the one a button was pressed on.
#
# The OS image builds the same in its Containerfile (the cage stage); os/setup-fedora.sh runs this.
# Needs: sudo dnf install meson ninja-build gcc wlroots-devel wayland-devel wayland-protocols-devel libxkbcommon-devel libinput-devel pixman-devel
# Takes effect at the next sign-in. The cage it replaces is kept as /usr/local/bin/cage.prev. Undo:
#   sudo mv /usr/local/bin/cage.prev /usr/local/bin/cage     (or sudo rm /usr/local/bin/cage for Fedora's)
set -e
VERSION=v0.3.1
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${XDG_CACHE_HOME:-$HOME/.cache}/leafdeck-cage

rm -rf "$WORK"
git clone -q --depth 1 --branch "$VERSION" https://github.com/cage-kiosk/cage.git "$WORK"
git -C "$WORK" apply "$HERE/touch-output.patch"
git -C "$WORK" apply "$HERE/native-windows.patch"
meson setup "$WORK/build" "$WORK" -Dman-pages=disabled --buildtype=release
ninja -C "$WORK/build"
"$WORK/build/cage" -v
[ -x /usr/local/bin/cage ] && sudo cp -p /usr/local/bin/cage /usr/local/bin/cage.prev
sudo install -m 755 "$WORK/build/cage" /usr/local/bin/cage
echo "Installed /usr/local/bin/cage. Sign out and back in to use it."

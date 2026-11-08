#!/usr/bin/env bash
# Build and try Leafdeck OS (os/ARCHITECTURE.md).
#
#   os/image/build.sh image             # the system image, as your user: localhost/leafdeck-os
#   os/image/build.sh disk              # a bootable disk from it (asks for sudo): os/image/out/leafdeck-os.raw
#   os/image/build.sh run [--headless]  # boot that disk in a virtual machine (QEMU with KVM)
#   os/image/build.sh update            # move the running VM to the newest image (and reboot it), no new disk
#
# A new disk starts at Leafdeck OS setup (your account and the computer's name), then the sign-in. Test disks also let
# root in over SSH with a key made here (out/dev-ssh-key, port 2222 on this computer), which is how `update` works:
# the image goes to a registry on this computer and the VM updates from it with bootc, the way real updates will.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
STAGE="$HERE/.build"
OUT="$HERE/out"
IMAGE=localhost/leafdeck-os
OS_VERSION=0.1
DISK="$OUT/leafdeck-os.raw"
KEY="$OUT/dev-ssh-key"
REGISTRY=127.0.0.1:5000 # on this computer; the VM reaches it as 10.0.2.2:5000
vm() { ssh -i "$KEY" -p 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5 root@127.0.0.1 "$@"; }
say() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }

image() {
  say "Leafdeck (Linux build)"
  # On castlabs' Electron, which has Widevine for streaming sites (os/electron-wv.sh); the Windows app keeps stock Electron.
  "$REPO/os/electron-wv.sh"
  (cd "$REPO" && npx electron-builder --linux dir -c.electronDist="$REPO/os/electron-wv" >/dev/null)

  say "Staging the image"
  rm -rf "$STAGE"
  mkdir -p "$STAGE"
  cp "$HERE/Containerfile" "$STAGE/"
  cp -a "$REPO/dist/linux-unpacked" "$STAGE/leafdeck"
  cp -a "$HERE/rootfs" "$STAGE/rootfs"
  mkdir -p "$STAGE/cage" && cp "$REPO"/os/cage/*.patch "$STAGE/cage/" # built into the image (the Containerfile's cage stage)
  local root="$STAGE/rootfs"
  install -D -m 755 "$REPO/os/leafdeck-session" "$root/usr/libexec/leafdeck/leafdeck-session"
  install -D -m 755 "$REPO/os/leafdeck-greeter" "$root/usr/libexec/leafdeck/leafdeck-greeter"
  install -D -m 644 "$REPO/os/logind-leafdeck.conf" "$root/usr/lib/systemd/logind.conf.d/50-leafdeck.conf"
  # Settings → Power's root helper, and the sudo rule that lets the computer's people (wheel) run it without a password.
  install -D -m 755 "$REPO/os/leafdeck-power" "$root/usr/libexec/leafdeck/leafdeck-power"
  install -d -m 750 "$root/etc/sudoers.d"
  echo '%wheel ALL=(root) NOPASSWD: /usr/libexec/leafdeck/leafdeck-power' > "$root/etc/sudoers.d/leafdeck-power"
  chmod 440 "$root/etc/sudoers.d/leafdeck-power"
  install -D -m 644 "$REPO/os/70-leafdeck-touch.rules" "$root/usr/lib/udev/rules.d/70-leafdeck-touch.rules"
  install -D -m 644 "$REPO/os/70-leafdeck-keys.rules" "$root/usr/lib/udev/rules.d/70-leafdeck-keys.rules"
  install -D -m 644 "$REPO/os/leafdeck-session.target" "$root/usr/lib/systemd/user/leafdeck-session.target"
  install -D -m 644 "$REPO/os/leafdeck-tmpfiles.conf" "$root/usr/lib/tmpfiles.d/leafdeck.conf"
  install -D -m 644 "$REPO/os/leafdeckd.service" "$root/usr/lib/systemd/user/leafdeckd.service"
  # Leafdeck is the web browser for every other program (sign-in links from gh, claude, xdg-open…).
  install -D -m 755 "$REPO/os/leafdeck-open" "$root/usr/bin/leafdeck-open"
  install -D -m 644 "$REPO/os/leafdeck-open.desktop" "$root/usr/share/applications/leafdeck-open.desktop"
  install -D -m 644 "$REPO/os/leafdeck-mimeapps.list" "$root/etc/xdg/mimeapps.list"
  install -D -m 644 "$REPO/os/leafdeck-browser.conf" "$root/usr/lib/environment.d/60-leafdeck-browser.conf"
  install -D -m 644 "$REPO/os/leafdeck.portal" "$root/usr/share/xdg-desktop-portal/portals/leafdeck.portal"
  install -D -m 644 "$REPO/os/leafdeck-portals.conf" "$root/usr/share/xdg-desktop-portal/leafdeck-portals.conf"
  # Boot screen: the theme, and the logo drawn from the SVG.
  local theme="$root/usr/share/plymouth/themes/leafdeck"
  install -D -m 644 "$REPO/os/plymouth/leafdeck/leafdeck.plymouth" "$theme/leafdeck.plymouth"
  (cd "$REPO" && node -e "require('sharp')('public/img/leafdeck-os-logo.svg', { density: 220 }).resize({ width: 300 }).png().toFile(process.argv[1])" "$theme/watermark.png")
  # Identity: Leafdeck OS, derived from Fedora. VERSION_ID stays Fedora's, since package tools read it ($releasever);
  # Leafdeck's own version is IMAGE_VERSION.
  local base
  base=$(sed -n 's/^FROM .*:\([0-9][0-9]*\)$/\1/p' "$HERE/Containerfile")
  cat > "$root/usr/lib/os-release" <<EOF
NAME="Leafdeck OS"
VERSION="$OS_VERSION (Fedora $base base)"
ID=leafdeck
ID_LIKE=fedora
VERSION_ID=$base
PRETTY_NAME="Leafdeck OS $OS_VERSION"
ANSI_COLOR="0;38;2;52;199;123"
LOGO=leafdeck
IMAGE_ID=leafdeck-os
IMAGE_VERSION=$OS_VERSION.$(date +%Y%m%d.%H%M)
DEFAULT_HOSTNAME=leafdeck
EOF

  say "Building $IMAGE"
  podman build --pull=newer --label "org.opencontainers.image.version=$(sed -n "s/^IMAGE_VERSION=//p" "$root/usr/lib/os-release")" -t "$IMAGE" "$STAGE"
  echo "  built $(podman image inspect "$IMAGE" --format '{{.Id}}' | cut -c1-12)"
}

disk() {
  podman image exists "$IMAGE" || { echo "Build the image first: $0 image"; exit 1; }
  mkdir -p "$OUT"
  [ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -C leafdeck-os-test -f "$KEY"
  say "Copying the image to root's container storage (bootc installs as root)"
  podman save "$IMAGE" | sudo podman load
  say "Installing it to $DISK"
  rm -f "$DISK"
  truncate -s 24G "$DISK"
  sudo podman run --rm --privileged --pid=host --security-opt label=type:unconfined_t \
    -v /var/lib/containers:/var/lib/containers -v /dev:/dev -v "$OUT:/output" \
    "$IMAGE" bootc install to-disk --generic-image --via-loopback --filesystem xfs --wipe \
      --root-ssh-authorized-keys /output/dev-ssh-key.pub /output/leafdeck-os.raw
  sudo chown "$(id -u):$(id -g)" "$DISK"
  rm -f "$OUT/OVMF_VARS.fd"
  echo "  $DISK"
}

run() {
  [ -f "$DISK" ] || { echo "Make the disk first: $0 disk"; exit 1; }
  [ -f "$OUT/OVMF_VARS.fd" ] || cp /usr/share/edk2/ovmf/OVMF_VARS.fd "$OUT/OVMF_VARS.fd"
  local display=(-display gtk)
  # Headless: no window; a QMP socket for screenshots (screendump) and the console in serial.log.
  if [ "${1:-}" = "--headless" ]; then
    display=(-display none -qmp "unix:$OUT/qmp.sock,server,nowait" -serial "file:$OUT/serial.log")
  fi
  say "Booting Leafdeck OS (QEMU)"
  exec qemu-system-x86_64 -enable-kvm -machine q35 -cpu host -smp 4 -m 4096 \
    -drive if=pflash,format=raw,readonly=on,file=/usr/share/edk2/ovmf/OVMF_CODE.fd \
    -drive if=pflash,format=raw,file="$OUT/OVMF_VARS.fd" \
    -drive file="$DISK",format=raw,if=virtio \
    -device virtio-vga -device qemu-xhci -device usb-tablet -device usb-kbd \
    -netdev user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22 -device virtio-net-pci,netdev=net0 \
    "${display[@]}"
}

update() {
  podman image exists "$IMAGE" || { echo "Build the image first: $0 image"; exit 1; }
  vm true || { echo "The VM isn't reachable (start it with $0 run, from a disk made by $0 disk)"; exit 1; }
  say "Publishing the image to the test registry ($REGISTRY)"
  podman container exists leafdeck-registry || podman run -d --name leafdeck-registry -p "$REGISTRY:5000" docker.io/library/registry:2 >/dev/null
  podman start leafdeck-registry >/dev/null
  podman push -q --tls-verify=false "$IMAGE" "$REGISTRY/leafdeck-os:latest"
  say "Updating the VM"
  vm 'set -e
    mkdir -p /etc/containers/registries.conf.d
    printf "[[registry]]\nlocation = \"10.0.2.2:5000\"\ninsecure = true\n" > /etc/containers/registries.conf.d/50-leafdeck-test.conf
    if bootc status --format=json | grep -q "10.0.2.2:5000/leafdeck-os"; then bootc upgrade --quiet; else bootc switch --quiet 10.0.2.2:5000/leafdeck-os:latest; fi
    bootc status | sed -n "1,12p"
    systemctl reboot' || true
  echo "  the VM is restarting into the new image"
}

case "${1:-}" in
  image) image ;;
  update) update ;;
  disk) disk ;;
  run) shift; run "$@" ;;
  *) sed -n '2,8p' "$0"; exit 1 ;;
esac

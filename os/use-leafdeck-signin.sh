#!/usr/bin/env bash
# Give a Fedora Workstation install (the development setup, os/README.md) Leafdeck OS's own startup: Leafdeck's boot
# screen instead of Fedora's, and Leafdeck's sign-in screen (greetd + electron/greeter.cjs) instead of GNOME's (GDM). The
# Leafdeck OS image has both built in; this brings the same pieces to a machine that isn't running the image yet.
#
#   os/use-leafdeck-signin.sh          # switch (takes effect at the next restart); run again to update the sign-in screen
#   os/use-leafdeck-signin.sh --undo   # back to GNOME's login screen and Fedora's boot screen
#
# GNOME stays installed. If Leafdeck's sign-in screen ever can't start, a text sign-in takes over (os/leafdeck-greeter);
# from there, `sudo os/use-leafdeck-signin.sh --undo` and a restart bring GNOME's back.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
say() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
[ "$(id -u)" -ne 0 ] || { echo "Run this as your own user (it asks for sudo when needed)."; exit 1; }

if [ "${1:-}" = "--undo" ]; then
  say "Back to GNOME's login screen"
  sudo systemctl disable greetd.service 2>/dev/null || true
  sudo systemctl enable --force gdm.service
  sudo sed -i '/leafdeck-pin/d' /etc/pam.d/greetd 2>/dev/null || true
  say "Back to Fedora's boot screen (rebuilds the startup image, about a minute)"
  sudo plymouth-set-default-theme -R bgrt
  echo "  done; restart to see it"
  exit 0
fi

say "Leafdeck for the sign-in screen (a packaged build in /usr/lib/leafdeck)"
# The sign-in screen runs as the greetd system account, which can't read your home folder, so it gets its own copy.
(cd "$REPO" && npx electron-builder --linux dir >/dev/null)
sudo rm -rf /usr/lib/leafdeck.new
sudo cp -a "$REPO/dist/linux-unpacked" /usr/lib/leafdeck.new
sudo chown -R root:root /usr/lib/leafdeck.new
sudo rm -rf /usr/lib/leafdeck && sudo mv /usr/lib/leafdeck.new /usr/lib/leafdeck
sudo restorecon -R /usr/lib/leafdeck 2>/dev/null || true
echo "  $(du -sh /usr/lib/leafdeck | cut -f1)"

say "greetd (the login daemon) and Leafdeck's sign-in"
sudo dnf install -y -q greetd greetd-selinux
sudo install -D -m 755 "$REPO/os/leafdeck-greeter" /usr/libexec/leafdeck/leafdeck-greeter
sudo install -D -m 755 "$REPO/os/leafdeck-session" /usr/libexec/leafdeck/leafdeck-session
sudo install -D -m 644 "$REPO/os/leafdeck-session.target" /etc/systemd/user/leafdeck-session.target
# The session leaves a note in /run/leafdeck/failed when Leafdeck kept crashing; the sign-in screen then offers safe mode.
sudo install -D -m 644 "$REPO/os/leafdeck-tmpfiles.conf" /etc/tmpfiles.d/leafdeck.conf
sudo systemd-tmpfiles --create /etc/tmpfiles.d/leafdeck.conf
sudo install -D -m 644 "$REPO/os/image/rootfs/etc/greetd/config.toml" /etc/greetd/config.toml
sudo restorecon -R /usr/libexec/leafdeck /etc/greetd 2>/dev/null || true
echo "  installed"

say "Sign-in PIN (os/leafdeck-pin)"
# The helper keeps each account's PIN (hashed) in /var/lib/leafdeck-pin. greetd's PAM stack asks it first: a right PIN
# signs in, anything else goes on to the password check. Leafdeck's lock screen and Settings reach it through a sudo
# rule that allows only its own commands (not `pam`). The folder is labeled for the login daemon, which SELinux confines.
sudo install -m 755 -o root -g root "$REPO/os/leafdeck-pin" /usr/local/sbin/leafdeck-pin
sudo install -d -m 711 -o root -g root /var/lib/leafdeck-pin
sudo semanage fcontext -a -t xdm_var_lib_t '/var/lib/leafdeck-pin(/.*)?' 2>/dev/null \
  || sudo semanage fcontext -m -t xdm_var_lib_t '/var/lib/leafdeck-pin(/.*)?'
sudo restorecon -R /var/lib/leafdeck-pin /usr/local/sbin/leafdeck-pin
rule=$(mktemp)
h=/usr/local/sbin/leafdeck-pin
echo "$(id -un) ALL=(root) NOPASSWD: $h status, $h check, $h set, $h remove, $h reset" > "$rule"
if sudo visudo -cqf "$rule"; then
  sudo install -m 440 -o root -g root "$rule" /etc/sudoers.d/leafdeck-pin
else
  echo "  couldn't install the sudo rule for the PIN" >&2
fi
rm -f "$rule"
pam=/etc/pam.d/greetd
sudo sed -i '/leafdeck-pin/d' "$pam"
sudo sed -i '0,/^auth/s//auth       [success=done default=ignore] pam_exec.so quiet expose_authtok \/usr\/local\/sbin\/leafdeck-pin pam\n&/' "$pam"
sudo sed -i '/^account[[:space:]]\+include[[:space:]]\+system-auth/a account    optional    pam_exec.so quiet /usr/local/sbin/leafdeck-pin pam' "$pam"
grep -c leafdeck-pin "$pam" | grep -qx 2 && echo "  installed; set a PIN in Settings → Leafdeck OS" || echo "  couldn't add the PIN to $pam" >&2

say "Leafdeck's boot screen (rebuilds the startup image, about a minute)"
theme=/usr/share/plymouth/themes/leafdeck
tmp=$(mktemp -d)
(cd "$REPO" && node -e "require('sharp')('public/img/leafdeck-os-logo.svg', { density: 220 }).resize({ width: 300 }).png().toFile(process.argv[1])" "$tmp/watermark.png")
sudo install -D -m 644 "$REPO/os/plymouth/leafdeck/leafdeck.plymouth" "$theme/leafdeck.plymouth"
sudo install -m 644 "$tmp/watermark.png" "$theme/watermark.png"
rm -rf "$tmp"
(cd /usr/share/plymouth/themes/spinner && sudo cp animation-*.png throbber-*.png bullet.png entry.png lock.png capslock.png keyboard.png keymap-render.png "$theme/")
sudo plymouth-set-default-theme -R leafdeck
echo "  $(plymouth-set-default-theme)"

say "Leafdeck's sign-in replaces GNOME's (from the next restart)"
sudo systemctl disable gdm.service 2>/dev/null || true
sudo systemctl enable --force greetd.service
echo "  login manager: $(basename "$(readlink /etc/systemd/system/display-manager.service)")"

cat <<DONE

Restart to see it: Leafdeck's boot screen, then Leafdeck's sign-in.
  - Run this again after changing the sign-in screen (electron/greeter.cjs, public/lock.html) to update its copy.
  - To go back: os/use-leafdeck-signin.sh --undo, then restart.
DONE

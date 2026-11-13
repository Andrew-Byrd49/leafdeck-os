#!/usr/bin/env bash
# Turn a fresh Fedora Workstation install into Leafdeck OS (see os/README.md).
#
#   os/setup-fedora.sh              # run from a checkout of the repository, wherever it is
#   os/setup-fedora.sh --local      # also run a local Leafdeck server (development)
#   os/setup-fedora.sh --uninstall  # take Leafdeck OS off again: back to GNOME, as Fedora was
#
# Safe to run again: each step checks what's already done. GNOME stays installed, so the login screen can still start a
# GNOME session if Leafdeck ever won't. Nothing here touches Windows or other partitions.
# Leafdeck runs from this checkout, so keep the folder where it is (or run this again after moving it).
set -euo pipefail

LOCAL_SERVER=0
UNINSTALL=0
for a in "$@"; do
  case "$a" in
    --local) LOCAL_SERVER=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "Unknown option $a (try --help)"; exit 1 ;;
  esac
done

REPO="$(cd "$(dirname "$0")/.." && pwd)"
say() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }

[ "$(id -u)" -ne 0 ] || { echo "Run this as your own user, not root (it asks for sudo when needed)."; exit 1; }
grep -q '^ID=fedora' /etc/os-release || { echo "This script is for Fedora."; exit 1; }
[ -f "$REPO/os/leafdeck-session" ] || { echo "Run it from a Leafdeck checkout (os/setup-fedora.sh)."; exit 1; }

# Everything the setup below puts on the computer, taken off again. What stays: the packages it installed (cage and the
# rest are small and harmless), Node.js in ~/.local, Claude Code, this folder, and Leafdeck's own data (~/.config/Leafdeck).
uninstall() {
  user=$(id -un)
  if systemctl is-enabled greetd.service >/dev/null 2>&1; then
    say "Leafdeck's sign-in and boot screens"
    "$REPO/os/use-leafdeck-signin.sh" --undo
  fi

  say "GNOME as the session at the login screen"
  if sudo test -f "/var/lib/AccountsService/users/$user"; then
    sudo sed -i -e '/^Session=leafdeck$/d' -e '/^XSession=leafdeck$/d' "/var/lib/AccountsService/users/$user"
  fi
  echo "  done"

  say "The Leafdeck session and its services"
  systemctl --user disable --now leafdeck-dev-server.service >/dev/null 2>&1 || true
  rm -f "$HOME/.config/systemd/user/leafdeck-dev-server.service" "$HOME/.config/systemd/user/leafdeckd.service" "$HOME/.config/leafdeck-session.env"
  sudo rm -f /usr/local/bin/leafdeck-session /usr/share/wayland-sessions/leafdeck.desktop /etc/tmpfiles.d/leafdeck.conf \
    /etc/systemd/user/leafdeck-session.target /etc/systemd/user/app-leafdeck-.scope.d/50-leafdeck.conf \
    /etc/systemd/system/session-.scope.d/50-leafdeck.conf /etc/security/limits.d/30-leafdeck.conf \
    /usr/local/bin/cage /usr/local/bin/cage.prev
  sudo rmdir /etc/systemd/user/app-leafdeck-.scope.d /etc/systemd/system/session-.scope.d 2>/dev/null || true
  echo "  removed (Fedora's own cage is still installed)"

  say "Links and pictures back to Fedora's programs"
  # Only our own copy of the system-wide list: one that's been changed since is someone else's to keep.
  if [ -f /etc/xdg/mimeapps.list ] && grep -q 'leafdeck-open' /etc/xdg/mimeapps.list; then sudo rm -f /etc/xdg/mimeapps.list; fi
  [ -f "$HOME/.config/mimeapps.list" ] && sed -i '/=leafdeck-open\.desktop;\?$/d' "$HOME/.config/mimeapps.list"
  sudo rm -f /usr/local/bin/leafdeck-open /usr/local/share/applications/leafdeck-open.desktop /etc/environment.d/60-leafdeck-browser.conf \
    /usr/share/xdg-desktop-portal/portals/leafdeck.portal /usr/share/xdg-desktop-portal/leafdeck-portals.conf
  sudo update-desktop-database -q /usr/local/share/applications 2>/dev/null || true
  echo "  done"

  say "Power, touchscreen and Restart into Windows helpers"
  sudo rm -f /usr/local/sbin/leafdeck-boot-windows /etc/sudoers.d/leafdeck-boot-windows /usr/local/sbin/leafdeck-power /etc/sudoers.d/leafdeck-power \
    /etc/systemd/logind.conf.d/50-leafdeck.conf /etc/udev/rules.d/70-leafdeck-touch.rules /etc/udev/rules.d/70-leafdeck-keys.rules
  sudo systemctl kill -s HUP systemd-logind
  sudo udevadm control --reload
  if [ -f /etc/tuned/ppd.conf ]; then
    sudo sed -i 's/^performance=leafdeck-performance$/performance=throughput-performance/' /etc/tuned/ppd.conf
    sudo systemctl try-restart tuned tuned-ppd >/dev/null 2>&1 || true
  fi
  sudo rm -rf /etc/tuned/profiles/leafdeck-performance
  sudo systemctl daemon-reload
  systemctl --user daemon-reload 2>/dev/null || true
  echo "  removed"

  say "Done"
  cat <<DONE
Restart the computer: it starts into GNOME, as Fedora did before.
  - Still here, yours to keep or delete: this folder ($REPO), Leafdeck's data (~/.config/Leafdeck),
    Node.js (~/.local) and Claude Code.
  - To put Leafdeck OS back: $REPO/os/setup-fedora.sh
DONE
}
if [ "$UNINSTALL" = 1 ]; then uninstall; exit 0; fi

say "System packages (cage, wayvnc and Xwayland for the app display, wlr-randr, brightnessctl, grim, GitHub CLI, whisper.cpp bindings for talking to Claude)"
sudo dnf install -y -q cage wayvnc xorg-x11-server-Xwayland wlr-randr brightnessctl grim git gh python3 efibootmgr bluez python3-pywhispercpp
echo "  installed"

say "Leafdeck's cage (touch per screen, programs' real windows in Leafdeck frames: os/cage/build.sh)"
sudo dnf install -y -q meson ninja-build gcc wlroots-devel wayland-devel wayland-protocols-devel libxkbcommon-devel libinput-devel pixman-devel
sh "$REPO/os/cage/build.sh" >/dev/null && echo "  /usr/local/bin/cage"

say "Node.js 24 (in ~/.local, no root needed)"
mkdir -p "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"
if ! node -v 2>/dev/null | grep -q '^v24'; then
  tarball=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/ | grep -o 'node-v24[0-9.]*-linux-x64.tar.xz' | head -1)
  curl -fsSL "https://nodejs.org/dist/latest-v24.x/$tarball" -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C "$HOME/.local" --strip-components=1
  rm -f /tmp/node.tar.xz
fi
grep -q '.local/bin' "$HOME/.bashrc" || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
echo "  node $(node -v)"

say "Claude Code"
if ! command -v claude >/dev/null; then curl -fsSL https://claude.ai/install.sh | bash >/dev/null; fi
echo "  $(claude --version 2>/dev/null || echo 'installed; open a new terminal to use it')"

say "Leafdeck's dependencies (npm)"
cd "$REPO"
npm install --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund
# npm may skip Electron's download step; fetch the binary if it's missing.
[ -x node_modules/electron/dist/electron ] || node node_modules/electron/install.js
echo "  electron $(node_modules/electron/dist/electron --version 2>/dev/null)"

say "The Leafdeck session"
sudo install -m 755 "$REPO/os/leafdeck-session" /usr/local/bin/leafdeck-session
sudo install -m 644 "$REPO/os/leafdeck.desktop" /usr/share/wayland-sessions/leafdeck.desktop
# /run/leafdeck/failed: the session's note that Leafdeck kept crashing, for the sign-in screen's safe mode offer.
sudo install -D -m 644 "$REPO/os/leafdeck-tmpfiles.conf" /etc/tmpfiles.d/leafdeck.conf
sudo systemd-tmpfiles --create /etc/tmpfiles.d/leafdeck.conf
sudo install -D -m 644 "$REPO/os/leafdeck-session.target" /etc/systemd/user/leafdeck-session.target
# leafdeckd from this checkout, on the Node installed above (the image runs it from the packaged app).
mkdir -p "$HOME/.config/systemd/user"
sed -e "s|^ExecStart=.*|ExecStart=$HOME/.local/bin/node $REPO/electron/leafdeckd.cjs|" "$REPO/os/leafdeckd.service" > "$HOME/.config/systemd/user/leafdeckd.service"
systemctl --user daemon-reload
mkdir -p "$HOME/.config"
ENV="$HOME/.config/leafdeck-session.env"
{
  echo "# Leafdeck OS session settings (os/README.md). Edit, then sign out and back in."
  echo "LEAFDECK_DEV_TREE=$REPO"
  [ "$LOCAL_SERVER" = 1 ] && echo "LEAFDECK_URL=http://localhost:8787"
  if [ "$(systemd-detect-virt 2>/dev/null)" = oracle ]; then
    echo 'LEAFDECK_EXTRA_FLAGS="--disable-gpu --remote-debugging-port=9333"'  # VM only: no GPU device; debugging port for development
    echo "LEAFDECK_SCREEN_MODE=1440x900"
  fi
} > "$ENV"
echo "  session installed; settings in $ENV"

say "Leafdeck as the web browser and image viewer"
# Every program's links (sign-in pages from gh, claude, xdg-open…) open in Leafdeck, never in Firefox, and pictures in
# Image Viewer: system-wide, for this user (over anything another app set), and in $BROWSER. Replaces the per-user
# copies of an earlier setup.
sudo install -m 755 "$REPO/os/leafdeck-open" /usr/local/bin/leafdeck-open
sudo install -D -m 644 "$REPO/os/leafdeck-open.desktop" /usr/local/share/applications/leafdeck-open.desktop
sudo update-desktop-database -q /usr/local/share/applications 2>/dev/null || true
sudo install -D -m 644 "$REPO/os/leafdeck-mimeapps.list" /etc/xdg/mimeapps.list
sudo install -D -m 644 "$REPO/os/leafdeck-browser.conf" /etc/environment.d/60-leafdeck-browser.conf
# Leafdeck's desktop portal backend: the file picker and permission questions every program gets.
sudo install -D -m 644 "$REPO/os/leafdeck.portal" /usr/share/xdg-desktop-portal/portals/leafdeck.portal
sudo install -D -m 644 "$REPO/os/leafdeck-portals.conf" /usr/share/xdg-desktop-portal/leafdeck-portals.conf
systemctl --user try-restart xdg-desktop-portal.service 2>/dev/null || true
rm -f "$HOME/.local/bin/leafdeck-open" "$HOME/.local/share/applications/leafdeck-open.desktop" "$HOME/.config/leafdeck-mimeapps.list"
xdg-mime default leafdeck-open.desktop $(sed -n 's/=leafdeck-open.desktop$//p' "$REPO/os/leafdeck-mimeapps.list")
echo "  links and pictures open in Leafdeck"

say "Restart into Windows (dual boot)"
# A small root helper sets the firmware's one-time boot choice; this sudo rule lets Leafdeck run it (and only it)
# without a password. Leafdeck shows the button only when Windows is actually a startup choice.
sudo install -m 755 -o root -g root "$REPO/os/leafdeck-boot-windows" /usr/local/sbin/leafdeck-boot-windows
rule=$(mktemp)
echo "$(id -un) ALL=(root) NOPASSWD: /usr/local/sbin/leafdeck-boot-windows" > "$rule"
if sudo visudo -cqf "$rule"; then
  sudo install -m 440 -o root -g root "$rule" /etc/sudoers.d/leafdeck-boot-windows
else
  warn "Couldn't install the sudo rule for Restart into Windows"
fi
rm -f "$rule"
if sudo /usr/local/sbin/leafdeck-boot-windows --check 2>/dev/null; then
  echo "  Windows found: Leafdeck's Control Center has Restart into Windows"
else
  echo "  no Windows on this computer (the button stays hidden)"
fi
sudo systemctl enable --now bluetooth >/dev/null 2>&1 || true

say "Power settings and touchscreens"
# The power button sleeps instead of shutting down (holding it still shuts down). logind rereads its settings on SIGHUP.
sudo install -D -m 644 "$REPO/os/logind-leafdeck.conf" /etc/systemd/logind.conf.d/50-leafdeck.conf
sudo systemctl kill -s HUP systemd-logind
# Smooth frames while the CPU is busy: the session (cage, Leafdeck) and Leafdeck's own scope outweigh terminals' work,
# and programs may raise a thread's priority to nice -10 (Chromium's display threads). The limit applies from the next
# sign-in.
sudo install -D -m 644 "$REPO/os/leafdeck-session-scope.conf" /etc/systemd/system/session-.scope.d/50-leafdeck.conf
sudo install -D -m 644 "$REPO/os/leafdeck-app-scope.conf" /etc/systemd/user/app-leafdeck-.scope.d/50-leafdeck.conf
sudo install -D -m 644 "$REPO/os/leafdeck-limits.conf" /etc/security/limits.d/30-leafdeck.conf
sudo systemctl daemon-reload
# Two-screen laptops (Yoga Book 9): each touchscreen and pen on its own panel. Applies from the next sign-in.
sudo install -m 644 "$REPO/os/70-leafdeck-touch.rules" /etc/udev/rules.d/70-leafdeck-touch.rules
# Keys the kernel drops (Fn+PrtSc on the Yoga Book 9 keyboard): Leafdeck reads that keyboard's hidraw node.
sudo install -m 644 "$REPO/os/70-leafdeck-keys.rules" /etc/udev/rules.d/70-leafdeck-keys.rules
sudo udevadm control --reload
sudo udevadm trigger --subsystem-match=input --action=change
sudo udevadm trigger --subsystem-match=hidraw --action=change
echo "  power button: sleep (hold to shut down)"
# Settings → Power changes the lid, the power button and battery charging through this root helper (and only it).
sudo install -m 755 -o root -g root "$REPO/os/leafdeck-power" /usr/local/sbin/leafdeck-power
rule=$(mktemp)
echo "$(id -un) ALL=(root) NOPASSWD: /usr/local/sbin/leafdeck-power" > "$rule"
if sudo visudo -cqf "$rule"; then
  sudo install -m 440 -o root -g root "$rule" /etc/sudoers.d/leafdeck-power
  echo "  lid, power button and charging can be changed in Settings → Power"
else
  warn "Couldn't install the sudo rule for Settings → Power"
fi
rm -f "$rule"
# Power modes (Power saver, Balanced, Performance): tuned's power-profiles-daemon stand-in, as on Fedora Workstation.
rpm -q tuned-ppd >/dev/null 2>&1 || sudo dnf -y install tuned-ppd >/dev/null
sudo systemctl enable --now tuned tuned-ppd >/dev/null 2>&1 || true
# "Performance" is Leafdeck's own profile (os/tuned-leafdeck-performance.conf), not tuned's throughput-performance,
# which pins every core at its top P-state and starves the GPU of power on a thin laptop.
sudo install -D -m 644 "$REPO/os/tuned-leafdeck-performance.conf" /etc/tuned/profiles/leafdeck-performance/tuned.conf
sudo sed -i 's/^performance=throughput-performance$/performance=leafdeck-performance/' /etc/tuned/ppd.conf
sudo systemctl try-restart tuned tuned-ppd >/dev/null 2>&1 || true

say "Leafdeck as the default session at the login screen"
user=$(id -un)
sudo mkdir -p /var/lib/AccountsService/users
if sudo test -f "/var/lib/AccountsService/users/$user"; then
  sudo sed -i -e 's/^Session=.*/Session=leafdeck/' -e 's/^XSession=.*/XSession=leafdeck/' "/var/lib/AccountsService/users/$user"
  sudo grep -q '^Session=' "/var/lib/AccountsService/users/$user" || printf 'Session=leafdeck\n' | sudo tee -a "/var/lib/AccountsService/users/$user" >/dev/null
else
  printf '[User]\nSession=leafdeck\nXSession=leafdeck\nSystemAccount=false\n' | sudo tee "/var/lib/AccountsService/users/$user" >/dev/null
fi
echo "  you'll sign in with your password; pick GNOME under the gear icon if you ever need it"

if [ "$LOCAL_SERVER" = 1 ]; then
  say "Local Leafdeck server (development)"
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/leafdeck-dev-server.service" <<UNIT
[Unit]
Description=Leafdeck local server (wrangler dev) for development
After=network.target

[Service]
WorkingDirectory=$REPO
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStartPre=$HOME/.local/bin/npx wrangler d1 migrations apply DB --local
ExecStart=$HOME/.local/bin/npx wrangler dev --port 8787
Restart=on-failure

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now leafdeck-dev-server >/dev/null
  sudo loginctl enable-linger "$user"
  echo "  running at http://localhost:8787"
fi

say "Hardware report"
"$REPO/os/hardware-report.sh" || warn "The hardware report had a problem; the setup itself is done."

say "Done"
cat <<DONE
Sign out (or restart) and sign in: Leafdeck is the default session now.
  - Lock: Ctrl+Alt+L. Restart Leafdeck after code changes: Leafdeck menu.
  - Terminal: search for "Terminal" (Ctrl+K). Claude Code: cd $REPO && claude
  - To get back to GNOME for a moment: sign out, click your name, then the gear icon, and pick GNOME.
  - To take Leafdeck OS off again: $REPO/os/setup-fedora.sh --uninstall
  - Leafdeck runs from this folder ($REPO): keep it where it is.
DONE

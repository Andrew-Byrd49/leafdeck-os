# Leafdeck OS

Leafdeck as the whole computer: Fedora underneath (kernel, drivers, security updates), Leafdeck as the only thing on screen.
The design, decisions and roadmap are in [ARCHITECTURE.md](ARCHITECTURE.md); the image is built from `os/image/`. This
README covers the session and the development setup on Fedora Workstation; to install it, start with [INSTALL.md](../INSTALL.md).
Plan: Phase 0 hardware check → 1 Leafdeck on Linux → **2 Leafdeck as the session (in progress)** → 3 installable image → 4 native apps in Leafdeck's window manager.

## What's here

- `leafdeck-session`: the session. It runs Leafdeck full screen under `cage` (a one-app Wayland compositor) with `LEAFDECK_SESSION=1`. When Leafdeck exits (Sign out), the session ends and the login screen returns.
- `leafdeck.desktop`: registers the session with the login manager (`/usr/share/wayland-sessions/`).
- `logind-leafdeck.conf`: the power button sleeps instead of shutting down (`/etc/systemd/logind.conf.d/`).
- `70-leafdeck-touch.rules`: puts each built-in touchscreen on its own panel on two-screen laptops (`/etc/udev/rules.d/`).
- In the app: `electron/ossystem.cjs` (power, sound, brightness, network, battery through systemd/logind, PipeWire, brightnessctl, NetworkManager and `/sys`), `electron/osnotify.cjs` + `notify-helper.py` (notifications), `public/js/ostray.js` (menu bar tray and its panels), `public/js/osk.js` (on-screen keyboard). Session mode in `electron/main.cjs` (`SESSION`): no minimize/maximize, full screen, Sign out instead of Quit.

## Install on Fedora

**One step:** `os/setup-fedora.sh` does everything below and more (Leafdeck's cage, Node.js, Claude Code, Leafdeck as the
default session), can be run again any time, and `os/setup-fedora.sh --uninstall` undoes it. The walkthrough for a new
computer, including Fedora beside Windows, is [INSTALL.md](../INSTALL.md).

By hand, the least a session needs:

```sh
sudo dnf install cage wlr-randr brightnessctl
sudo install -m 755 os/leafdeck-session /usr/local/bin/leafdeck-session
sudo install -m 644 os/leafdeck.desktop /usr/share/wayland-sessions/leafdeck.desktop
sudo install -D -m 644 os/logind-leafdeck.conf /etc/systemd/logind.conf.d/50-leafdeck.conf && sudo systemctl kill -s HUP systemd-logind
sudo install -m 644 os/70-leafdeck-touch.rules /etc/udev/rules.d/   # two-screen laptops
```

To start up the way Leafdeck OS does (Leafdeck's boot screen and sign-in screen instead of Fedora's and GNOME's),
run `os/use-leafdeck-signin.sh` and restart; `os/use-leafdeck-signin.sh --undo` goes back. Run it again after changing the
sign-in screen, which runs its own packaged copy of Leafdeck (`/usr/lib/leafdeck`). Otherwise, pick **Leafdeck** on GNOME's
login screen, or make it the default and log in automatically (development only):

```sh
printf '[User]\nSession=leafdeck\n' | sudo tee /var/lib/AccountsService/users/$USER
# /etc/gdm/custom.conf, [daemon]: AutomaticLoginEnable=True, AutomaticLogin=<user>
```

Optional settings in `~/.config/leafdeck-session.env` (exported to Leafdeck, and reread each time Leafdeck restarts, so
Restart Leafdeck applies a change; settings for the compositor itself need a new sign-in):

| Setting | What it does |
|---|---|
| `LEAFDECK_URL` | Leafdeck server, e.g. `http://localhost:8787` for a local `wrangler dev` |
| `LEAFDECK_DEV_TREE` | Run a source checkout (its `node_modules/electron`) instead of the installed package |
| `LEAFDECK_SCREEN_MODE` | Force a screen mode, e.g. `1440x900` (VMs report a small one) |
| `LEAFDECK_SCREEN` | The output to use, e.g. `eDP-1` or `DP-2` (`wlr-randr` lists them), or `built-in` for every built-in panel, stacked. Default: an external display when one is connected, else the built-in panel. Settings → Leafdeck OS → Screen overrides it |
| `LEAFDECK_SCREEN_SCALE` | Force the screen scale (`1` or `2`). Default: `2` on dense panels (170 dpi and up), else `1` |
| `LEAFDECK_EXTRA_FLAGS` | Extra Electron flags, e.g. `--remote-debugging-port=9333` |
| `LEAFDECK_PER_SCREEN` | `1`: one surface per screen (`electron/screens.cjs`): each screen in use gets a Leafdeck window of its own, drawn at its own scale, instead of one window across all of them. Needs the cage from `os/cage/build.sh` (November 2026 or later); with an older one Leafdeck says so in the log and stays one window. Being finished: programs' own windows, Alt+Tab, the launcher and the `leafdeck_*` tools still work on the main screen only |

## VirtualBox notes (development VM)

- Graphics: **VBoxSVGA with 3D off.** The 3D adapter (vmwgfx) breaks buffer sharing between `cage` and apps: everything stays black. The session switches the compositor to software rendering under VirtualBox automatically, and the VM needs `--disable-gpu` in `LEAFDECK_EXTRA_FLAGS`.
- Audio: VirtualBox's emulated HD Audio crashed Fedora's 7.2 kernel at boot, so the VM runs without sound for now. The sound controls work on real hardware (verified before the crash).
- Turn off the boot splash (`plymouth.enable=0 rd.plymouth=0`); it can hold the session from starting.

## What the session has

- **Power and status:** menu bar tray icons, each opening its own panel: network (Wi-Fi networks, and Bluetooth: turn on
  and off, find, pair, connect, forget; a keyboard's pairing code is shown to type on it), volume, battery (with
  brightness), and power (Screenshot, Lock, Sleep, Restart, Shut down, Sign out).
- **Screens** (`applyScreens` in `electron/ossystem.cjs`): Leafdeck is one full-screen window, and cage sizes it to every
  output in use, so the session picks the outputs and turns the others off. Normally one: an external display when
  connected, else the built-in panel; Settings → Leafdeck OS → Screen or `LEAFDECK_SCREEN` picks another. **Both built-in
  screens** (Yoga Book 9) stacks the panels, top one first; the window spans both and the UI (`setScreens` in
  `public/js/wm.js`) keeps the menu bar and Dock on the top one and maximizes and snaps windows per screen. Settings →
  Displays → **Menu bar** (with its own search) and **Dock** give another screen its own as well (`prefs.barScreens`,
  `prefs.dockScreens`). Re-applied
  when displays come and go, and after sleep. The brightness slider sets the panels in use (each has its own backlight)
  and is hidden when only an external display is on.
- **On-screen keyboard** (`public/js/osk.js`): comes up when you tap a text field (in Leafdeck or a site) and from the
  keyboard button in the menu bar on touch screens. Esc, Tab, Ctrl, Alt and arrows for the terminal. Keys are typed
  through the main process (`os:key`), so sites and the terminal get real key presses. With both built-in screens it
  fills the lower half of the bottom screen, and maximized windows there fit above it.
- **Notifications** (`electron/osnotify.cjs`, `notify-helper.py`): Leafdeck is the session's notification service
  (`org.freedesktop.Notifications`), so `notify-send`, Linux apps, system services and websites show cards in Leafdeck,
  with their buttons. Critical ones stay until dismissed.
- **Sleep:** the power button sleeps (hold it to shut down); closing the lid sleeps unless an external display is
  connected (logind). On battery the computer sleeps after 15 minutes unused (Settings → Leafdeck OS → Sleep when idle).
  Sound playing, or video full screen, keeps it awake and unlocked.
- **Sign-in PIN** (`os/leafdeck-pin`, installed by `os/use-leafdeck-signin.sh`; set in Settings → Leafdeck OS): 4 to 12
  digits that sign in and unlock, as well as the password. A root helper keeps it as a scrypt hash in
  `/var/lib/leafdeck-pin` (labeled `xdm_var_lib_t`); greetd's PAM stack asks it first (`pam_exec`), and the lock screen
  and Settings reach it through a sudo rule limited to its own commands. Setting or removing it takes the password. After
  5 wrong PINs (sign-in and lock screen together) it stops working until the password is used. A PIN sign-in doesn't
  unlock the GNOME keyring, so until the next password sign-in Leafdeck can't read or save passwords, cards or
  connected accounts (see Secrets below).
- **Secrets** (`os/leafdeck-session`): Leafdeck's saved passwords, cards and tokens are encrypted with a key kept in
  the GNOME keyring, which a password sign-in unlocks. When the keyring is locked (PIN sign-in, auto-login) the session
  starts Leafdeck with Electron's basic store instead: secure storage is then unavailable and nothing secret is saved
  (the Passwords view says so), rather than GNOME's unlock prompt appearing over Leafdeck.
- **Restart into Windows** (dual boot): `os/leafdeck-boot-windows` sets the firmware's one-time boot entry to Windows Boot
  Manager. `setup-fedora.sh` installs it with a sudo rule for just that helper; the button only appears when Windows is a
  startup choice. It exists because the startup menu can't be used with a Bluetooth keyboard.
- **Lock screen** (`electron/oslock.cjs`, `public/lock.html`): your account password, checked by `unix_chkpwd`, or your
  PIN. Locks from
  the power panel in the menu bar, Ctrl+Alt+L or Super+L, after the idle time in Settings → Leafdeck OS (5 minutes by default), and before
  sleep. After three wrong tries it makes you wait (5 s, 10 s, 20 s… up to 5 minutes). It has an on-screen keyboard (opens
  on touch, or with the Keyboard button). If Leafdeck crashes while locked, it starts again locked
  (`$XDG_RUNTIME_DIR/leafdeck-locked`).
- **Terminal** (`public/js/apps/terminal.js`, backed by `electron/terminal.cjs` and `electron/pty-helper.py`): real shells with tabs; Ctrl/Alt shortcuts go to the shell while it has focus.
  Copy and paste with Ctrl+Shift+C / Ctrl+Shift+V or right-click.
- **Restart Leafdeck**: the session restarts Leafdeck in place (exit code 75), so code changes apply without signing out.
  A crash restarts it too; three crashes right after starting switch to safe mode.
- **Safe mode** (`os/leafdeck-session --safe`, `electron/safemode.cjs`, `public/js/safemode.js`): Leafdeck with its
  default settings, for when Leafdeck itself is what's broken. The session starts it after three quick crashes; the
  sign-in screen's **Safe mode** button starts it (and offers it first when the last session ended that way, from the
  note the session leaves in `/run/leafdeck/failed`, `os/leafdeck-tmpfiles.conf`); Settings → Leafdeck OS and the
  Ctrl+Alt+Delete rescue screen have **Restart into safe mode** (exit code 76). It runs the shipped Leafdeck and leaves
  `~/.config/leafdeck-session.env` unread (no dev tree, extra flags or compositor variables), skips saved display
  arrangements and the window layout, doesn't use leafdeckd, and runs on a temporary profile if the database fails its
  check. A banner has **Try Leafdeck now** (back to a normal start; another crash loop returns to safe mode) and the list
  of what it found with one-click fixes (set the settings file aside, turn the dev tree off, reset displays, set a
  broken database or settings file aside, restart leafdeckd; nothing is deleted). Claude opens with the report and the
  last session's log (`~/.local/state/leafdeck/safe-mode/`), briefed by `electron/SAFEMODE.md`; that conversation lives
  there too, so it continues across attempts.
- **Print Screen** saves to ~/Pictures/Screenshots. **Settings → Leafdeck OS**: lock timing, the screen to use and About this computer.

## Known gaps (next)

- Saved passwords use Electron's basic store. Phase 3 replaces this with Leafdeck's own first sign-in tied to disk encryption.
- Disk encryption: with only a Bluetooth keyboard, a passphrase at startup can't be typed (Bluetooth starts later). Next:
  TPM unlock (`systemd-cryptenroll --tpm2-device=auto`), the way BitLocker works.
- The screen never turns off on its own: cage has no display power control, and turning every output off could end the
  session. Next: dim the built-in panels' backlight when idle, or a compositor with output power management (Phase 4).
- Wi-Fi and Bluetooth status, network scans and device lists are checked on the Yoga Book 9 (Intel Wi-Fi, a Bluetooth
  keyboard and mouse). Joining a new network and pairing a new device still need a run on real hardware.
- Linux programs open as real windows in Leafdeck frames with Leafdeck's cage (`os/cage/native-windows.patch`, built by
  `os/cage/build.sh` and into the image); with stock cage they fall back to the app display, a VNC picture in a Leafdeck window.

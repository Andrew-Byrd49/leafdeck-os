# Leafdeck OS architecture

Leafdeck OS is its own operating system, derived from Fedora the way Pop!_OS is derived from Ubuntu. Fedora is the
upstream for the parts every OS shares and nobody should rebuild alone: the kernel, drivers and firmware, systemd, Mesa,
PipeWire, NetworkManager, BlueZ, and their security fixes. Everything a person sees, and everything that defines how the
computer behaves, is Leafdeck's: the image, the updates, setup, sign-in, the compositor and desktop, the system
services, the apps and the branding.

The Fedora Workstation install with GNOME that Leafdeck OS was first developed on (`os/setup-fedora.sh`) is a development
environment only. Nothing in the OS may depend on GNOME or other Workstation parts.

## Decisions

| | Choice | Why |
|---|---|---|
| Base | Fedora's bootc image (`quay.io/fedora/fedora-bootc`) | Fedora's packages and cadence, as an image we build on |
| Updates | Whole-image (bootc): each update is a new image, `/usr` read-only, rollback if it doesn't boot | Reliable for people who aren't Linux users; like ChromeOS |
| Compositor | Leafdeck's own, in Rust on Smithay (as COSMIC is on Pop!_OS) | Owns windows, screens, display power, input and touch; replaces cage |
| Sign-in | greetd (login daemon) + Leafdeck's own sign-in screen (Leafdeck in greeter mode, in cage) | greetd is tiny and has no desktop of its own |
| Identity | `/usr/lib/os-release`: `ID=leafdeck`, `ID_LIKE=fedora`, Leafdeck's version in `IMAGE_VERSION` | `VERSION_ID` stays Fedora's: package tools read it |

## Layers

```
 Leafdeck apps, sites, programs from the Terminal     ← Leafdeck
 Leafdeck shell: the UI (Electron, public/)            ← Leafdeck
 Leafdeck compositor (Rust/Smithay)                    ← Leafdeck   (today: cage)
 leafdeckd (user services) · leafdeck root helper      ← Leafdeck   (leafdeckd: terminals, notifications so far)
 Sign-in (greetd + Leafdeck screen) · setup · updates  ← Leafdeck
 systemd, D-Bus, NetworkManager, BlueZ, PipeWire, …    ← Fedora packages
 Linux kernel, drivers, firmware                       ← Fedora packages
```

- **leafdeckd** (`electron/leafdeckd.cjs`, unit `os/leafdeckd.service`): a systemd user service, started with the
  session and stopped at sign-out, that owns what must outlive the UI. Leafdeck connects over
  `$XDG_RUNTIME_DIR/leafdeck/daemon.sock` (`electron/leafdeckd-client.cjs`; one JSON object per line), so restarting or
  crashing the UI loses nothing: shells keep running and the Terminal app takes them back, with their recent output.
  It runs on the system's Node (`nodejs24`): the packaged app has Electron's run-as-Node switch turned off, as it should.
  It shares its modules with the app (`terminal.cjs`, `osnotify.cjs`), which keeps them unpacked from `app.asar`;
  Leafdeck without leafdeckd (on another Linux) runs them itself. Today: terminals and notifications. Next: devices
  (network, Bluetooth, power, sound) and screens, through their D-Bus interfaces.
- **Root helper**: a system service with polkit rules for what needs root: restart into another OS, updates, disk
  encryption, the computer's name, accounts. Replaces sudo rules.
- **Session**: a systemd user target tied to `graphical-session.target`, so portals and D-Bus-started apps get the display.

## Where things live (on the computer)

| Path | What |
|---|---|
| `/usr/lib/leafdeck/` | The Leafdeck app (packaged Electron); `/usr/bin/leafdeck` links to it |
| `/usr/libexec/leafdeck/` | Session, setup and helpers |
| `/usr/lib/systemd/{system,user}/leafdeck*` | Leafdeck's services (`leafdeck-session.target`, `leafdeckd.service`, …) |
| `/usr/lib/systemd/logind.conf.d/`, `/usr/lib/udev/rules.d/` | Power button, touchscreens |
| `/etc/greetd/config.toml` | Sign-in (a default the computer may change) |
| `/var/lib/leafdeck/` | System state (setup done, …) |
| `~/.config/Leafdeck/` | The app's settings and data |

## In this repository

- `os/image/Containerfile`: the image. `os/image/build.sh image | disk | run` builds it, makes a bootable disk and boots
  it in QEMU. `os/image/rootfs/` holds files copied into the image as is; `build.sh` adds the ones shared with the
  development setup (`os/leafdeck-session`, logind and udev files) and writes `os-release`.
- `electron/os*.cjs`, `public/js/os*.js`: the OS features in the app (moving into leafdeckd).
- Files (`public/js/apps/files.js`, `electron/files.cjs`): the file manager. It does the freedesktop.org Trash itself
  (home Trash, and `.Trash-<uid>` on other drives) rather than through a desktop environment's tools, and serves file
  contents for previews at `leafdeck://app/~file`, which only Leafdeck's own page can reach.

## Roadmap

1. **Image skeleton** (done): Fedora bootc base, no GNOME, greetd with a text sign-in, text setup that creates the
   account, Leafdeck in cage, Leafdeck OS identity.
2. **leafdeckd and the systemd session**: the session target (portals get the display) and leafdeckd with terminals and
   notifications (done); next devices, screens and power, each moved to D-Bus.
3. **Compositor**: Rust/Smithay, with the Leafdeck UI as its shell; display power, native app windows, and screens as
   separate surfaces. Native app windows came first, as a patch to cage (`os/cage/native-windows.patch`, 2026-11-02):
   programs' real windows drawn in Leafdeck's frames, Leafdeck telling the compositor where each is and what of its UI
   is in front (`electron/compositor.cjs`, `public/js/nativewin.js`); the Smithay compositor takes over that protocol.
   Until then, Settings → Displays (`public/js/displays.js`, arrangements per set of screens in
   `electron/ossystem.cjs`) arranges outputs through wlr-randr and the UI places itself on them (`setScreens` in
   `public/js/wm.js`); the compositor will take the same saved arrangements.
4. **Sign-in and boot** (done): Leafdeck's sign-in screen on greetd (`electron/greeter.cjs` shows the lock screen's
   page, launched by `os/leafdeck-greeter`, which falls back to a text sign-in if it can't start); the boot screen
   (`os/plymouth/leafdeck`, in the initramfs on the firmware framebuffer); the boot menu hidden and named Leafdeck OS.
   Safe mode (done, `os/README.md`): when Leafdeck itself can't start, the session falls back to the shipped Leafdeck
   with default settings and Claude gets the report; the sign-in screen offers it. Rolling back the image (item 6) is
   the fix safe mode can't make itself.
5. **Setup and security**: graphical setup, installer, disk encryption unlocked by the TPM, secret store.
6. **Updates**: images published to a registry, signed; `bootc upgrade` from Leafdeck's update UI, with rollback.
   Until then an installed disk can't update itself (it was installed from local container storage).

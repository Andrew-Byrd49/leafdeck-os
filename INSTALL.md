# Installing Leafdeck OS

Leafdeck OS runs on top of Fedora Linux. Installing it is two jobs: put Fedora Workstation on the computer (beside
Windows, if you want to keep Windows), then run one script that turns that Fedora into Leafdeck OS.

You don't need to have used Linux before. Read the whole page once before you start.

- [What you need](#what-you-need)
- [Part 1: Fedora beside Windows](#part-1-fedora-beside-windows)
- [Part 2: Leafdeck OS](#part-2-leafdeck-os)
- [First start](#first-start)
- [Updating](#updating)
- [Going back](#going-back)
- [If something goes wrong](#if-something-goes-wrong)

## What you need

- A 64-bit Intel or AMD computer. Leafdeck OS has been run on a Lenovo Yoga Book 9 and in a virtual machine; other
  computers should work wherever Fedora does, but haven't been checked.
- A USB stick you can erase (8 GB or more), for the Fedora installer.
- An internet connection during the setup.
- A Claude account, for Claude Code and the other Claude features. Everything else works without one.
- A backup of anything on the computer you couldn't stand to lose. Changing how a disk is divided is safe when it goes
  right, and this is the one step where a mistake can cost you files.

**It's early.** What you're installing is the development setup: Leafdeck runs from the source code in a folder in your
home folder, and you update it with `git pull`. There's no installer image yet.

**Trying it without touching your computer:** install Fedora Workstation in a virtual machine (VirtualBox, with the
graphics set to VBoxSVGA and 3D acceleration off) and start at [Part 2](#part-2-leafdeck-os).

## Part 1: Fedora beside Windows

Already have Fedora Workstation 44? Skip to [Part 2](#part-2-leafdeck-os). Giving Fedora the whole computer? Do steps 3
and 4 only, and let the installer use the entire disk.

### 1. Get Windows ready

1. **Back up** your files.
2. **BitLocker:** if the disk is encrypted (Settings → Privacy & security → Device encryption, or BitLocker), save your
   recovery key first (it's at https://account.microsoft.com/devices/recoverykey for a Microsoft account). Windows may ask
   for it the first time it starts after Fedora is installed.
3. **Turn off Fast Startup:** Control Panel → Power Options → Choose what the power buttons do → Change settings that
   are currently unavailable → clear "Turn on fast startup". With it on, Windows leaves its disk half-open when it shuts
   down.

### 2. Make room

1. Right-click the Start button → **Disk Management**.
2. Right-click the Windows partition (usually `C:`) → **Shrink Volume**.
3. Shrink it by the space you want Leafdeck OS to have: 60 GB (60000 MB) is a comfortable start, more if you'll keep a
   lot of files there. Leave the new space as "Unallocated". Don't create a partition in it.

### 3. Make the installer USB stick

1. Download **Fedora Media Writer** from https://fedoraproject.org/workstation/download and run it.
2. Choose Fedora Workstation, pick your USB stick, and write it. This erases the stick.

### 4. Install Fedora

1. Restart the computer from the USB stick. On most computers you press a key as it starts (F12, F2, Esc or Enter,
   depending on the maker) and pick the stick from a boot menu. In Windows you can also hold Shift while you click
   Restart, then choose Use a device.
2. Choose to install Fedora.
3. When it asks where to install, choose the option that **keeps your other operating system** and uses the free space
   you made. **Don't choose the one that erases or uses the entire disk** unless you mean to remove Windows.
4. Create your user account when it asks, let it finish, and restart. Take the USB stick out.

The computer now starts with a menu: Fedora, or Windows Boot Manager. Start Fedora and sign in. You'll see GNOME,
Fedora's own desktop; that's what Part 2 replaces.

## Part 2: Leafdeck OS

In Fedora, open the **Terminal** app (press the Windows key and type "terminal") and run these three lines. The second
downloads Leafdeck OS into a `leafdeck-os` folder in your home folder; the third sets it up.

```sh
sudo dnf install -y git
git clone https://github.com/Andrew-Byrd49/leafdeck-os.git
leafdeck-os/os/setup-fedora.sh
```

It asks for your password (typing shows nothing; that's normal) and takes several minutes, most of it downloading. It
tells you what it's doing at each step:

- installs the system pieces Leafdeck needs, and builds Leafdeck's own version of the `cage` display program
- installs Node.js and Claude Code for your user
- makes Leafdeck the session you sign in to, the web browser, and the image viewer
- sets up Restart into Windows, if Windows is on the computer
- ends with a hardware report, saved as `leafdeck-hardware-report.txt` in your home folder

It's safe to run again if it stops partway. When it says **Done**, restart the computer.

**Keep the `leafdeck-os` folder where it is.** Leafdeck runs from it. If you move it, run the setup script again from
its new place.

## First start

1. Sign in. Leafdeck starts in place of GNOME, and a welcome window shows you around.
2. **Sign in to Claude:** press Ctrl+K, type "Terminal", open it, run `claude`, and follow its sign-in. After that,
   the Claude Code app, App Builder and the Claude button work.
3. **Back to Windows:** Leafdeck's Control Center has Restart into Windows. From Windows, restart and pick Fedora in the
   startup menu.

Optional: `leafdeck-os/os/use-leafdeck-signin.sh` replaces Fedora's boot screen and GNOME's sign-in screen with
Leafdeck's own. `--undo` on the same script goes back.

## Updating

```sh
cd ~/leafdeck-os
git pull
os/setup-fedora.sh
```

Then choose Restart Leafdeck from the Leafdeck menu, or restart the computer. Fedora's own updates (the kernel, drivers
and security fixes) come through `sudo dnf upgrade`.

## Going back

- **GNOME for a moment:** sign out, click your name on the sign-in screen, click the gear icon, and pick GNOME.
- **Take Leafdeck OS off, keep Fedora:** `~/leafdeck-os/os/setup-fedora.sh --uninstall`, then restart. The computer
  starts into GNOME as it did before. Your Leafdeck data (`~/.config/Leafdeck`), the `leafdeck-os` folder, Node.js and
  Claude Code are left for you to keep or delete.
- **Remove Fedora too:** that's a Windows job: delete Fedora's partitions in Disk Management, extend `C:` back over the
  space, and remove Fedora from the startup menu. Look up current instructions for your computer before you do; getting
  it wrong can leave the computer unable to start.

## If something goes wrong

- **Leafdeck won't start after signing in:** you're returned to the sign-in screen. Pick GNOME under the gear icon, and
  you have a working desktop to fix things from. (With Leafdeck's own sign-in screen, it offers safe mode when Leafdeck
  keeps crashing.)
- **The setup script stopped with an error:** run it again; it picks up where it left off. If it stops at the same
  place, open an issue with the last lines it printed.
- **Something on your computer doesn't work** (touch, sound, Wi-Fi, a second screen): open an issue at
  https://github.com/Andrew-Byrd49/leafdeck-os/issues and attach `leafdeck-hardware-report.txt` from your home folder.

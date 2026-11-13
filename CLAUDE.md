# Leafdeck

Leafdeck is Leafdeck OS, a computer for your work (`os/`), and the app at its heart: an Electron app (`electron/`) whose UI is plain
ES modules in `public/` (no build step). Its data is local: `electron/localdb.cjs` runs the Worker's API (`src/`) in the
main process on SQLite (`leafdeck.db` and `media/` in the profile), with no server or account. The same `src/` still
deploys as a Cloudflare Worker (D1) for the web version, and Settings → Data can import once from one. The README covers the product, the app
features and deployment; this file is for working on the code.

## Layout

- `electron/main.cjs`: the main process (windows, IPC, protocols, shortcuts). Small modules beside it: `ossystem.cjs`,
  `oslock.cjs`, `ospower.cjs` + `os/leafdeck-power` (Settings → Power: modes, idle, lid, charging), `osnotify.cjs` + `notify-helper.py`, `terminal.cjs` + `pty-helper.py` (Leafdeck OS; terminals and
  notifications run in `leafdeckd.cjs`, a separate user service, when it's there), `userapps.cjs` + `agentchat.cjs` (App Builder; `appbundle.cjs` is what an app may contain, shared with the store service, and `appstore.cjs` the store on this computer (`public/js/apps/store.js` is its window, the Leafdeck Store app): signed installs, takedowns, Publish;
  `agentchat.cjs` is every headless Claude Code chat; `chathost.cjs` keeps their processes in `leafdeckd`, so they carry on through a restart of Leafdeck), `codegit.cjs` (the Claude Code app's git: changes, diffs, worktrees),
  `screens.cjs` + `public/js/screens.js` (one surface per screen, `LEAFDECK_PER_SCREEN=1`: a page per screen, the same UI
  with `?screen=<connector>`; pages share data through store.js pulls and hand windows over when they're dragged to
  another screen; test headless with `~/ldtests/screens/run-leafdeck.sh`),
  `compositor.cjs` + `public/js/nativewin.js` (programs' real windows in Leafdeck frames, with cage patched by
  `os/cage/native-windows.patch`: cage draws each program where its frame's body is and Leafdeck lists what of its UI is
  in front, "covers"; test it headless with `~/ldtests/native/run-leafdeck.sh`),
  `appdisplay.cjs` + `appdisplay.sh` + `wltoplevels.cjs` (the fallback without the patched cage, the app display: programs started from the Terminal open
  their windows on a headless cage of their own, shown in a Leafdeck window over VNC, `apps/appdisplay.js` with noVNC;
  and anything that still opens on the real screen gets Leafdeck put back in front), `files.cjs` (the Files app's work, Linux), `drives.cjs` (USB sticks and disks through UDisks: mounts them when plugged in, in the session), `mcp.cjs` (the `leafdeck_*` tools), `devtools.cjs` (in the session,
  DevTools runs in a Leafdeck window: `apps/devtools.js`), `preload.cjs` (the only bridge the UI gets:
  `window.desktopShell`). No GTK UI on Linux: `osdesktop.cjs` + `desktop-helper.py` (the desktop portal's file picker,
  `FileManager1`, the polkit agent, the print portal: Chromium's and GTK programs' own Print land on Leafdeck's sheet, in `picker.html`'s window),
  `printing.cjs` (the print sheet's work: pages and files go to `lp`; `watch` takes over the PDF viewer's print button;
  test with `~/ldtests/print/run-leafdeck.sh <test>.mjs`, a fake `lp` so nothing reaches a real printer), `siteprompts.cjs` (site sign-in,
  certificates, device choosers, screen sharing); `voice.cjs` + `whisper-helper.py` (talking to Claude: the Copilot key records the
  microphone, whisper.cpp transcribes it here, the words go to the Claude button's chat); context menus and page dialogs are in `main.cjs` (`OWN_UI`).
  `designer.cjs` (Designer: designs on disk, capturing elements with their states, images and fonts, `leafdesign://`).
  `siteeditor.cjs` (Site Editor: runs `siteeditor/inpage.js` in the site's webview, finds where a style comes from
  over CDP, keeps the state and hand-off in the profile under `projects/<id>/site/`; the `@site:<project>` chat).
  `claudeconfig.cjs` (Claude Settings: an allow-list by path shape of what the app may read and change, what Claude Code loads
  (`probe`, a throwaway process asked over control requests), the undoable History, and `chatLaunch`/`chatMayEdit`, the `@claudesettings` chat's permissions).
  `adminwhy.cjs` (the admin password popup says why when Claude's asking: polkit's pid → the Claude session above it → the running Bash call's description).
  `uiwatch.cjs` (when the UI page stops answering or drawing, the log says which and where: `journalctl -b | grep '\[ui\]'`).
  `safemode.cjs` + `SAFEMODE.md` (Leafdeck OS safe mode: the report, the fixes, Claude's briefing; `LEAFDECK_SAFE=1`,
  set by `os/leafdeck-session --safe`), `greeter.cjs` (the sign-in screen), `rescue.cjs` (Ctrl+Alt+Delete).
- `public/js/`: the UI. `wm.js` (windows, dock, menus; `mergeTitleBar` for an app whose own top row is its title bar), `menubar.js`, `apps/*.js` (each app calls `registerApp`),
  `ostray.js` (Leafdeck OS tray and its panels), `osk.js` (its on-screen keyboard). `dialogs.js` (Leafdeck's own dialogs;
  use `ask`/`confirmDialog`, never `confirm()`), `filethumb.js` (how a file looks: Files and the picker), `filepicker.js` (shown in its own window, `picker.html` + `picker.js`:
  Chromium ignores all input to a window while its file dialog is open), `printsheet.js` (the print sheet) + `printui.js`, `pageui.js` (what sites ask), `osdialogs.js`
  (what the computer asks), `displays.js`, `power.js` and `mouse.js` (Settings pages of Leafdeck OS; Mouse sets libinput's pointer acceleration and speed through cage's `pointer` command), `safemode.js` (the safe-mode banner). Styles: `public/css/app.css`, then `surface.css` (the glow layer), `designer.css`, `graphic.css`.
- `public/js/designer/`: Designer (`apps/designer.js` is the app). `model.js` (layers ↔ HTML/CSS, code and hand-off),
  `editor.js` (the canvas), `layers.js`, `inspector.js`, `handoff.js` (panels), `capture.js` (captures → layers),
  `inpage.js` (runs inside pages, self-contained: no imports), `iconpicker.js` (the icon library; `icons.json` is built
  from Lucide and Tabler by `scripts/designer-icons.mjs`), `DESIGN.md` (the guide Claude gets in each design folder).
  That's the UI Designer half; the Graphic Designer half (vector artwork, a simpler Illustrator) is `public/js/graphic/`:
  `app.js` (mounts it in the Designer window for designs with `kind: 'graphic'`; export), `editor.js` (canvas and tools),
  `panels.js` (Layers, Artboards, Properties), `doc.js` (the document, SVG in and out), `geom.js` (matrices, Béziers),
  `bool.js` (pathfinder and smoothing by Paper.js, vendored in `public/vendor/paper/`).
- `public/js/claudecode/`: the Claude Code app (`apps/claudecode.js` is the window: sessions by folder, new session,
  terminal drawer). `session.js` (one session: transcript, tool cards, approval/question/plan cards, the composer),
  `changes.js` (the Changes panel), `diff.js`, `markdown.js`; styles in `public/css/claudecode.css`. Test it in the
  sandbox with the real HOME: `~/ldtests/t-claudecode*.mjs` (`PROJ_DIR` a scratch git repo).
- `public/js/siteeditor/inpage.js`: the Site Editor's page half (`apps/siteeditor.js` is the app): self-contained like
  Designer's `inpage.js`, it selects elements, shows changes live, edits text in place and pins comments, reporting
  through a DOM event the webview preload forwards. "Edit in Designer" and Designer's "Send back to site" connect the two.
  `public/js/siteeditor/inspector.js` is the Edit panel (auto layout, size, position, the spacing box, typography, fill,
  border, effects, any other CSS, the page's rules): it draws what `siteeditor.cjs`'s `inspect` reads and asks for
  changes through `setProps`; a change can be scoped to a class, a state (`:hover`, forced over CDP) or a width
  (`@media`). Styles in `public/css/siteeditor.css`. Test it with `~/ldtests/siteeditor/run.sh t-inspector.mjs` (its own
  headless sandbox on port 9349, a test site on 8871; the older `t-siteeditor*.mjs` run through it too).
- `public/js/apps/claudesettings.js`: Claude Settings (what Claude reads, instructions, memory, skills, agents, permissions, hooks,
  connections, behavior, History, with a chat beside them), styles in `public/css/claudesettings.css`. Test it with
  `~/ldtests/claudesettings/run.sh <test>.mjs` (`t-pages`, `t-files`, `t-chat`: real Claude turns on Haiku in a scratch project, on port 9353), and
  `t-mayedit.cjs` for which edits go without asking. Never put secrets on its pages: `.mcp.json` stays out on purpose.
- `public/js/apps/imageeditor.js`: the Image Editor (one picture to a window: layers, selections, paint tools; saved files are
  flattened), with `public/js/imageeditor/pixels.js` (canvases, selection masks, flood fill, filters) and `public/css/imageeditor.css`.
  Test it with `~/ldtests/imageeditor/run.sh` (its own headless sandbox on port 9347, real mouse and keyboard).
- `os/`: Leafdeck OS. `ARCHITECTURE.md` (decisions and roadmap: a Fedora-derived OS, not a layer on Fedora), `image/`
  (the bootc system image and `build.sh`), the session (`leafdeck-session`) and the README for the development setup.
- `src/`: the Worker.

Write American English everywhere (code, comments, UI text).

## Working on Leafdeck OS (inside the Linux VM)

Leafdeck OS is Leafdeck as the whole computer: Fedora boots straight into Leafdeck (`os/README.md`). In the VM:

- The source is `~/leafdeck`, a git checkout of the project (`origin` is the GitHub repo the Windows PC also uses). Say
  which files you changed when you finish; commit and push only when asked.
- The session runs this source tree (`LEAFDECK_DEV_TREE` in `~/.config/leafdeck-session.env`). After changing:
  - `public/**` (UI): press **F5** in Leafdeck, or run `window.location.reload()` through the debugging port.
  - `electron/**` (main process, preload): **Restart Leafdeck** (Leafdeck menu or Settings → Leafdeck OS). It restarts in
    place; you stay signed in. From a shell: `node ~/ldtests/cdp.mjs 'window.desktopShell.windowAction("restart-leafdeck")'`,
    or without a debugging port (real hardware) `kill -USR2 $(pgrep -o -f electron/dist/electron)`.
  - `os/leafdeck-session`: `sudo install -m 755 os/leafdeck-session /usr/local/bin/leafdeck-session`, then
    `sudo systemctl restart gdm` (ends the session and starts a fresh one).
- The local server runs as a user service: `systemctl --user status leafdeck-dev-server` (http://localhost:8787).
- Logs: `journalctl --user -b -f` and `journalctl -b | grep gdm-wayland-session` (Leafdeck's console output).
- Programs started from Leafdeck (the Terminal) open in Leafdeck windows, never over Leafdeck. With
  the patched cage (`sh os/cage/build.sh`, then sign in again) they're real windows on `wayland-0` in Leafdeck frames
  (`[compositor] programs open in Leafdeck frames` in the log). Without it, shells get `WAYLAND_DISPLAY=leafdeck-apps`, the
  app display (the user unit `leafdeck-apps`, shown over VNC), and tools that need the real screen (`grim`,
  `wlr-randr`) need `WAYLAND_DISPLAY=wayland-0`.
- Look at the screen: `grim ~/shot.png` (with `XDG_RUNTIME_DIR=/run/user/$(id -u) WAYLAND_DISPLAY=wayland-0`), or Settings →
  Leafdeck app → **Claude Code control**, which gives you the `leafdeck_*` tools (windows, screenshots, clicks) on this
  Leafdeck.
- Debugging port (development only): 9333. `~/ldtests/cdp.mjs '<expr>'` evaluates in Leafdeck's page;
  `~/ldtests/cdp-url.mjs lock.html '<expr>'` in another page (the lock screen).
- The VM has no sound device (VirtualBox's audio crashed the kernel) and no GPU (`--disable-gpu`); real hardware has both.

Rules for OS features: everything that touches the system lives in the main process behind `osOnly`/`linuxOnly` IPC
handlers and only runs in the session (`SESSION`, i.e. `LEAFDECK_SESSION=1`) or on Linux, so `npx electron .` outside the
session (the sandbox testing, the AppImage) shows no OS-only UI.

The Windows browser is discontinued: its last release, 1.17.0, is archived as the tag `windows-browser-v1.17.0` (branch
`windows-browser`). Don't build, test or keep compatibility for Windows on `main`; the `win32` branches still in
`electron/` can be removed when you're working in that code.

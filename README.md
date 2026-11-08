# Leafdeck

Leafdeck is a private, macOS-style desktop for your work, in one place. It's a single Cloudflare Worker: static UI in `public/` and a small JSON API backed by D1.

**Apps:** Contacts, Tasks, Calendar, Notes, Connections, Settings.
**Desktop:** widgets you can drag anywhere on any screen, desktop icons, a Dock with magnification, a search and address bar in the middle of the menu bar (Ctrl/⌘ K, Ctrl L or `/`), draggable and resizable windows, right-click menus, and a Business / Nonprofit / All workspace switcher in the menu bar.

## Run locally

```bash
npm install
npm run dev
```

Then open http://localhost:8787. The local D1 database lives in `.wrangler/`.

## Deploy

```bash
npx wrangler d1 create leafdeck-db
```

Copy the printed `database_id` into `wrangler.jsonc`, then deploy:

```bash
npm run deploy
```

## Leafdeck app (Electron)

The Leafdeck app is a full browser built into the desktop. Websites open in desktop windows as real browser views, so sites that block embedding still load, and **you stay signed in** between launches.

### Install

Leafdeck runs as **Leafdeck OS** (see `os/README.md`), where it is the whole computer. On another Linux desktop, `npm run app:build:linux` builds an AppImage and an rpm in `dist/`.

> **The Windows browser is discontinued.** Its last release, 1.17.0, is archived as the tag `windows-browser-v1.17.0` (branch `windows-browser`). Installed Windows copies keep working on that version but get no more updates. Build it from that tag if you ever need it again; `main` no longer builds for Windows or is tested there.

Leafdeck tells you when a newer Electron (Chromium) security release is out, and Settings → About shows your versions.

For development, with `npm run dev` running in another terminal:

```bash
npm run app
```

> **Use a separate profile for development.** The installed app encrypts its cookies, so the development build (`npm run app`) can't read your real profile's logins once the installed app has run. Develop with `LEAFDECK_USER_DATA=<some folder> npm run app`.

### Using it

- **Dock:** shows pinned apps first, then a divider and any other open windows. Right-click an app or desktop icon and choose **Keep in Dock** to pin or unpin it, and drag pinned icons to reorder them. Pinning a web page saves it as a Connection.
- **Search and address bar:** type a web address and press Enter to go there, or the start of a site you've visited (`git` → github.com). An app's name opens the app; anything else searches the web. Your records, history, bookmarks and a calculator show up underneath.
- **Updates (installed app):** a packaged Leafdeck checks your server's `/api/updates/` for a new version every few hours, downloads it in the background, and installs it when you quit (Leafdeck menu → **Check for Updates…**, then **Restart to Update**). That feed still holds the final Windows release, 1.17.0; there is no release script for new versions now that Windows is discontinued.
- **Meeting notes:** five minutes before a timed event starts, Leafdeck creates a note for it (title, time and place, the attendees matched to your Contacts, and an excerpt of what you wrote the last time you met the same people) and opens it; a chime-free toast says it's ready, or, during a focus session, just the toast. Every event's sheet also has **Meeting notes** to create or open it by hand. Settings → Connected calendars has the switch. Google events now carry their attendees.
- **Email to task, note or contact:** hover a message in the Gmail widget for three buttons: add it as a task (sender, snippet and a link to the thread in the task's notes), start a note from it (with a link back), or save the sender as a contact (opens the existing one if the address is already known).
- **Dock badges:** unread counts that sites put in their page titles ("(3) Inbox", "Inbox (12) – Gmail", "[2] Chat") show as a red badge on that window's Dock icon, for site windows and Connections alike.
- **Keep on top and mini windows:** right-click a Dock icon or use the Window menu for **Keep on Top** (the window stays above the others; a pin appears by its title — click it to release). **Mini Window** (the new title-bar light, or Alt+Shift+↓) shrinks a window to a small always-on-top box in the bottom-right corner with no toolbar, for a lecture or a call; the same control brings it back exactly as it was.
- **Light or dark per app:** right-click a Dock icon or use the Window menu, then under **Appearance** choose **Light** or **Dark** to keep that app that way whatever Settings → Appearance says. **Match Leafdeck** goes back to the theme. The choice is remembered for each app. In a site window or Connection the pages get it too, as their light or dark mode.
- **Snap and pair:** drag a window to the left or right screen edge to snap it to that half (a preview shows where it lands); the top edge maximizes, and a screen corner snaps it to that quarter. Alt+Shift+← / → snap the active window, ↑ maximizes, ↓ makes it mini. **Window → Pair with…** puts two windows side by side and links them: moving one moves both, and resizing one keeps the other flush; a link icon by the title unpairs. Windows that touch, side by side or stacked, meet flush with no gap and square inner corners; hover the seam between them for a divider, and drag it to move the split, resizing both at once (sideways for side-by-side windows, up and down for stacked ones). Pairs, pins and mini windows are remembered across restarts.
- **Focus sessions (F4, or Window → Focus Session…):** pick a task or describe the work, a project to log time to, and a preset (Pomodoro 25/5 ×4, Deep work 50/10 ×2, or custom). The windows you check stay; the rest are put away until you're done. In the desktop app the sites on your block list can't load during focus phases (the page says so and offers to end the session), and web notifications are held for the whole session. A bar above the Dock shows the countdown with pause, +5 minutes and End; a chime marks breaks and the end. When you stop, the focused time is logged as a time entry on the project. A session survives a reload or restart.
- **Saved layouts (Window → Save Windows as Layout…):** save the open windows — sites and apps, with their positions and sizes — under a name, then reopen them all with one click from Window → Open Layout or the Layouts app (which can also update, add alongside, or delete a layout). A project's sheet has **Save windows as workspace** / **Open workspace**, so opening a project can set up everything for it.
- **Window overview (F3, or Window → Show All Windows):** every open window as a card — screenshots for sites, scaled live copies for apps — grouped into Sites and Apps, newest first. Type to filter, Enter or click to switch, × to close a window, arrow keys to move, Esc to leave.
- **Notes:** a rich-text notebook. The toolbar has text color, size, paragraph style (title, heading, subheading, body, quote, code), bold/italic/underline/strikethrough, alignment, bulleted/numbered/check lists, voice memos, links, highlight, tables and images. Markdown shortcuts work at the start of a line (`#`, `##`, `###`, `-`, `1.`, `[]`, `>`, ```` ``` ````); click the H1/H2/H3 label in a heading's margin to change its style; Ctrl+K adds a link and Ctrl+click opens one; Tab moves through table cells; right-click a table cell for rows and columns. Images (paste, drop or insert) and voice memos are stored in the Worker's private `leafdeck-media` R2 bucket and referenced by id; everything pasted is sanitized. Older plain-text notes convert the first time they're edited.
- **Image Editor (Linux and Leafdeck OS):** quick edits to pictures: open a PNG, JPEG, WebP, GIF (first frame) or BMP from the search, from a picture's right-click menu in Files or on the desktop, or with **E** in the Viewer. It has layers with opacity; rectangle, ellipse, lasso and magic wand selections (Delete on a selection makes it transparent); moving and scaling selected pixels; brush, pencil, eraser, fill, gradient, line, shapes, text and a color picker; resize, canvas size, crop, trim, rotate and flip; brightness and contrast, hue and saturation, blur, sharpen, invert and black and white. It saves PNG (keeping transparency), JPEG and WebP, with a quality slider that shows the file's size. A saved file is flattened: layers last only until the window closes.
- **Claude Settings:** everything that shapes how Claude Code behaves, in one app (also under Settings → Claude): what Claude reads at the start of a session and how many tokens each part costs, your instructions and each project's, memory, skills, agents and commands, permissions, hooks, connections (MCP) and behavior. Change things by hand, or tell Claude what should be different in the chat beside them: it knows which page or file you have open, finds the right place and makes the change. Instructions, memory, skills and agents change right away; settings files, commands, and a skill or agent that gives itself permissions show an approval card first. Every change, by you or Claude, lands in the History with its diff and an Undo. Secrets stay out: connections show names only, `.mcp.json` doesn't open here, and the chat can't read where keys are kept.
- **Bookmarks widget:** browses your folders like a bookmarks bar: folders first (with counts), then the bookmarks in the current folder; click a folder to go in and the top row to go back. It starts in the deepest folder that holds everything (your imported bookmarks bar, typically); right-click to start somewhere else or change the sort. The large size has a filter box that searches everything under the current folder. The header, and a “more…” row when a folder doesn't fit, open that folder in the Bookmarks app.
- **Archive preview:** in Files, Space (or Enter) on a .zip, .tar, .tar.gz and the rest shows what's inside as a tree, folders first with item counts and each file with its size, without unpacking anything. Zips are read by Leafdeck itself (Zip64 included); the tar family through `tar`; .7z and .rar need 7-Zip installed.
- **Extracting:** right-click an archive → **Extract here** (or the preview's Extract button) unpacks it beside itself into a folder named after it ("Project 2" if that's taken), or as the one file or folder it holds; notes.txt.gz becomes notes.txt. Several selected archives extract one after another. Nothing is overwritten, a failed extraction leaves nothing behind, and password-protected archives are refused with a message. Archives in a folder you can't write to (a read-only drive) extract into Downloads. Uses `unzip`, `tar` and 7-Zip, which Leafdeck OS ships.
- **Performance widget:** add it from the widget gallery for a live view of the computer: CPU use, speed and temperature, memory, and the battery, with two-minute graphs in the Medium and Large sizes (Large adds disk, network, fan and uptime). Its header opens the Task Manager.
- **Gmail widget:** add it from the widget gallery. It shows the recent inbox of a connected Google account (unread count in the header, a dot on unread messages), refreshes every few minutes, and opens a message in Gmail when you click it. Right-click it for **Unread only**, to pick which account it shows, or **Connect another Google account…** — add one widget per account and each shows its address in the header. Leafdeck only reads mail (the `gmail.readonly` scope); accounts connected before this was added need a one-time reconnect from the widget.
- **Desktop icons:** the desktop is a grid of slots, like a phone's home screen: drag an icon anywhere and the free slots around it show while you drag. Hold it on an occupied slot and that icon moves aside; hold it over another icon's middle to make a **group** of the two (or to add it to a group). Drag one onto the Dock to pin it. Click a group to open it and rename it from its title; drag things out to take them out, or right-click it and choose **Ungroup**. On Linux and Leafdeck OS the files and folders in your Desktop folder show there too: drag them in from Files or other programs, onto a folder to move them in, or onto a Files window. Right-click the desktop for **New Group**, **New Folder**, **Sort by Name** and **Reset Icon Arrangement**. The arrangement is saved with your settings.
- **Windows act as tabs.** Ctrl+T opens a new one with an address bar. Ctrl+Tab cycles windows, Ctrl+W closes one, and Ctrl+Shift+T reopens the last closed. Open pages come back after a restart.
- **Burner windows** (Ctrl+Shift+N, the flame-plus button in the menu bar search, or File → New Burner Window) are private windows: a fresh in-memory session with no history, no saved logins or form entries, and nothing restored after a restart. Links they open stay in the same burner, and closing the last of them wipes its cookies, storage, and cache. Downloads and bookmarks are still kept. The flame and the smoldering title bar only animate on the window in front.
- **Address bar:** type a URL or a search, with suggestions from your history and bookmarks. Choose the search engine in Settings. Ctrl+K searches everything: records, apps, bookmarks, history, URLs and the web.
- **Downloads** go straight to your Downloads folder, or you can choose to be asked where to save each one. Ctrl+J shows progress, pause, resume, cancel, open and show in folder.
- **History** (Ctrl+H) is shared with your phone through your server (see Android companion app below); each visit shows which device it came from. Burner windows are never recorded. Removing a visit or clearing browsing data removes it everywhere. Settings → Devices sets how long shared history is kept (default 1 year).
- **Safe mode (Leafdeck OS):** if Leafdeck can't start, the OS starts it with its default settings instead and opens Claude with the log and a report of what it found, so Claude can fix it; the sign-in screen has a **Safe mode** button too, and Settings → Leafdeck OS has **Restart into safe mode**. Details in `os/README.md`.
- **Claude:** the Claude button at the bottom left (or the Windows key on its own, on Leafdeck OS) opens a chat with Claude for anything: a question, writing, or doing something in Leafdeck with the `leafdeck_*` tools. It runs Claude Code on your computer with your Claude subscription. Settings → **Claude** (also the sliders button at the top of the chat) has its permissions and preferences: whether Claude asks before it acts, and if so what it may do without asking (edit files, run commands, click and type in windows, go to web pages, close windows, run scripts, create apps); the model; and a note about you that every conversation starts with. The **Claude Code** app's chats follow the same settings; App Builder and Designer chats keep their own setup. A change takes effect the next time Claude starts (an idle chat restarts on its next message). **Start fresh after** (48 hours by default) starts the Claude button's conversation over after that long without a message; what Claude remembers about you stays. On Linux, **Voice** lets you talk to Claude: press the **Copilot key** (or the microphone button in the panel) and the panel opens and listens, showing the words as it hears them; the same key again, Enter or a pause sends, and Escape keeps the words without sending. The recognition runs on your computer with whisper.cpp (`sudo dnf install python3-pywhispercpp`, in the Leafdeck OS image already) on a model downloaded once from Settings; nothing is sent anywhere for it.
- **Claude Code app:** the Claude desktop app's Code tab, in Leafdeck. Sessions are listed down the side by folder (search, rename, delete; a dot shows one working, waiting for you, or finished while you were away). **New session** (Ctrl+N) picks the folder, the permission mode and the model, and can put the session in a **git worktree** of its own (`.claude/worktrees/<name>` on a branch `claude/<name>`, kept out of the repo's status) so several sessions work on one repo without colliding. In a session, Claude's tool calls show as cards: edits as diffs, commands with their output, reads, searches, agents. Approvals, Claude's questions (AskUserQuestion) and plans (plan mode: Keep planning, Approve, or Approve and auto-accept edits) wait above the composer. The composer has the permission mode (Shift+Tab cycles), the model and effort (both switch in the middle of a session), an **Ultracode** toggle where the model offers it (Claude plans and runs multi-agent workflows for each substantive task in that session; also `/ultracode` and on the new-session screen), a context meter (click to compact), `/` for Claude Code's commands and skills, `@` for the folder's files, and images pasted, dropped or attached; messages typed while Claude works queue for its next turn (Esc stops it). After each turn Claude Code suggests what you might say next, shown faintly in the empty composer like the terminal does: Tab takes it, typing or Esc clears it. **Changes** shows the folder's git diff file by file and can ask Claude to review or commit; the terminal drawer (Ctrl+`) opens shells in the folder, and **Open → Continue in the terminal** resumes the session with `claude --resume`. Sessions are named by Claude Code from what they're about, and a session can pop out into a window of its own. Drag a session from the sidebar onto the chat to work on two side by side (drop it on the left or right; the middle opens it in place), or out of the window to give it a window of its own; the header, Changes and terminal follow whichever side you click into. **From the terminal** (on the new-session screen) lists the sessions you ran with `claude` in that folder; pick one and it continues in the app, transcript and all. When Claude starts a dev server, **Preview** opens its page in a browser window paired beside the app. The app has no separate title bar: its top row moves the window and holds the window buttons, and in a half-screen window the sidebar slides over the session.
- **Claude Code control:** Settings → Claude → **Claude Code control** turns on an MCP server inside Leafdeck (127.0.0.1 only, bearer token). Copy the command it shows and run it once; Claude Code then has `leafdeck_*` tools in every session: list windows, open sites and apps, read any window as an accessibility outline, click, fill, type, press keys, scroll, screenshot, run script, and read your records. Site windows are driven through Chromium's debugger on their own web contents, so nothing is exposed on a debugging port. A pulsing **Claude Code** badge in the menu bar shows while a session is connected. **New token** cuts off existing sessions.
- **Ad blocking:** built in and on by default, using Ghostery's engine with the EasyList and EasyPrivacy lists (downloaded on first run, cached, refreshed daily). The shield in a site's toolbar shows how many requests were blocked on that page; click it to pause blocking for that site or turn it off entirely. Settings → Browsing & privacy has the switch and the list of paused sites.
- **Autofill:** click a login, address or card field on a site and a menu lists what you've saved for it: an email field lists email addresses, a phone field phone numbers, and so on, and only addresses that have one. Arrow keys and Enter work too. On sign-up and change-password forms it also suggests a strong generated password and fills it into both boxes. Leafdeck offers to save passwords, addresses and cards when you submit them, and the Passwords app has tabs for **Passwords**, **Addresses** and **Payment methods**, each with an on/off switch. The key in a site's toolbar still fills a saved login too. Card fields inside a payment provider's embedded frame (like Stripe's) work as well: the menu is drawn over the page, and the card fills across the form's frames following Chrome's rule (card numbers only go to frames from the same site as the box you clicked, or to the main page). Ordinary text fields suggest what you've typed there before as you type, below anything saved, and email fields suggest every email address you've typed on any site. Shift+Delete removes a suggestion, and the Addresses tab has a switch and a **Clear** button for them. Fields that look sensitive (passwords, codes, card or account numbers, SSNs) and fields marked `autocomplete="off"` are never remembered.
- **Browser windows:** open at 16:11, as large as fits. Resize one and new browser windows use that size from then on, and a Connection you've resized keeps its own size.
- **Built-in PDF viewer, full-screen video, find in page (Ctrl+F), zoom (Ctrl +/−/0) and print (Ctrl+P).** Pinch to zoom on a touch screen or trackpad. On Linux (and Leafdeck OS), printing opens Leafdeck's own print sheet with a preview: your printers and what each offers (paper sizes, trays, paper types, quality), which pages, copies, two-sided, color, margins, scale, headers and footers, or Save as PDF. What you see in the preview is what the printer gets.
- **Sound:** a speaker button appears in the title bar while a page plays audio; click it to mute that page (tabs show which one is playing or muted).
- **Stuck pages:** when a page stops responding, Leafdeck offers to wait or to stop it and load it again. The back and forward buttons on a mouse work in site windows.
- **Task Manager (Shift+Esc)** shows live CPU and memory for every site, the Leafdeck interface and Chromium's own processes, plus GPU acceleration status. It can sleep, reload or end a site.
- **Memory saver:**
  - **Pausing:** minimized windows are paused (frozen, like Chrome's background tabs) after about 10–25 seconds. Their timers and scripts stop, and nothing reloads.
  - **Sleeping:** windows you haven't used for a while (1 hour by default) are put to sleep. The page is unloaded to free its memory and reloads when you open the window again.
  - **Lazy restore:** after restarting Leafdeck, only the front window loads right away. On Leafdeck OS, shutting down or restarting the computer closes everything, so it starts with no windows open.
  - **Exceptions:** sites playing audio, sites with DevTools open, and sites you mark **Keep … Awake** (in the site's ⋯ menu) are never paused or slept.
  - **Settings:** Settings → Performance.
- **Server:** on first launch the app points at `http://localhost:8787`. Set your deployed Worker in Settings → Leafdeck app → Server address. If it's behind Cloudflare Access, click **Sign in to server** once, or save an Access service token. `LEAFDECK_URL` overrides the saved address.
- **Logins across connections:** all connections share one login session. "Use a separate login" on a connection gives it its own session, for example for a second account. To use several accounts on the same site at once, right-click the connection and choose **Open in New Session**: each session (Session 2, Session 3, …) keeps its own logins, is listed in that menu to reopen later, and shows its number in the window title.

| Shortcut | Action |
|---|---|
| Ctrl+T / Ctrl+N | New window |
| Ctrl+W | Close window |
| Ctrl+Shift+T | Reopen closed window |
| Ctrl+Shift+N | New Burner window |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous window |
| Ctrl+L, Alt+D, F6 | Address bar |
| Ctrl+K | Search everything |
| Ctrl+F | Find in page |
| Ctrl+D | Bookmark page |
| Ctrl+J / Ctrl+H | Downloads / History |
| Ctrl+R, F5 / Ctrl+Shift+R | Reload / hard reload |
| Alt+← / Alt+→ | Back / forward |
| Ctrl+= / Ctrl+− / Ctrl+0 | Zoom in / out / reset |
| Ctrl+P | Print |
| F11 | Full screen |
| Shift+Esc | Task Manager |

### Importing from other browsers

Go to **Leaf menu → Import Browser Data…**, or click Import in the Bookmarks or Passwords app.

- **Bookmarks:** imported directly from Chrome, Edge, Brave, Vivaldi and Chromium profiles on this computer, or from an HTML bookmarks export from any browser, including Firefox, Safari and Arc. Bookmarks sync to your Worker like other records. Duplicate URLs are skipped.
- **Passwords:** browsers don't let other apps read their saved passwords, so export a CSV first. In Chrome, open `chrome://password-manager/settings` and choose Export passwords. In Firefox, open `about:logins`. Bitwarden, 1Password, Proton Pass and LastPass can all export CSV. Then choose that CSV file in Leafdeck. Afterward, Leafdeck offers to move the plaintext CSV to the Recycle Bin.

### Security model

The Windows details below (DPAPI, the Mark of the Web, SmartScreen) describe the archived Windows browser; the Linux and Leafdeck OS differences follow the list.

- **Hardened installed build:** Electron fuses enable cookie encryption, block running the app as Node or with Node inspect flags or `NODE_OPTIONS`, load code only from the app's sealed archive, and verify that archive's integrity. The installed app also refuses to start with `--remote-debugging-port`, which would expose your logged-in sessions.
- **Bundled UI:** the desktop UI ships inside the app and is served from `leafdeck://app` under a strict Content-Security-Policy. The Worker is only a data API: `/api` is proxied through the main process, which attaches the API token or Cloudflare Access service token. Those credentials are stored encrypted with Windows DPAPI and never handed to the UI.
- **Locked navigation:** the app window can't navigate away from Leafdeck. Web links open as sandboxed desktop windows.
- **Isolated sites:** websites run in sandboxed webviews that have no access to Leafdeck.
- **Secure DNS:** DNS goes over HTTPS to Cloudflare's security resolver, which blocks known malware and phishing domains. Leafdeck explains when a site is blocked. Settings offers unfiltered encrypted DNS, or your network's DNS for intranets.
- **HTTPS-first:** pages are upgraded to HTTPS. If a site has none, Leafdeck warns before continuing over plain HTTP and marks it "Not secure". Certificate errors can't be bypassed.
- **Downloads:** files are tagged with the Windows Mark of the Web, so SmartScreen and Office Protected View apply. Files that can run code (`.exe`, `.msi`, scripts, macro documents…) need confirmation before opening.
- **Passwords, addresses and cards:** stored only on this computer (`vault.dat` and `autofill.dat`), encrypted with DPAPI, and never synced. Card security codes are never stored, and full card numbers never reach the Leafdeck UI. The in-page autofill menu sits in a closed shadow root that the page can't read, and only real clicks and keys can pick from it. A login is filled only when you pick it (from the menu or the key in a site's toolbar), and only after the main process confirms the page's real address matches the saved site. Passwords and cards are filled only on https pages, or localhost for development. Save prompts use the address from the page's own frame, not anything the page claims. A copied password is cleared from the clipboard after 30 seconds.
- **Site permissions:** camera, microphone, notifications, location and clipboard reading are requested per site in the site's own window, and you can choose to remember the decision. Reset decisions in Settings.
- **Local-only data:** history, downloads, passwords and site permissions never leave this computer.
- **Separate profile:** `LEAFDECK_USER_DATA` runs a separate, isolated profile, like Chrome's `--user-data-dir`.

On Linux and Leafdeck OS, the same holds except where Windows does the work:

- **Secrets:** passwords, cards and tokens are encrypted with a key in the GNOME keyring instead of DPAPI. Leafdeck OS unlocks it when you sign in with your password; after a PIN sign-in or auto-login it stays locked, and Leafdeck saves no secrets (it never falls back to a weaker store).
- **Sandbox:** Chromium's sandbox confines each site's renderer with user namespaces and seccomp; no setuid helper is needed.
- **Downloads:** there's no Mark of the Web or SmartScreen. Files that can run code (scripts, `.AppImage`, `.desktop`, packages, and the Windows types above) still need confirmation before opening.
- **Local services:** Leafdeck's background service (`leafdeckd`, terminals and notifications) and the app display listen on sockets only your account can reach. Claude Code control is off by default; when on it listens on 127.0.0.1 only and needs its token.
- **Root helpers:** the few system settings Leafdeck changes (power, the PIN, restarting into Windows) go through small root scripts with a sudo rule each, and each script checks every argument it accepts.
- **Development:** a session that runs a source checkout (`LEAFDECK_DEV_TREE`) uses the unpackaged Electron, so the hardened build's fuses and its debugging-port refusal don't apply. Use the installed package for everyday use.

### Known limits

- **No browser extensions.**
- **Malware blocking is per domain only**, through DNS. It isn't Chrome's full per-URL Safe Browsing.
- **Builds aren't code-signed**, and updates are a rebuild and reinstall.
- **No tab strip:** windows play that role.

## App Builder (prototype)

Build your own Leafdeck apps with an AI coding agent. Open **App Builder**, describe the app, and **Start building** opens Claude Code (or Codex) in the app's folder with your brief. App Builder shows whether each agent is installed and offers an **Install** button (opens a terminal that installs it and signs you in). App Builder shows whether each agent is installed and offers an **Install** button (opens a terminal that installs it and signs you in).

- **Where apps live:** `DocumentsLeafdeck Apps<id>` (manifest.json, index.html, app.js, style.css, BRIEF.md, and the agent guide as CLAUDE.md / AGENTS.md, from `electron/app-sdk/GUIDE.md`). Outside Leafdeck's sealed code, so updates never touch them.
- **How they run:** each app runs at `leafapp://<id>/` in its own sandboxed webview: no Node, scripts only from its folder, network only to hosts its manifest declares. It reaches Leafdeck only through `window.leafdeck` (`electron/app-preload.cjs` → `public/js/userapps.js`), which checks the permissions you approved.
- **Chat:** with Claude Code installed, an app's page in App Builder is a chat (`public/js/agentchat.js` ← `electron/agentchat.cjs`). Leafdeck runs Claude Code headless with stream-json in and out (`--permission-prompt-tool stdio`, `--permission-mode acceptEdits`), streams its replies and steps, shows its screenshots inline, and turns approval requests into Allow / Always allow / Deny cards. The session id and transcript live in the app folder (`.leafdeck-session.json`, `.leafdeck-chat.jsonl`); idle sessions stop after 15 minutes and resume on the next message, and **Open in terminal** resumes the same conversation with `claude --resume`.
- **Native look:** `/_leafdeck/app.css` mirrors Leafdeck's own styles (stat tiles, boards, tables, sheets, pills, segmented controls), `leafdeck.toolbar.set()` puts an app's controls in its window title bar, and `leafdeck.icon()` / `data-icon` give it Leafdeck's line icons. The guide's "Look native" section tells the agent to build that way.
- **Permissions:** `<collection>:read`/`:write`, `notify` and `network:<host>`. Leafdeck asks you before an app runs and again when it asks for more.
- **Agent tools:** every Start building / Continue / Send session is connected automatically with a builder-scoped token (Claude Code via `--mcp-config .leafdeck-mcp.json`, Codex via `.codex/config.toml` + `LEAFDECK_MCP_TOKEN`); Claude Code control doesn't need to be on. That scope has `leafdeck_app_guide`, `leafdeck_app_list`, `leafdeck_app_create`, `leafdeck_app_open`, `leafdeck_app_logs`, `leafdeck_records`, and the screenshot, snapshot and click tools on `user:<id>` windows only: no desktop or site windows, no `leafdeck_open`/`leafdeck_navigate`/`leafdeck_evaluate`. The full token from Claude Code control still gets everything.
- **Safety nets:** a version is saved each time an agent session starts (restore in App Builder), removed apps go to `Leafdeck Apps.trash`, and **Apps can run** in App Builder turns every app off.
- **Testing:** `LEAFDECK_APPS_DIR` points Leafdeck at another apps folder.

## Site Editor

A hands-on way to work on a site in development with Claude. Open **Site Editor**, pick one of your Claude Code projects and the address its dev server runs at; the page opens in the window with an edit layer over it.

- **Select** (S): click an element and a short inspector shows its text, type, color, fill, spacing, radius, border, shadow and opacity. Change a value and the page shows it right away (nothing in the project changes yet). ↑ selects the parent. **Text** is edited in place: double-click an element (or Enter, or **Edit text** on its selection) and type; links, bold and other inline formatting inside stay as they are, and pasted text comes in as text. Plain text also has a box in the inspector. Each change remembers where its current value comes from: the rule that set it and, through the dev server's source maps or Vite's `data-vite-dev-id`, the file and line, so Claude edits the right place.
- **Comment** (C): click where the comment goes and tell Claude what you want there. Comments pin to their element (they survive reloads and navigation), and Claude's answers thread under the pin; reply, or resolve it when it's done.
- **Send to Claude**: the Changes and Comments tabs list what's pending. Sending writes a hand-off (`spec.md` with each change's before → after and source, a picture of the page with the numbered pins, a crop of each changed element) and tells Claude to put it into the source. Claude works in the project's folder with your usual Claude Code settings. When its turn ends the page reloads, each change is checked against the page (applied, or not), and the replies arrive. The **Claude** tab is the conversation; anything you type there carries the pending edits too. The hand-off and the editor's state live in Leafdeck's profile, not in your project.
- **Designer, round trip**: **Edit in Designer** on a selected element captures it (with its hover, focus and pressed states) into Leafdeck Designer; when the redesign is done, **Send back to site** puts it on the page as a change, and the hand-off points Claude at the design's folder with its full spec.

## Designer

Design one UI element at a time (a button, a menu, an input field) on a Figma-style canvas, or capture one from anywhere, then hand it to Claude to build. Open **Designer** from the Dock or the search.

- **Editing, the Figma way:** frames (F), rectangles (R), ellipses (O) and text (T) on an infinite canvas (Space or the middle button pans, Ctrl+scroll or a pinch zooms, Shift+1 fits). Click selects a top-level frame's child, double-click goes deeper, Ctrl+click goes to the deepest layer; drag to move with smart guides, into another frame to put it there, or within an auto layout to reorder; handles resize (Shift keeps proportions, Alt from the center); Alt+drag duplicates; Alt (hover) measures distances. **Auto layout** (Shift+A) is CSS flexbox: direction, gap (or Auto for space-between), padding and the 3×3 alignment grid, with Fixed / Hug / Fill sizing. The Design panel has position and size, auto layout, opacity, radius and blend, text (font, weight, size, line height, letter spacing, alignment, decoration, case), several fills (solid, linear and radial gradients, images, raw CSS), stroke (inside, center or outside), shadows and blurs, the HTML element a frame becomes (`<button>`, `<input>`, `<label>`…), HTML attributes, any other CSS, and the CSS of the selected layer. Number fields take math (`120+16`), arrow keys, and scrubbing (drag the label). The Layers panel has the tree, eye and lock, rename (double-click or Ctrl+R) and drag to reorder or nest. Undo, copy and paste (also between designs), group (Ctrl+G), and the rest of Figma's shortcuts work.
- **States:** a component's states (hover, pressed, focus, disabled, checked, selected, open, error, or any name) are copies of it you change freely; the code gets the differences as `:hover`, `:active`, `:focus-visible` (`:focus-within` around a field), `[aria-checked="true"]`, `.is-loading`…
- **Capturing from a window:** **Capture** (C) lists the open site windows, the apps you built, and Leafdeck itself; click an element (↑ ↓ pick its parent or child, Enter takes it, Esc cancels). Right-clicking in a site window has **Capture Element in Designer…** too. Designer takes the element's drawn tree with its computed styles and turns it into editable layers: flex containers become auto layout, evenly stacked blocks a vertical one, text becomes text layers with their formatting, a button's label is centered in its padding, buttons hug their content, and plain wrapper `<div>`s melt away. Through Chromium's debugger it moves the pointer off the element and forces `:hover`, `:focus-visible` and `:active` one at a time (focus on the field inside a label), so the site's real states come along as state frames. Its images and the web fonts it uses are fetched with the site's own session and saved with the design, and a screenshot of the original sits under it for comparison. Capturing runs in an isolated world: the page's scripts never see it.
- **Anything else:** **Capture the Screen** takes a picture of any window or screen (all of Leafdeck OS's screen, without Designer in the way); select the element, and **Rebuild as layers with Claude** has Claude recreate it as HTML that Designer turns into editable layers. **From Another Browser** gives a bookmarklet for Chrome, Edge or Firefox: click it on a site, click an element, and paste it into Designer. Paste also takes HTML (rendered without scripts, then captured), SVG (cleaned of scripts and handlers), images and copied layers; or drop image, SVG and HTML files on the canvas.
- **Hand-off and Claude:** the **Build** tab has what the selected component should do, what to build it as (HTML + CSS, React, React + Tailwind, Vue, Svelte, a web component or a Leafdeck app), a live preview where the states are real CSS (hover it, tab to it), the generated HTML and CSS, and a prompt for any AI. **Build with Claude** (the **Claude** tab is a chat, like App Builder's) writes the hand-off into the design's folder (`handoff/spec.md`, `component.html`, `styles.css`, `preview.png`, `original.png`) and asks Claude to build it in `build/`; `build/index.html` shows live in the Build tab (it runs at `leafdesign://<id>/`, sandboxed, with scripts allowed from a few CDNs). Claude can also change the design itself: it edits `design.json` (the format is in `DESIGN.md` in each folder) and Designer reloads it, with Undo.
- **Where designs live:** `Documents\Leafdeck Designs\<id>` (`design.json`, `assets/`, `thumb.png`, `handoff/`, `build/`), saved as you work; in a browser tab, the browser's own storage (no capturing from other windows there, but templates, paste and the hand-off work).

### Graphic Designer

Designer's other half, for artwork rather than UI: logos, illustrations, posters, social posts and print. Switch to it on Designer's home screen. A simpler Illustrator:

- **Drawing:** artboards (presets from business cards to posters, any number per document), the Pen (P) and Pencil (N), live rectangles, ellipses, polygons and stars with corner handles (drag a rectangle's corner handle to round it, Alt for one corner), **live corners** on any path (a dot by each corner: drag it inward to round that corner, even beside curves; select several anchors to round them together; the anchor stays put and editable, and Expand bakes the rounding in), lines with arrowheads, point and area type with case and underline, placed pictures (with brightness, contrast, saturation, hue, sepia and more, and **Crop**). Scissors (C) cut a path where you click; the **Shape Builder** (Shift+M) works like Illustrator's: select overlapping shapes, click a region where they overlap (or don't) to make it a shape of its own, drag across regions to merge them, Alt to erase them, and what's left of the other shapes stays cut back; Direct Selection (A) edits anchors and handles; Join, Simplify, Outline Stroke, Convert to Path, compound paths, clipping masks and the Pathfinder (Unite, Minus Front, Intersect, Exclude, Divide) are in the **Object** menu and the Properties panel.
- **Color:** solid colors and linear or radial gradients for fills and strokes, with the Gradient tool (G): drag across a shape to lay one, then move its ends and color stops on the canvas. Swatches, the colors already in the artwork, the eyedropper (I), opacity and blend modes, drop and inner shadows, glows and blur.
- **Precision:** rulers (Ctrl+R) in the document's units (px, pt, in, mm, cm; type `2in` or `30mm` in any length field), guides dragged out of the rulers (Ctrl+; shows them, Ctrl+Alt+; locks them, Ctrl+5 puts guides around the selection), a grid with snapping (Ctrl+'), smart guides to edges and centers (Ctrl+U), snapping to whole pixels, a reference point for the Transform fields, align and distribute, **Transform…** (move, scale and rotate by numbers, with copies), and Ctrl+D: move, turn or scale a duplicate and the next Ctrl+D repeats that step (rows, rings, cascades). **Select › Same** picks everything with the same fill, stroke, opacity, kind or font.
- **Around the canvas:** the context bar shows where you are (inside which group), the tool's options and what the modifier keys do; `?` lists every shortcut; the **View** menu has the view settings. Export (Ctrl+Shift+E) to PNG, JPG, SVG or PDF, one artboard, all of them, or the selection, at 0.5× to 4×.

## Connected calendars

Calendar → **Calendars** (or Settings → Connected calendars).

- **Google Calendar (two-way).** Your Google events appear in Leafdeck's Calendar, widgets, Deadlines and search, in each calendar's color. Editing or deleting one in Leafdeck updates Google. New events have a **Calendar** field: choose a Google calendar, or keep the event in Leafdeck only. Pick the default calendar for new events in the Calendars panel.
- **Calendar links (read-only).** Paste any `.ics` or `webcal://` link: iCloud, Outlook, Fastmail, Proton, holiday calendars and so on. Repeating events, exceptions and time zones (including Outlook's Windows zone names) are handled.
- **Sync.** Your Worker syncs every 15 minutes, even when Leafdeck is closed, and you can press **Sync now** at any time. Events from 60 days back to a year ahead are kept. Leafdeck-only details you add to a synced event, such as a linked contact or workspace, are kept.
- **Tokens** are encrypted in D1 with the `TOKEN_KEY` secret and never sent to the app. Disconnecting removes the events from Leafdeck but not from the calendar. To fully revoke Google access, go to myaccount.google.com → Security → Third-party access.

### Setting up Google sign-in (one time)

1. In [Google Cloud Console](https://console.cloud.google.com), create a project and enable the **Google Calendar API**.
2. In **Google Auth Platform** (OAuth consent screen), choose **External**, add yourself as a test user, then set the app to **In production**. Otherwise Google signs you out every 7 days. Google shows an "unverified app" warning once; choose **Advanced → Continue**.
3. Create an **OAuth client ID** of type **Web application**. Add the redirect URI shown in Leafdeck's setup panel: `http://localhost:8787/oauth/google/callback` for local development, plus `https://<your-worker>/oauth/google/callback` once deployed.
4. Add the credentials:
   - **Locally:** set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.dev.vars` (which also holds a generated `TOKEN_KEY`), then restart `npm run dev`.
   - **Deployed:** run `npx wrangler secret put TOKEN_KEY` (32 random bytes, base64), `npx wrangler secret put GOOGLE_CLIENT_ID` and `npx wrangler secret put GOOGLE_CLIENT_SECRET`.

If the Worker is behind Cloudflare Access, Google's redirect has to reach it: add an Access application for the path `/oauth/*` with a **Bypass** policy. The callback is protected by its own one-time, 15-minute sign-in code.

## Lock it down

This holds business data, so protect it before you use it for real:

- **Recommended:** put the Worker behind **Cloudflare Access** (Zero Trust → Access → Applications → Self-hosted) and allow only your email.
- **Optional extra:** `npx wrangler secret put API_TOKEN`. Every `/api` call then needs that token, and the browser asks for it once.

## How it's built

- `src/index.js` is the Worker: `/api/*` is a generic document store, with records saved as JSON per `(collection, id)` in D1. Everything else is served from static assets.
- `public/js/wm.js` is the window manager, Dock, menus, and toasts.
- `public/js/schemas.js` defines every record type's fields. The record editor sheets are generated from these definitions, so you add a field there and it shows up in the form.
- `public/js/apps/` holds the apps. Most of them are built with `collectionApp()` (list and board views, filters, summary stats).
- If the API can't be reached (for example, when you open `index.html` directly), data falls back to browser storage.
- Settings → Data has JSON export/import for backups.

## License

Leafdeck is free to use, change and share for any noncommercial purpose under the
[PolyForm Noncommercial License 1.0.0](LICENSE). Personal use, study, research, charities, schools and government
bodies all count as noncommercial. Using it to make money, or inside a business, needs a separate license from
Cary Digital Design. The vendored libraries in `public/vendor/` and the Designer icons keep their own licenses.

# Building a Leafdeck app

You are building a **Leafdeck app**: a small web app (HTML, CSS, JavaScript) that runs inside Leafdeck, a desktop-style browser for getting your work done. This folder *is* the app. `BRIEF.md` says what the user wants; read it first and ask the user about anything unclear before building something large.

## How it runs

- Leafdeck serves this folder at `leafapp://<app-id>/` in its own sandboxed window. `index.html` is the entry point.
- **Edits show up live.** Leafdeck watches this folder and reloads the app's window a moment after you save a file.
- The app is a plain web page in a locked-down sandbox:
  - No Node.js, no `require`, no file system access, and no access to Leafdeck's own code or settings.
  - **Scripts load only from this folder.** CDN `<script src="https://…">` tags are blocked. To use a library, download its file into this folder (for example `vendor/chart.umd.js`) and load it with a relative path. Prefer small, dependency-free libraries, or none.
  - There's no build step. Write browser-ready JavaScript; ES modules (`<script type="module">`) work.
  - **Network calls (`fetch`) only reach hosts declared in `manifest.json`** (see Permissions). Fonts from Google Fonts and images from any `https:` address are allowed.
- Talk to Leafdeck only through `window.leafdeck` (below). It's available as soon as the page loads.

## manifest.json

```json
{
  "name": "Lead Follow-ups",
  "description": "Every lead and when you last talked, with reminders.",
  "version": "0.1.0",
  "icon": "users",
  "color": "green",
  "size": [1000, 700],
  "permissions": ["contacts:read", "tasks:write", "notify"]
}
```

- **`icon`:** a Leafdeck icon name: `sparkle chart award calendar note receipt heart users user check list grid target clock mail phone star key flag inbox layout card folder link globe tag bolt trend kanban leaf`. Or set `"glyph": "G"` to show a letter instead.
- **`color`:** `green teal blue indigo purple pink red orange yellow gray graphite`.
- **`size`:** the window's starting size in pixels, `[width, height]`.
- **`permissions`:** ask only for what the app needs. Each one is shown to the user, who approves it before the app runs, and again whenever the list grows.
  - `"<collection>:read"` reads one of Leafdeck's built-in collections. `"<collection>:write"` also creates, edits and deletes in it (and includes read). Collections: `tasks notes contacts sprints events bookmarks`.
  - `"notify"` shows notifications.
  - `"network:<host>"` lets `fetch` reach `https://<host>`, for example `"network:api.weather.gov"`. One host per entry.
  - `"local:<port>"` lets `fetch` reach a program of the user's own on this computer at `http://127.0.0.1:<port>` (or `localhost`), port 1024 to 65535. It's how an app gets something done outside the sandbox (running a command-line tool, reading a drive): a small helper the user runs, which serves a local API. The helper must listen on 127.0.0.1 only and accept only requests from the app's origin (`leafapp://<app-id>`, in the `Origin` header).

## The `leafdeck` API

Everything returns a Promise. Errors (such as a missing permission) reject with a readable message.

```js
const { app, theme } = await leafdeck.ready();          // app: { id, name, permissions }, theme: { dark, accent }

// The app's own data, synced to the user's other devices. No permission needed.
const clients = await leafdeck.data.list('client');      // records of one kind, newest last
const c = await leafdeck.data.save('client', { name: 'Ada', stage: 'lead' }); // returns the saved record (with id)
await leafdeck.data.save('client', { ...c, stage: 'won' }); // pass the id to update
await leafdeck.data.get(c.id);
await leafdeck.data.remove(c.id);

// Leafdeck's built-in records (needs permissions).
const open = await leafdeck.records.list('tasks', { status: 'To Do' }); // optional filter: exact field matches
const t = await leafdeck.records.save('tasks', { title: 'Send report', due: '2026-11-03', status: 'To Do', priority: 'High' });
await leafdeck.records.get('contacts', 'abc123');
await leafdeck.records.remove('tasks', t.id);

await leafdeck.notify('Follow up Friday', 'Rivera Builders');   // needs "notify"
await leafdeck.openUrl('https://example.org');                         // opens a Leafdeck site window
await leafdeck.openApp('tasks', t.id);                                 // opens a built-in app, optionally at a record
await leafdeck.setTitle('Lead Follow-ups · 3 due');                  // the window title (live status is welcome)
await leafdeck.toolbar.set([...]);                                   // controls in the title bar (see Look native)
leafdeck.icon('plus', 16);                                           // a Leafdeck icon as an SVG string

const stop = leafdeck.on('change', ({ collection }) => redraw());    // data changed (here, or on another device)
leafdeck.on('theme', ({ dark, accent }) => {});                      // light/dark or accent changed
leafdeck.on('toolbar', ({ id, value }) => {});                       // a title-bar control was used
```

**Data rules**
- Every record has `id`, `createdAt` and `updatedAt`. Keep the `id` when updating.
- A save replaces the whole record, so spread the existing one and change what you need.
- Keep each record small (under about 100 KB; a hard limit is 1 MB). Store many small records rather than one big one.
- Don't store secrets (API keys, passwords) in records. They sync to the user's server and phone.

**Built-in record shapes** (the fields Leafdeck's own apps use; keep to them so records show up properly there)
- `tasks`: `title, due ("YYYY-MM-DD"), dueTime ("HH:MM"), remindAt ("YYYY-MM-DDTHH:MM"), status ("To Do" | "In Progress" | "Done"), priority ("Low" | "Medium" | "High"), contactId, tags, notes`
- `contacts`: `name, company, type, email, phone, tags, notes`
- `events`: `title, date, time, endDate, endTime, allDay, location, notes`
- For other collections, read a few records first and copy their shape.

## Look native

The app must look and behave like one of Leafdeck's built-in apps (Tasks, Contacts, Calendar), not like a website inside a window. Someone opening it should not be able to tell it wasn't built into Leafdeck. Build from `/_leafdeck/app.css` (the starter links it) and these rules.

**Layout, the way every built-in app is laid out**
1. **Controls go in the window's title bar**, with `leafdeck.toolbar.set()` (below): view switches, search, a period or filter select, and the **+** button. Never put a header row of buttons, a search bar, or a "toolbar" at the top of the page.
2. **No page title.** The window title already shows the app's name (change it with `leafdeck.setTitle()` for live status, like `Weather · 69° Cary`). No `<h1>` with the app name, no hero, no banner, no intro text.
3. The page fills the window: `<main class="ld-page">`. No centered column or `max-width`.
4. Top to bottom: an optional row of stat tiles (`ld-summary` / `ld-stat`), then the main content: a board (`ld-board` / `ld-col` / `ld-item`), a table (`ld-table`), a list in a panel (`ld-panel` / `ld-list`), or a `ld-split` of list and detail.
5. Add and edit forms open in a **sheet** (`ld-sheet-wrap` / `ld-sheet`) that drops from the top of the window, with Cancel and a primary action in its footer. Not inline forms, not `prompt()` or `alert()`.
6. Empty states use `ld-empty` with one short line and one action. Loading and errors show quietly in the same place, never as a big red box.

**Style**
- 13px text, Inter, Leafdeck's sizes. Use the `ld-*` classes and `--ld-*` variables; don't restyle them, and don't add fonts, colors, gradients, heavy shadows, or white cards. Surfaces are quiet and translucent (`ld-panel`, `ld-stat`, `ld-item`).
- **Icons:** Leafdeck's line icons only, never emoji. `<span data-icon="plus"></span>` fills in automatically (size with `data-icon-size="20"`), or `leafdeck.icon('plus', 16)` returns the SVG. Names: `leaf user users trend kanban check tick bolt tag archive down up calendar note receipt chart heart award clock link sliders search plus x globe list grid left right external refresh trash play stop mail phone printer download upload sparkle pin dots flag inbox star key eye copy shield place folder target pause layout card`.
- One accent color: `--ld-accent` for the primary action, selection and progress. Status uses pills: `ld-pill green|blue|purple|yellow|red`. Numbers that are good or bad use `ld-stat good|bad|warn` or `--ld-green` / `--ld-red`.
- Light and dark mode and the user's accent apply automatically through the variables. Check both.
- **Accessibility:** real `<button>`s and `<label>`s, visible focus, keyboard support (Escape closes a sheet, Enter submits), readable contrast.

**Components** (`/_leafdeck/app.css`)

```html
<main class="ld-page">
  <div class="ld-summary">
    <div class="ld-stat good"><span>Won</span><b>$25,000</b><small>3 clients</small></div>
    <div class="ld-stat"><span>Pending</span><b>$30,000</b></div>
  </div>

  <div class="ld-board">
    <div class="ld-col"><header>Writing <small>1 · $10,000</small></header>
      <button class="ld-item"><b>Website refresh</b><small>Brightline Studio</small>
        <div class="ld-item-foot"><b>$10,000</b><span>Saturday</span></div></button>
      <button class="ld-add"><span data-icon="plus"></span> Add</button>
    </div>
  </div>

  <section class="ld-panel">
    <div class="ld-section-title">Payments <small>12</small></div>
    <table class="ld-table"><thead><tr><th>Date</th><th>Description</th><th class="ld-num">Amount</th></tr></thead>
      <tbody><tr><td>Oct 10</td><td>Brightline Studio<small>Checking</small></td><td class="ld-num">+$12,500.00</td></tr></tbody></table>
  </section>
</main>
```

Also: `ld-list` (rows with hover; `ld-sub` for a second line), `ld-split`, `ld-grid`, `ld-row`, `ld-grow`, `ld-btn` (`ld-primary`, `ld-small`, `ld-danger`), `ld-icon-btn`, `ld-add`, `ld-seg` (in-page segmented control; buttons get `.on`), `ld-field` + `ld-form-grid` (label above input; `ld-span2`, `ld-check`), `ld-input ld-select ld-textarea`, `ld-pill`, `ld-chip`, `ld-bar` (progress: `<div class="ld-bar"><span style="width:40%"></span></div>`), `ld-empty` / `ld-empty-title`, `ld-section-title`, `ld-muted`, `ld-small-text`. Sheets:

```html
<div class="ld-sheet-wrap" hidden><form class="ld-sheet">
  <div class="ld-sheet-head"><h2>New lead</h2></div>
  <div class="ld-sheet-body"><div class="ld-form-grid">
    <label class="ld-field"><span>Name</span><input name="name" required></label>
    <label class="ld-field"><span>Amount</span><input name="amount" type="number"></label>
  </div></div>
  <div class="ld-sheet-foot"><button type="button" class="ld-btn" data-close>Cancel</button><button class="ld-btn ld-primary">Save</button></div>
</form></div>
```
Show a sheet by removing `hidden`, then adding `.open` on the next frame (`requestAnimationFrame`); close by removing `.open`, then setting `hidden` after 180 ms. The starter's `app.js` does exactly this.

**The title-bar toolbar**

```js
leafdeck.toolbar.set([
  { type: 'segmented', id: 'view', value: 'board', options: [{ value: 'board', icon: 'kanban', title: 'Board' }, { value: 'list', icon: 'list', title: 'List' }] },
  { type: 'select', id: 'period', value: 'month', options: [{ value: 'month', label: 'This month' }, { value: 'year', label: 'This year' }] },
  { type: 'search', id: 'q', placeholder: 'Search leads' },
  { type: 'button', id: 'add', icon: 'plus', title: 'New lead' },          // an icon button, like built-in apps' +
  // { type: 'button', id: 'export', label: 'Export', icon: 'download' },   // a labeled pill; add primary: true for the accent color
]);
leafdeck.on('toolbar', ({ id, value }) => { /* segmented/select/search send a value; buttons send just the id */ });
```
- Up to 8 controls. Segmented options with an `icon` show just the icon (`title` is the tooltip); without one they show `label`.
- Calling `set()` again replaces the toolbar (search keeps its text and focus). Keep `value` in step with your state when you redraw. The toolbar resets when the app reloads, so set it on every start.
- Search sends its value as you type; Enter also sends `{ id, value, submit: true }`. Escape clears it.

## Your build–test loop

Leafdeck's tools (`leafdeck_*`) are connected to this session through App Builder. Use them to check your work; don't assume it works. The connection is limited to the apps you build: you can open, screenshot and drive `user:<id>` windows and read app logs and the user's records, but not Leafdeck's own desktop or websites.
1. `leafdeck_app_open` with this app's id (the folder name). It opens or reloads the app and returns its window id (`user:<id>`).
2. `leafdeck_app_logs` reads the app's console output and errors. Check it after every change.
3. `leafdeck_screenshot` shows the window (window id `user:<id>`). `leafdeck_snapshot`, `leafdeck_click`, `leafdeck_fill` and `leafdeck_type` drive it like a user would.
4. Compare each screenshot with **Look native** above: controls in the title bar, no page title, Leafdeck icons (no emoji), quiet surfaces, sheets for forms. Fix anything that looks like a website rather than a Leafdeck app.
5. Fix, save (Leafdeck reloads it), check again.

If no `leafdeck_*` tools are available, the session wasn't started from App Builder: ask the user to start it with “Start building” (or “Continue”) in Leafdeck's App Builder, which connects the tools automatically.

Each new permission makes Leafdeck ask the user before the app runs again. If a screenshot shows a permission prompt, ask the user to approve it in Leafdeck; never try to click it yourself.

## Rules

- Stay inside this folder. Don't modify Leafdeck itself or other apps.
- Never write to built-in collections without the user asking for it, and never delete their records in bulk.
- Don't send the user's data anywhere except hosts the brief explicitly calls for.
- Keep `manifest.json` accurate: name, description, and only the permissions you use.
- Keep the code readable: `index.html` for structure, `app.js` (or modules) for logic, `style.css` for styles.
- When you finish a meaningful step, tell the user what changed and what to try.

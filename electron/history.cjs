// Browsing history — a local SQLite database that mirrors the shared history on the Worker.
// Visits made here are queued (synced = 0) and uploaded by the UI (public/js/devices.js); visits from
// other devices arrive through applyRemote(). Burner windows are never recorded (see main.cjs).
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const { userFile, isWebUrl, hostOf } = require('./common.cjs');

let db = null;
const REVISIT_MS = 10 * 60 * 1000; // repeat visits within 10 minutes update the same row

function open() {
  if (db) return db;
  db = new DatabaseSync(userFile('history.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS visits (
      id INTEGER PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      host TEXT NOT NULL DEFAULT '',
      visited_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS visits_time ON visits (visited_at);
    CREATE INDEX IF NOT EXISTS visits_url ON visits (url);
  `);
  // Shared-history columns, added to databases from before the companion app.
  const cols = new Set(db.prepare('PRAGMA table_info(visits)').all().map((c) => c.name));
  if (!cols.has('uid')) db.exec('ALTER TABLE visits ADD COLUMN uid TEXT'); // the id other devices know this visit by
  if (!cols.has('device')) db.exec("ALTER TABLE visits ADD COLUMN device TEXT NOT NULL DEFAULT ''"); // '' = this computer
  if (!cols.has('device_name')) db.exec("ALTER TABLE visits ADD COLUMN device_name TEXT NOT NULL DEFAULT ''");
  if (!cols.has('synced')) db.exec('ALTER TABLE visits ADD COLUMN synced INTEGER NOT NULL DEFAULT 0');
  // Older rows get an id so they upload too (history is shared from now on).
  const fill = db.prepare('UPDATE visits SET uid = ? WHERE id = ?');
  for (const r of db.prepare('SELECT id FROM visits WHERE uid IS NULL').all()) fill.run(randomUUID(), r.id);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS visits_uid ON visits (uid); CREATE INDEX IF NOT EXISTS visits_synced ON visits (synced)');
  return db;
}

function addVisit(url, title = '') {
  if (!isWebUrl(url)) return;
  const d = open();
  const now = Date.now();
  const recent = d.prepare("SELECT id FROM visits WHERE url = ? AND device = '' AND visited_at > ? ORDER BY visited_at DESC LIMIT 1").get(url, now - REVISIT_MS);
  if (recent) d.prepare("UPDATE visits SET visited_at = ?, title = CASE WHEN ? = '' THEN title ELSE ? END, synced = 0 WHERE id = ?").run(now, title, title, recent.id);
  else d.prepare('INSERT INTO visits (uid, url, title, host, visited_at, synced) VALUES (?, ?, ?, ?, ?, 0)').run(randomUUID(), url, title, hostOf(url), now);
}

function setTitle(url, title) {
  if (!isWebUrl(url) || !title) return;
  const d = open();
  const row = d.prepare("SELECT id FROM visits WHERE url = ? AND device = '' ORDER BY visited_at DESC LIMIT 1").get(url);
  if (row) d.prepare('UPDATE visits SET title = ?, synced = 0 WHERE id = ?').run(title, row.id);
}

const like = (q) => `%${String(q).replace(/[\\%_]/g, (c) => '\\' + c)}%`;

/** Distinct URLs matching every word, most recent first (for search suggestions). */
function search(q, limit = 8) {
  const words = String(q || '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!words.length) return [];
  const where = words.map(() => "(url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')").join(' AND ');
  const args = words.flatMap((w) => [like(w), like(w)]);
  return open()
    .prepare(`SELECT url, title, host, MAX(visited_at) AS visitedAt, COUNT(*) AS visits FROM visits WHERE ${where} GROUP BY url ORDER BY visitedAt DESC LIMIT ?`)
    .all(...args, limit);
}

/** Visit list for the History app, newest first, optionally filtered. */
function list({ q = '', before = Date.now() + 1, limit = 300 } = {}) {
  const words = String(q || '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
  const where = ['visited_at < ?', ...words.map(() => "(url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')")].join(' AND ');
  const args = [before, ...words.flatMap((w) => [like(w), like(w)])];
  return open()
    .prepare(`SELECT id, uid, url, title, host, visited_at AS visitedAt, device AS deviceId, device_name AS deviceName FROM visits WHERE ${where} ORDER BY visited_at DESC LIMIT ?`)
    .all(...args, limit);
}

/** Removes a visit; returns its shared id so the UI can delete it on the server too. */
function removeVisit(id) {
  const d = open();
  const row = d.prepare('SELECT uid FROM visits WHERE id = ?').get(id);
  d.prepare('DELETE FROM visits WHERE id = ?').run(id);
  return row?.uid || null;
}

/** Delete visits since a timestamp (0 = everything). The UI clears the server's copy as well. */
function clear(since = 0) {
  open().prepare('DELETE FROM visits WHERE visited_at >= ?').run(since);
  if (!since) open().exec('VACUUM');
}

/* ---------------- Sharing with other devices ---------------- */

/** Visits made here that the server hasn't seen yet, in the shape POST /api/history/_bulk takes. */
function pending(limit = 500) {
  return open()
    .prepare("SELECT uid AS id, url, title, host, visited_at AS visitedAt FROM visits WHERE synced = 0 AND device = '' ORDER BY visited_at LIMIT ?")
    .all(limit);
}

function markSynced(uids) {
  const d = open();
  const stmt = d.prepare('UPDATE visits SET synced = 1 WHERE uid = ?');
  for (const u of uids || []) stmt.run(String(u));
}

/** Visits (and deletions) from other devices, as /api/changes delivers them. Returns how many rows changed. */
function applyRemote(visits) {
  const d = open();
  const del = d.prepare('DELETE FROM visits WHERE uid = ?');
  const put = d.prepare(`INSERT INTO visits (uid, url, title, host, visited_at, device, device_name, synced) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT (uid) DO UPDATE SET title = CASE WHEN excluded.title = '' THEN title ELSE excluded.title END,
      visited_at = MAX(visited_at, excluded.visited_at), device_name = excluded.device_name`);
  let n = 0;
  for (const v of visits || []) {
    if (!v || typeof v.id !== 'string') continue;
    if (v.deleted) {
      n += del.run(v.id).changes;
      continue;
    }
    if (!isWebUrl(v.url)) continue;
    put.run(v.id, v.url, String(v.title || ''), String(v.host || hostOf(v.url)), Number(v.visitedAt) || Date.now(), String(v.deviceId || 'remote'), String(v.deviceName || ''));
    n++;
  }
  return n;
}

/* ---------------- Moving to another computer ---------------- */

/** Every visit, for a move file. */
const exportVisits = () =>
  open().prepare('SELECT uid, url, title, host, visited_at AS visitedAt, device, device_name AS deviceName, synced FROM visits ORDER BY visited_at').all();

/**
 * Visits from another computer's move file. Its own visits are kept as that computer's (by name), and are not uploaded
 * from here: that computer shares them itself. Visits already here (same id) are left alone.
 */
function importVisits(rows, fromComputer = '') {
  const d = open();
  const put = d.prepare(`INSERT INTO visits (uid, url, title, host, visited_at, device, device_name, synced) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT (uid) DO NOTHING`);
  let n = 0;
  d.exec('BEGIN');
  try {
    for (const v of rows || []) {
      if (!v || !isWebUrl(v.url)) continue;
      const own = !v.device;
      n += put.run(String(v.uid || randomUUID()), v.url, String(v.title || ''), String(v.host || hostOf(v.url)), Number(v.visitedAt) || Date.now(),
        own ? 'moved' : String(v.device), own ? String(fromComputer) : String(v.deviceName || '')).changes;
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  return n;
}

function close() {
  db?.close();
  db = null;
}

module.exports = { addVisit, setTitle, search, list, removeVisit, clear, pending, markSynced, applyRemote, exportVisits, importVisits, close };

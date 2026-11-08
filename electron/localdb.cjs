// Leafdeck's data on this computer: the Worker's API (src/) running in the main process against SQLite.
// Records, connected calendars and note media live in the profile folder (leafdeck.db, media/); no server is needed.
// The Worker code runs unchanged: SQLite stands in for D1, a folder for the R2 media bucket, and a timer for its cron.
// Google sign-in comes back to a loopback address (http://127.0.0.1:<port>/oauth/google/callback), as Google asks of
// desktop apps.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const WORKER = path.join(__dirname, '..', 'src', 'index.js');
const SYNC_MS = 15 * 60_000; // as the Worker's cron

let deps = null; // { dir, secret(key), setSecret(key, value) }
let db = null;
let env = null;
let worker = null;
let loopback = null; // Promise<origin>

/* ---------------- D1 on SQLite ---------------- */

// D1 accepts booleans and undefined; SQLite takes 1/0 and null.
const value = (v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v);

class Statement {
  constructor(sql, args = []) {
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new Statement(this.sql, args.map(value));
  }
  exec() {
    const r = db.prepare(this.sql).run(...this.args);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async first(column) {
    const row = db.prepare(this.sql).get(...this.args) ?? null;
    return column && row ? row[column] : row;
  }
  async all() {
    return { success: true, results: db.prepare(this.sql).all(...this.args), meta: {} };
  }
  async run() {
    return this.exec();
  }
}

const D1 = {
  prepare: (sql) => new Statement(sql),
  // A D1 batch is one transaction.
  async batch(statements) {
    db.exec('BEGIN');
    try {
      const out = statements.map((s) => (/^\s*select/i.test(s.sql) ? { results: db.prepare(s.sql).all(...s.args) } : s.exec()));
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  },
};

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const done = new Set(db.prepare('SELECT name FROM _migrations').all().map((r) => r.name));
  for (const name of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(name)) continue;
    db.exec('BEGIN');
    try {
      db.exec(fs.readFileSync(path.join(MIGRATIONS, name), 'utf8'));
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, Date.now());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/* ---------------- R2 on a folder ---------------- */

function bucket(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (key) => path.join(dir, key.replace(/[^\w.-]/g, '_'));
  return {
    async put(key, buf, opts = {}) {
      fs.writeFileSync(file(key), Buffer.from(buf));
      fs.writeFileSync(file(key) + '.json', JSON.stringify({ contentType: opts.httpMetadata?.contentType || 'application/octet-stream' }));
    },
    async get(key) {
      let body;
      try {
        body = fs.readFileSync(file(key));
      } catch {
        return null;
      }
      let meta = {};
      try {
        meta = JSON.parse(fs.readFileSync(file(key) + '.json', 'utf8'));
      } catch {}
      return {
        body,
        size: body.length,
        httpEtag: `"${key}"`,
        writeHttpMetadata: (headers) => headers.set('content-type', meta.contentType || 'application/octet-stream'),
      };
    },
    async has(key) {
      return fs.existsSync(file(key));
    },
  };
}

/* ---------------- secrets ---------------- */

// The key connected accounts' tokens are sealed with: made once per computer and kept with Leafdeck's other secrets.
function tokenKey() {
  let key = deps.secret('tokenKey');
  if (!key) {
    key = crypto.randomBytes(32).toString('base64');
    deps.setSecret('tokenKey', key);
  }
  return key;
}

/* ---------------- Google's redirect ---------------- */

// Google sends the browser back to 127.0.0.1 after sign-in. Only the callback is served there; the API is not.
function loopbackOrigin() {
  loopback ||= new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method !== 'GET' || url.pathname !== '/oauth/google/callback') {
        res.writeHead(404).end('Not found');
        return;
      }
      const out = await call(new Request(`${origin}${url.pathname}${url.search}`));
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
    });
    let origin = '';
    server.on('error', (err) => {
      loopback = null;
      reject(err);
    });
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve(origin);
    });
    server.unref();
  });
  return loopback;
}

/* ---------------- the API ---------------- */

const ctx = { waitUntil: (p) => Promise.resolve(p).catch((err) => console.error('[localdb]', err)) };

async function call(request) {
  worker ||= (await import(pathToFileURL(WORKER).href)).default;
  return worker.fetch(request, env, ctx);
}

function open(options) {
  deps = options;
  fs.mkdirSync(deps.dir, { recursive: true });
  db = new DatabaseSync(path.join(deps.dir, 'leafdeck.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000');
  migrate();
  env = {
    DB: D1,
    MEDIA: bucket(path.join(deps.dir, 'media')),
    LOCAL: true,
    get TOKEN_KEY() {
      return tokenKey();
    },
    get GOOGLE_CLIENT_ID() {
      return deps.secret('googleClientId');
    },
    get GOOGLE_CLIENT_SECRET() {
      return deps.secret('googleClientSecret');
    },
  };
  // Keep connected calendars in sync and prune old rows, as the Worker's cron did (while the computer is awake).
  const tick = () => worker?.scheduled?.({}, env, ctx);
  setTimeout(() => call(new Request('http://local/api/integrations')).then(tick).catch(() => {}), 30_000).unref();
  setInterval(tick, SYNC_MS).unref();
}

/** Answers leafdeck://app/api/… from the local database. */
async function handle(request, url) {
  // Google sign-in starts here and must come back to the loopback address, so the API sees that as its origin.
  const google = url.pathname === '/api/integrations/google/start';
  const origin = google ? await loopbackOrigin() : 'http://local';
  const init = { method: request.method, headers: request.headers };
  if (!['GET', 'HEAD'].includes(request.method)) init.body = await request.arrayBuffer();
  try {
    return await call(new Request(origin + url.pathname + url.search, init));
  } catch (err) {
    console.error('[localdb]', err);
    return Response.json({ error: err.message || 'Internal error' }, { status: 500 });
  }
}

/* ---------------- one-time import from a Leafdeck server ---------------- */

/**
 * Copies everything from a Leafdeck server (the Worker) into this computer, replacing what's here: records, and the
 * note images and voice memos they use. Events from connected calendars are left out; they come back when the
 * calendar is connected here. fetchServer(path) → Response, with the server's sign-in.
 */
async function importFromServer(fetchServer) {
  const res = await fetchServer('/api/data');
  if (!(res.headers.get('content-type') || '').includes('json')) throw new Error('That address isn’t a Leafdeck server');
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `The server answered ${res.status}`);
  }
  const { collections = {} } = await res.json();
  if (collections.events) collections.events = collections.events.filter((e) => !e?.ext?.connectionId);

  // Note media are referenced by id inside the notes' content.
  const ids = new Set(JSON.stringify(collections.notes || []).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) || []);
  let media = 0;
  let missing = 0;
  for (const id of ids) {
    if (await env.MEDIA.has(id)) {
      media++;
      continue;
    }
    const r = await fetchServer(`/api/media/${id}`).catch(() => null);
    if (!r?.ok) {
      if (r?.status !== 404) missing++;
      continue;
    }
    await env.MEDIA.put(id, await r.arrayBuffer(), { httpMetadata: { contentType: r.headers.get('content-type') } });
    media++;
  }

  // Written here rather than through POST /api/import, which takes at most 1 MB.
  const now = Date.now();
  const upsert = db.prepare(
    `INSERT INTO records (collection, id, data, created_at, updated_at, deleted) VALUES (?1, ?2, ?3, ?4, ?4, 0)
     ON CONFLICT (collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, deleted = 0`,
  );
  let records = 0;
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM records');
    for (const [name, rows] of Object.entries(collections)) {
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(name) || !Array.isArray(rows)) continue;
      for (const row of rows) {
        if (!row || !/^[A-Za-z0-9_-]{1,64}$/.test(row.id)) continue;
        upsert.run(name, row.id, JSON.stringify(row), now);
        records++;
      }
    }
    db.exec("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'epoch'");
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { records, media, missing };
}

module.exports = { open, handle, importFromServer };

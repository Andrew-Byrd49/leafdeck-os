import { uid, debounce } from './util.js';

const LS_DATA = 'ws:data';
const LS_TOKEN = 'ws:token';

/**
 * In-memory copy of every collection, synced to the Worker's D1 API.
 * Falls back to browser storage when the API is unreachable (e.g. opening the HTML directly).
 * Emits `change` ({ detail: { col } }) and `status` events.
 */
class Store extends EventTarget {
  data = {};
  mode = 'local';
  local = false; // the app keeps the data on this computer (electron/localdb.cjs), not on a server
  status = 'idle';
  #queue = Promise.resolve();

  async api(path, opts = {}) {
    const headers = { 'content-type': 'application/json' };
    const tok = localStorage.getItem(LS_TOKEN);
    if (tok) headers['x-api-token'] = tok;
    const res = await fetch('/api' + path, { ...opts, headers });
    if (res.status === 401) {
      // Electron has no prompt(); there the token is entered in Settings → Data.
      const t = window.desktopShell ? null : prompt('This desktop is protected. Enter the API token:');
      if (t) {
        localStorage.setItem(LS_TOKEN, t.trim());
        return this.api(path, opts);
      }
      // Say whether it was the API token or Cloudflare Access (the app's proxy explains the latter).
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error && body.error !== 'Unauthorized' ? body.error : 'API token missing or wrong');
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw Object.assign(new Error(body.error || res.statusText), { status: res.status, body });
    }
    return res.json();
  }

  async load() {
    try {
      const j = await this.api('/data');
      this.data = j.collections || {};
      this.epoch = j.epoch || 1;
      this.cursor = j.cursor || 0; // server time the full copy is good to; later changes come through pull()
      this.mode = 'cloud';
      this.local = !!j.local;
      this.setStatus('saved');
    } catch (err) {
      console.warn('API unavailable, using browser storage:', err.message);
      this.loadError = err.message;
      try {
        this.data = JSON.parse(localStorage.getItem(LS_DATA)) || {};
      } catch {
        this.data = {};
      }
      this.mode = 'local';
      this.setStatus('local');
    }
  }

  setStatus(s, message) {
    this.status = s;
    this.dispatchEvent(new CustomEvent('status', { detail: { status: s, message } }));
  }

  emit(col) {
    this.dispatchEvent(new CustomEvent('change', { detail: { col } }));
  }

  all(col) {
    return (this.data[col] ||= []);
  }

  get(col, id) {
    return id ? this.all(col).find((r) => r.id === id) : undefined;
  }

  save(col, rec) {
    const list = this.all(col);
    const now = Date.now();
    const r = { ...rec, id: rec.id || uid(), createdAt: rec.createdAt || now, updatedAt: now };
    const i = list.findIndex((x) => x.id === r.id);
    if (i >= 0) list[i] = r;
    else list.push(r);
    this.emit(col);
    this.#persist('PUT', col, r);
    return r;
  }

  /** Insert/update many records with one change event and batched API calls (used by imports). */
  saveMany(col, recs) {
    const list = this.all(col);
    const now = Date.now();
    const saved = recs.map((rec) => ({ ...rec, id: rec.id || uid(), createdAt: rec.createdAt || now, updatedAt: now }));
    const index = new Map(list.map((r, i) => [r.id, i]));
    for (const r of saved) {
      if (index.has(r.id)) list[index.get(r.id)] = r;
      else list.push(r);
    }
    this.emit(col);
    if (this.mode !== 'cloud') {
      this.#writeLocal();
      return saved;
    }
    this.setStatus('saving');
    for (let i = 0; i < saved.length; i += 400) {
      const chunk = saved.slice(i, i + 400);
      this.#queue = this.#queue.then(() => this.api(`/${col}/_bulk`, { method: 'POST', body: JSON.stringify(chunk) }));
    }
    this.#queue = this.#queue.then(() => (this.setStatus('saved'), this.#tellPages())).catch((err) => this.setStatus('error', err.message));
    return saved;
  }

  remove(col, id) {
    const list = this.all(col);
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return;
    list.splice(i, 1);
    this.emit(col);
    this.#persist('DELETE', col, { id });
  }

  async replaceAll(collections) {
    this.data = structuredClone(collections);
    if (this.mode === 'cloud') {
      this.setStatus('saving');
      try {
        await this.api('/import', { method: 'POST', body: JSON.stringify({ collections }) });
        this.setStatus('saved');
        this.#tellPages();
      } catch (err) {
        this.setStatus('error', err.message);
      }
    } else this.#writeLocal();
    this.emit('*');
  }

  get prefs() {
    return this.get('settings', 'prefs') || { id: 'prefs' };
  }

  setPrefs(patch) {
    return this.save('settings', { ...this.prefs, ...patch, id: 'prefs' });
  }

  #writeLocal = debounce(() => {
    try {
      localStorage.setItem(LS_DATA, JSON.stringify(this.data));
    } catch (err) {
      this.setStatus('error', 'Browser storage is full');
    }
  }, 250);

  #persist(method, col, rec) {
    if (this.mode !== 'cloud') return this.#writeLocal();
    this.setStatus('saving');
    // Serialize writes so they reach D1 in the order they happened.
    this.#queue = this.#queue
      .then(() =>
        this.api(`/${col}/${encodeURIComponent(rec.id)}`, {
          method,
          body: method === 'PUT' ? JSON.stringify(rec) : undefined,
        }),
      )
      .then((res) => {
        // The server may return the stored version (e.g. an event now linked to Google Calendar) and a warning.
        if (method === 'PUT' && res?.record) this.#applyServer(col, res.record);
        if (res?.warning) this.notice(res.warning);
        this.setStatus('saved');
        this.#tellPages();
      })
      .catch((err) => {
        // A refused delete (read-only calendar event): put it back.
        if (method === 'DELETE' && err.status === 409 && err.body?.record) {
          this.all(col).push(err.body.record);
          this.emit(col);
          this.notice(err.message);
          return this.setStatus('saved');
        }
        this.setStatus('error', err.message);
      });
  }

  #applyServer(col, rec) {
    const list = this.all(col);
    const i = list.findIndex((x) => x.id === rec.id);
    if (i < 0) return;
    if (JSON.stringify(list[i]) === JSON.stringify(rec)) return;
    list[i] = rec;
    this.emit(col);
  }

  /** Replace a whole collection with the server's copy (no write-back), e.g. after a calendar sync. */
  replaceCollection(col, rows) {
    if (!Array.isArray(rows)) return;
    this.data[col] = rows;
    this.emit(col);
  }

  /** A message for the user (shown as a toast by the desktop). */
  notice(message, kind = 'error') {
    this.dispatchEvent(new CustomEvent('notice', { detail: { message, kind } }));
  }

  /* ---------------- Other pages of this app (Leafdeck OS, one surface per screen: public/js/screens.js) ----------------
     Each screen's page has its own copy of the data; after a page saves, the others pull what changed. */

  #pages = typeof BroadcastChannel === 'function' ? new BroadcastChannel('leafdeck-store') : null;
  #tellT = 0;
  #tellPages() {
    if (!this.#pages) return;
    clearTimeout(this.#tellT);
    this.#tellT = setTimeout(() => this.#pages.postMessage('saved'), 50);
  }
  listenToPages() {
    if (this.#pages) this.#pages.onmessage = () => this.pull();
  }

  /* ---------------- Incremental sync (changes made on other devices) ---------------- */

  epoch = 1;
  cursor = 0;
  devices = [];
  #pulling = null;

  /**
   * Fetch what changed on the server since the last pull and merge it in (see docs/companion-api.md).
   * Emits `change` per touched collection and `sync` with the history / sends / devices parts for others to handle.
   */
  async pull() {
    if (this.mode !== 'cloud') return;
    if (this.#pulling) return this.#pulling;
    this.#pulling = this.#pull().catch((err) => console.warn('sync', err.message)).finally(() => (this.#pulling = null));
    return this.#pulling;
  }

  async #pull() {
    // Our own writes are still in flight: let them land first so we don't pull a stale copy over them.
    await this.#queue.catch(() => {});
    let more = true;
    let rounds = 0;
    while (more && rounds++ < 20) {
      const j = await this.api(`/changes?since=${this.cursor}`);
      if (j.epoch !== this.epoch) {
        // Everything was replaced (an import): start over from a full copy.
        await this.load();
        this.emit('*');
        return;
      }
      const touched = new Set();
      for (const r of j.records) {
        const list = this.all(r.collection);
        const i = list.findIndex((x) => x.id === r.id);
        if (r.data === null) {
          if (i >= 0) list.splice(i, 1);
          else continue;
        } else if (i >= 0) {
          if (JSON.stringify(list[i]) === JSON.stringify(r.data)) continue;
          list[i] = r.data;
        } else list.push(r.data);
        touched.add(r.collection);
      }
      this.cursor = Math.max(this.cursor, j.cursor || 0);
      this.devices = j.devices || this.devices;
      more = !!j.more;
      for (const col of touched) this.emit(col);
      this.dispatchEvent(new CustomEvent('sync', { detail: { history: j.history || [], sends: j.sends || [], devices: this.devices, touched: [...touched] } }));
    }
  }
}

export const store = new Store();
store.listenToPages();

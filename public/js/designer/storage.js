// Where designs live: folders in Documents/Leafdeck Designs in the Leafdeck app (electron/designer.cjs), the browser's
// own storage (IndexedDB) otherwise. Both: list(), read(id) → { doc, assets, mtime }, write(id, doc, newAssets, keep),
// stat(id), thumb(id, png), remove(id). list() says each design's kind: 'ui' (UI Designer) or 'graphic' (Graphic Designer).
import { shell } from '../shell.js';

const files = shell?.designer
  ? {
      kind: 'files',
      list: () => shell.designer.list().then((r) => r.designs),
      read: (id) => shell.designer.read(id),
      write: (id, doc, assets, keep) => shell.designer.write(id, doc, assets, keep),
      stat: (id) => shell.designer.stat(id),
      thumb: (id, png) => shell.designer.thumb(id, png),
      remove: (id) => shell.designer.remove(id),
    }
  : null;

let dbp = null;
const db = () =>
  (dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('leafdeck-designer', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('designs', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
const tx = async (mode, fn) => {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction('designs', mode);
    const out = fn(t.objectStore('designs'));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  });
};
const getRec = (id) => tx('readonly', (s) => s.get(id));

const idb = {
  kind: 'browser',
  list: async () => {
    const all = await tx('readonly', (s) => s.getAll());
    return all.map((r) => ({ id: r.id, name: r.doc?.name || 'Untitled', kind: r.doc?.kind === 'graphic' ? 'graphic' : 'ui', updatedAt: r.updatedAt, frames: (r.doc?.kind === 'graphic' ? r.doc?.artboards : r.doc?.nodes)?.length || 0, thumb: r.thumb || null })).sort((a, b) => b.updatedAt - a.updatedAt);
  },
  read: async (id) => {
    const r = await getRec(id);
    if (!r) throw new Error('That design is gone');
    return { doc: r.doc, assets: r.assets || {}, mtime: r.updatedAt };
  },
  write: async (id, doc, assets = {}, keep = null) => {
    const r = (await getRec(id)) || { id, assets: {} };
    const all = { ...r.assets, ...assets };
    if (keep) for (const k of Object.keys(all)) if (!keep.includes(k)) delete all[k];
    const now = Date.now();
    await tx('readwrite', (s) => s.put({ ...r, id, doc, assets: all, updatedAt: now }));
    return now;
  },
  stat: async (id) => (await getRec(id))?.updatedAt || 0,
  thumb: async (id, png) => {
    const r = await getRec(id);
    if (r) await tx('readwrite', (s) => s.put({ ...r, thumb: png }));
  },
  remove: (id) => tx('readwrite', (s) => s.delete(id)),
};

export const storage = files || idb;

// Keeps this desktop in step with a server:
//   - pulls changes made elsewhere (store.pull) on a timer and right after our own saves
//   - uploads this computer's browsing history and folds in visits from elsewhere
// Protocol: docs/companion-api.md.
import { store } from './store.js';
import { shell } from './shell.js';

const PULL_FOCUSED = 15_000;
const PULL_BLURRED = 60_000;
const HISTORY_UPLOAD = 20_000;

/* ---------------- Keeping in step ---------------- */

let pullTimer = null;

function schedulePull(ms) {
  clearTimeout(pullTimer);
  pullTimer = setTimeout(async () => {
    await store.pull();
    schedulePull(document.hasFocus() ? PULL_FOCUSED : PULL_BLURRED);
  }, ms);
}

export function initDevices() {
  // Only a server has changes to pull.
  if (store.mode !== 'cloud' || store.local) return;
  // Our own save just landed: see what changed meanwhile.
  let afterSave = null;
  store.addEventListener('status', (e) => {
    if (e.detail.status !== 'saved') return;
    clearTimeout(afterSave);
    afterSave = setTimeout(() => store.pull(), 1500);
  });
  store.addEventListener('sync', (e) => onSync(e.detail));
  addEventListener('focus', () => schedulePull(500));
  schedulePull(2000);

  if (shell) {
    uploadHistory();
    setInterval(uploadHistory, HISTORY_UPLOAD);
  }
}

async function onSync({ history }) {
  if (history.length && shell) {
    const n = await shell.history.applyRemote(history).catch(() => 0);
    if (n) dispatchEvent(new CustomEvent('leafdeck:history', { detail: { remote: true } }));
  }
}

/* ---------------- History ---------------- */

let uploading = false;
async function uploadHistory() {
  if (uploading || !shell || store.mode !== 'cloud' || store.local) return;
  uploading = true;
  try {
    for (let i = 0; i < 10; i++) {
      const rows = await shell.history.pending(500);
      if (!rows.length) break;
      await store.api('/history/_bulk', { method: 'POST', body: JSON.stringify(rows) });
      await shell.history.markSynced(rows.map((r) => r.id));
      if (rows.length < 500) break;
    }
  } catch (err) {
    console.warn('history upload', err.message);
  } finally {
    uploading = false;
  }
}

/** Remove one visit everywhere (local row id + its shared id). */
export async function deleteVisit(localId, uid) {
  if (shell && localId != null) uid = (await shell.history.remove(Number(localId))) || uid;
  if (uid && store.mode === 'cloud' && !store.local) await store.api(`/history/${encodeURIComponent(uid)}`, { method: 'DELETE' }).catch(() => {});
}

/** Clear history everywhere since a time (0 = all). */
export async function clearVisits(sinceMs = 0) {
  if (store.mode === 'cloud' && !store.local) await store.api('/history/_clear', { method: 'POST', body: JSON.stringify({ since: sinceMs }) }).catch(() => {});
}

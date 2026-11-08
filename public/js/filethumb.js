// What a file or folder looks like, in Files and the file picker: a folder, the picture itself, or a page with the
// file's extension. Pictures come from Leafdeck's own /~file (electron/files.cjs).
import { esc } from './util.js';
import { icon } from './icons.js';

export const fileUrl = (p) => `/~file?p=${encodeURIComponent(p)}`;
export const ext = (name) => (name.includes('.') && !name.startsWith('.') ? name.split('.').pop().slice(0, 4).toUpperCase() : '');
export const KIND_NAME = { folder: 'Folder', image: 'Picture', video: 'Video', audio: 'Sound', pdf: 'PDF', text: 'Text', code: 'Code', archive: 'Archive', doc: 'Document', sheet: 'Spreadsheet', slides: 'Presentation', app: 'App', file: 'File' };

// A folder: the back, the pages inside it, and the front with its sloping shoulder. Pages sit hidden behind the front
// until the item is hovered or dragged over, when they rise and the back lifts (app.css, .fm-fold). An empty folder has
// no pages. (The desktop uses these too, for folders in your Desktop folder.)
const page = (x, y, deg, more = '') => `<g class="pg"><g transform="rotate(${deg} ${x + 12} ${y + 14})">
    <rect x="${x}" y="${y}" width="24" height="23" rx="2.6"/>
    <path class="gl" d="M${x + 8} ${y + 2.6}h4l2.6 2.6v5.2a.6.6 0 0 1-.6.6h-6a.6.6 0 0 1-.6-.6v-7.2a.6.6 0 0 1 .6-.6zM${x + 12} ${y + 2.6}v2.6h2.6"/>${more}
  </g></g>`;
const drawFolder = (pages) => `<svg class="fm-fold" viewBox="0 0 64 52" aria-hidden="true">
  <rect class="bk" x="2" y="3" width="58" height="30" rx="6"/>
  ${pages}
  <path class="fr" d="M2 13.2a6 6 0 0 1 6-6H23C28 7.2 30 13 37 13H56a6 6 0 0 1 6 6V43a6 6 0 0 1-6 6H8a6 6 0 0 1-6-6z"/>
  <path class="rim" d="M2.3 12.2a5.7 5.7 0 0 1 5.7-4.7H23C28 7.5 30 13.3 37 13.3H56a5.7 5.7 0 0 1 5.7 5"/></svg>`;
const FOLDER = drawFolder(`${page(34, 8, 7)}${page(27, 2.4, 6, '<rect class="tag" x="33.4" y="11.2" width="5.6" height="2.4" rx=".5"/>')}${page(6.5, 0.4, -3)}`);
const EMPTY_FOLDER = drawFolder('');
/** A folder's picture, with pages in it unless it's empty. */
export const folderArt = (e) => (e.empty ? EMPTY_FOLDER : FOLDER);

// Their gradients, once for the page: a folder's own would stop working whenever the first one on the page is hidden.
document.body.insertAdjacentHTML('beforeend', `<svg class="fm-fold-defs" aria-hidden="true"><defs>
  <linearGradient id="fm-fold-bk" x1="0" y1="0" x2="1" y2="0.3"><stop class="b1" offset="0"/><stop class="b2" offset="1"/></linearGradient>
  <linearGradient id="fm-fold-fr" x1="0" y1="0" x2="1" y2="1"><stop class="f1" offset="0"/><stop class="f2" offset="1"/></linearGradient>
</defs></svg>`);

/** A page with the file's extension, for anything without a picture of its own. */
export const tile = (e) => `<span class="fm-thumb fm-tile k-${e.kind}"><b>${esc(ext(e.name) || KIND_NAME[e.kind] || '')}</b></span>`;

/** An item's picture: a folder, a thumbnail for pictures, or a page with the file's extension. */
export function thumb(e, emblem) {
  if (e.dir) return `<span class="fm-thumb fm-folder">${folderArt(e)}${emblem ? `<i class="fm-emblem">${icon(emblem, 11, 2.4)}</i>` : ''}</span>`;
  if (e.kind === 'image' && e.size < 40e6) return `<span class="fm-thumb fm-pic"><img src="${esc(fileUrl(e.path))}" loading="lazy" decoding="async" alt=""></span>`;
  return tile(e);
}

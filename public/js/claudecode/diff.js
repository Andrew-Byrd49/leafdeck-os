// Diffs for the Claude Code app: an edit's before and after as removed and added lines (the Edit / Write cards and
// their approval cards), and git's unified diffs drawn the same way (the Changes panel).
import { esc } from '../util.js';

/** Lines of a and b as [{ t: ' ' | '-' | '+', s }], by longest common subsequence (small inputs) or as a block. */
export function lineDiff(a, b) {
  const A = String(a ?? '').split('\n');
  const B = String(b ?? '').split('\n');
  // Both ending in a newline isn't a line of its own.
  if (A.length > 1 && B.length > 1 && A.at(-1) === '' && B.at(-1) === '') {
    A.pop();
    B.pop();
  }
  if (A.length * B.length > 250000) return [...A.map((s) => ({ t: '-', s })), ...B.map((s) => ({ t: '+', s }))];
  // Common start and end first: edits are usually small changes in a larger block.
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let q = 0;
  while (q < A.length - p && q < B.length - p && A[A.length - 1 - q] === B[B.length - 1 - q]) q++;
  const a2 = A.slice(p, A.length - q);
  const b2 = B.slice(p, B.length - q);
  const n = a2.length;
  const m = b2.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a2[i] === b2[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const mid = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a2[i] === b2[j]) {
      mid.push({ t: ' ', s: a2[i] });
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) mid.push({ t: '-', s: a2[i++] });
    else mid.push({ t: '+', s: b2[j++] });
  }
  while (i < n) mid.push({ t: '-', s: a2[i++] });
  while (j < m) mid.push({ t: '+', s: b2[j++] });
  return [...A.slice(0, p).map((s) => ({ t: ' ', s })), ...mid, ...A.slice(A.length - q).map((s) => ({ t: ' ', s }))];
}

/** Context around the changes only (3 lines), with "⋯" where unchanged lines are left out. */
function trim(rows, ctx = 3) {
  const keep = new Uint8Array(rows.length);
  rows.forEach((r, k) => {
    if (r.t !== ' ') for (let x = Math.max(0, k - ctx); x <= Math.min(rows.length - 1, k + ctx); x++) keep[x] = 1;
  });
  const out = [];
  let gap = false;
  rows.forEach((r, k) => {
    if (keep[k]) {
      out.push(r);
      gap = false;
    } else if (!gap) {
      out.push({ t: '…' });
      gap = true;
    }
  });
  return out;
}

const row = (r) => (r.t === '…' ? '<div class="df-gap">⋯</div>' : `<div class="df-l${r.t === '+' ? ' add' : r.t === '-' ? ' del' : ''}"><i>${r.t === ' ' ? '' : r.t}</i><span>${esc(r.s) || ' '}</span></div>`);

/** An edit as HTML: old → new. */
export function editHtml(oldS, newS, { max = 400 } = {}) {
  const rows = trim(lineDiff(oldS, newS));
  const shown = rows.slice(0, max);
  return `<div class="df">${shown.map(row).join('')}${rows.length > max ? `<div class="df-gap">… ${rows.length - max} more lines</div>` : ''}</div>`;
}

/** A new file's content as added lines. */
export function addedHtml(text, { max = 300 } = {}) {
  const lines = String(text ?? '').replace(/\n$/, '').split('\n');
  return `<div class="df">${lines.slice(0, max).map((s) => row({ t: '+', s })).join('')}${lines.length > max ? `<div class="df-gap">… ${lines.length - max} more lines</div>` : ''}</div>`;
}

/** Counts of an edit: { add, del }. */
export function editCounts(oldS, newS) {
  let add = 0;
  let del = 0;
  for (const r of lineDiff(oldS, newS)) r.t === '+' ? add++ : r.t === '-' && del++;
  return { add, del };
}

/** git's unified diff of one file as HTML, with line numbers. */
export function unifiedHtml(text, { max = 3000 } = {}) {
  const out = [];
  let o = 0;
  let n = 0;
  let count = 0;
  for (const l of String(text || '').replace(/\n$/, '').split('\n')) {
    if (count > max) {
      out.push('<div class="df-gap">… the rest of this diff is too long to show</div>');
      break;
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(l);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      out.push(`<div class="df-hunk">${esc(h[3].trim() || `Line ${n}`)}</div>`);
      continue;
    }
    if (/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity|rename |old mode|new mode)/.test(l)) continue;
    if (l.startsWith('Binary files')) {
      out.push('<div class="df-gap">Binary file</div>');
      continue;
    }
    if (l.startsWith('\\')) continue; // "No newline at end of file"
    const t = l[0] === '+' ? '+' : l[0] === '-' ? '-' : ' ';
    if (!l && !o && !n) continue;
    const s = l.slice(1);
    const nums = t === '+' ? `<b></b><b>${n++}</b>` : t === '-' ? `<b>${o++}</b><b></b>` : `<b>${o++}</b><b>${n++}</b>`;
    out.push(`<div class="df-l${t === '+' ? ' add' : t === '-' ? ' del' : ''}">${nums}<i>${t === ' ' ? '' : t}</i><span>${esc(s) || ' '}</span></div>`);
    count++;
  }
  return `<div class="df df-num">${out.join('') || '<div class="df-gap">No changes</div>'}</div>`;
}

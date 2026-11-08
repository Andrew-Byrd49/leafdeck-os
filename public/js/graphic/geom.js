// Graphic Designer's geometry: affine matrices, cubic Béziers (points, bounds, splitting, nearest point), our path model
// ↔ SVG path data, and live shapes (rectangles, ellipses, polygons, stars) as paths.
//
// A path is { subpaths: [{ closed, pts: [{ x, y, ix, iy, ox, oy, k }] }] } in world coordinates: (ix, iy) is the handle
// coming into the anchor, (ox, oy) the one going out (equal to the anchor when there's none); k is 'corner' or 'smooth'.

/* ---------------- matrices: [a, b, c, d, e, f] like SVG's matrix() ---------------- */

export const I = () => [1, 0, 0, 1, 0, 0];
export const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
export const translate = (x, y) => [1, 0, 0, 1, x, y];
export const scaleAt = (sx, sy, cx = 0, cy = 0) => [sx, 0, 0, sy, cx - sx * cx, cy - sy * cy];
export function rotateAt(deg, cx = 0, cy = 0) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
}
export const ap = (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
export function inv(m) {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
export const isIdentity = (m) => Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9 && Math.abs(m[3] - 1) < 1e-9 && Math.abs(m[4]) < 1e-9 && Math.abs(m[5]) < 1e-9;

/* ---------------- numbers and points ---------------- */

export const r2 = (v) => Math.round(v * 100) / 100;
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
/** Snap the vector from `o` to `p` to the nearest 45°. */
export function constrain45(o, p) {
  const dx = p.x - o.x;
  const dy = p.y - o.y;
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const d = Math.hypot(dx, dy) * Math.cos(Math.atan2(dy, dx) - a);
  return { x: o.x + Math.cos(a) * d, y: o.y + Math.sin(a) * d };
}

/* ---------------- boxes ---------------- */

export const EMPTY = () => ({ x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity });
export function addPt(b, x, y) {
  if (x < b.x1) b.x1 = x;
  if (y < b.y1) b.y1 = y;
  if (x > b.x2) b.x2 = x;
  if (y > b.y2) b.y2 = y;
  return b;
}
export const union = (a, b) => ({ x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) });
export const isEmpty = (b) => !b || !(b.x2 >= b.x1 && b.y2 >= b.y1);
export const boxRect = (b) => ({ x: b.x1, y: b.y1, w: b.x2 - b.x1, h: b.y2 - b.y1 });
export const rectBox = (r) => ({ x1: r.x, y1: r.y, x2: r.x + r.w, y2: r.y + r.h });
export const overlaps = (a, b) => a.x1 <= b.x2 && a.x2 >= b.x1 && a.y1 <= b.y2 && a.y2 >= b.y1;
export const contains = (outer, inner) => inner.x1 >= outer.x1 && inner.x2 <= outer.x2 && inner.y1 >= outer.y1 && inner.y2 <= outer.y2;

/* ---------------- cubic Béziers: p0, c1, c2, p1 ---------------- */

export function bez(p0, c1, c2, p1, t) {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x,
    y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y,
  };
}
/** de Casteljau: the two halves of a curve at t. */
export function splitBez(p0, c1, c2, p1, t) {
  const a = lerp(p0, c1, t);
  const b = lerp(c1, c2, t);
  const c = lerp(c2, p1, t);
  const d = lerp(a, b, t);
  const e = lerp(b, c, t);
  const m = lerp(d, e, t);
  return [
    [p0, a, d, m],
    [m, e, c, p1],
  ];
}
/** The t values in (0, 1) where one coordinate of a curve turns around. */
function extrema(a, b, c, d) {
  const A = -a + 3 * b - 3 * c + d;
  const B = 2 * (a - 2 * b + c);
  const C = b - a;
  const out = [];
  if (Math.abs(A) < 1e-12) {
    if (Math.abs(B) > 1e-12) out.push(-C / B);
  } else {
    const disc = B * B - 4 * A * C;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      out.push((-B + s) / (2 * A), (-B - s) / (2 * A));
    }
  }
  return out.filter((t) => t > 0 && t < 1);
}
export function bezBox(p0, c1, c2, p1, b = EMPTY()) {
  addPt(b, p0.x, p0.y);
  addPt(b, p1.x, p1.y);
  for (const t of [...extrema(p0.x, c1.x, c2.x, p1.x), ...extrema(p0.y, c1.y, c2.y, p1.y)]) {
    const p = bez(p0, c1, c2, p1, t);
    addPt(b, p.x, p.y);
  }
  return b;
}

/* ---------------- our paths ---------------- */

export const anchor = (x, y, k = 'corner') => ({ x, y, ix: x, iy: y, ox: x, oy: y, k });
export const hasIn = (p) => Math.abs(p.ix - p.x) > 1e-6 || Math.abs(p.iy - p.y) > 1e-6;
export const hasOut = (p) => Math.abs(p.ox - p.x) > 1e-6 || Math.abs(p.oy - p.y) > 1e-6;

/** Each segment of a subpath: { i, j, p0, c1, c2, p1 } (i, j: anchor indexes). */
export function segments(sp) {
  const out = [];
  const n = sp.pts.length;
  const last = sp.closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = sp.pts[i];
    const b = sp.pts[(i + 1) % n];
    out.push({ i, j: (i + 1) % n, p0: { x: a.x, y: a.y }, c1: { x: a.ox, y: a.oy }, c2: { x: b.ix, y: b.iy }, p1: { x: b.x, y: b.y } });
  }
  return out;
}

export function pathBox(subpaths, b = EMPTY()) {
  for (const sp of subpaths) {
    if (sp.pts.length === 1) addPt(b, sp.pts[0].x, sp.pts[0].y);
    for (const s of segments(sp)) bezBox(s.p0, s.c1, s.c2, s.p1, b);
  }
  return b;
}

const f = (v) => {
  const s = (Math.round(v * 1000) / 1000).toString();
  return s === '-0' ? '0' : s;
};
/** Our path → SVG path data. */
export function toD(subpaths) {
  let d = '';
  for (const sp of subpaths) {
    if (!sp.pts.length) continue;
    const p = sp.pts[0];
    d += `M${f(p.x)} ${f(p.y)}`;
    for (const s of segments(sp)) {
      const line = Math.abs(s.c1.x - s.p0.x) < 1e-6 && Math.abs(s.c1.y - s.p0.y) < 1e-6 && Math.abs(s.c2.x - s.p1.x) < 1e-6 && Math.abs(s.c2.y - s.p1.y) < 1e-6;
      if (sp.closed && s.j === 0 && line) continue; // Z draws it
      d += line ? `L${f(s.p1.x)} ${f(s.p1.y)}` : `C${f(s.c1.x)} ${f(s.c1.y)} ${f(s.c2.x)} ${f(s.c2.y)} ${f(s.p1.x)} ${f(s.p1.y)}`;
    }
    if (sp.closed) d += 'Z';
  }
  return d;
}

/** An SVG arc (endpoint form) as cubic Béziers: [[c1, c2, p1], …]. */
function arcToBez(x1, y1, rx, ry, phi, large, sweep, x2, y2) {
  if (!rx || !ry) return [[{ x: x1, y: y1 }, { x: x2, y: y2 }, { x: x2, y: y2 }]];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const r = (phi * Math.PI) / 180;
  const cs = Math.cos(r);
  const sn = Math.sin(r);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cs * dx + sn * dy;
  const y1p = -sn * dx + cs * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let co = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) co = -co;
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cs * cxp - sn * cyp + (x1 + x2) / 2;
  const cy = sn * cxp + cs * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9) || 1;
  const step = dt / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const pt = (t) => ({ x: cx + rx * Math.cos(t) * cs - ry * Math.sin(t) * sn, y: cy + rx * Math.cos(t) * sn + ry * Math.sin(t) * cs });
  const der = (t) => ({ x: -rx * Math.sin(t) * cs - ry * Math.cos(t) * sn, y: -rx * Math.sin(t) * sn + ry * Math.cos(t) * cs });
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = t1 + i * step;
    const b = a + step;
    const pa = pt(a);
    const pb = pt(b);
    const da = der(a);
    const db = der(b);
    out.push([
      { x: pa.x + k * da.x, y: pa.y + k * da.y },
      { x: pb.x - k * db.x, y: pb.y - k * db.y },
      pb,
    ]);
  }
  return out;
}

/** SVG path data → our path. Takes every command (relative, shorthand, quadratic, arcs). */
export function parseD(d) {
  const toks = String(d || '').match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
  const subpaths = [];
  let sp = null;
  let i = 0;
  let cmd = '';
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let lastC = null; // the previous cubic's second control point (for S)
  let lastQ = null; // the previous quadratic's control point (for T)
  const num = () => parseFloat(toks[i++]);
  const isNum = () => i < toks.length && !/^[a-zA-Z]$/.test(toks[i]);
  const start = (x, y) => {
    sp = { closed: false, pts: [anchor(x, y)] };
    subpaths.push(sp);
  };
  const ensure = () => sp || start(cx, cy);
  const lineTo = (x, y) => {
    ensure();
    sp.pts.push(anchor(x, y));
  };
  const curveTo = (c1, c2, p) => {
    ensure();
    const prev = sp.pts[sp.pts.length - 1];
    prev.ox = c1.x;
    prev.oy = c1.y;
    const a = anchor(p.x, p.y);
    a.ix = c2.x;
    a.iy = c2.y;
    sp.pts.push(a);
  };
  while (i < toks.length) {
    if (/^[a-zA-Z]$/.test(toks[i])) cmd = toks[i++];
    else if (!cmd) {
      i++;
      continue;
    }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    if (C === 'Z') {
      if (sp) {
        sp.closed = true;
        // A last point on top of the first: the Z segment would be zero-length, so merge them.
        const a = sp.pts[0];
        const b = sp.pts[sp.pts.length - 1];
        if (sp.pts.length > 1 && Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) {
          a.ix = b.ix;
          a.iy = b.iy;
          sp.pts.pop();
        }
      }
      cx = sx;
      cy = sy;
      sp = null;
      lastC = lastQ = null;
      continue;
    }
    if (!isNum()) {
      cmd = '';
      continue;
    }
    if (C === 'M') {
      cx = num() + ox;
      cy = num() + oy;
      sx = cx;
      sy = cy;
      start(cx, cy);
      cmd = rel ? 'l' : 'L';
      lastC = lastQ = null;
    } else if (C === 'L') {
      cx = num() + ox;
      cy = num() + oy;
      lineTo(cx, cy);
      lastC = lastQ = null;
    } else if (C === 'H') {
      cx = num() + ox;
      lineTo(cx, cy);
      lastC = lastQ = null;
    } else if (C === 'V') {
      cy = num() + oy;
      lineTo(cx, cy);
      lastC = lastQ = null;
    } else if (C === 'C') {
      const c1 = { x: num() + ox, y: num() + oy };
      const c2 = { x: num() + ox, y: num() + oy };
      const p = { x: num() + ox, y: num() + oy };
      curveTo(c1, c2, p);
      lastC = c2;
      lastQ = null;
      cx = p.x;
      cy = p.y;
    } else if (C === 'S') {
      const c1 = lastC ? { x: 2 * cx - lastC.x, y: 2 * cy - lastC.y } : { x: cx, y: cy };
      const c2 = { x: num() + ox, y: num() + oy };
      const p = { x: num() + ox, y: num() + oy };
      curveTo(c1, c2, p);
      lastC = c2;
      lastQ = null;
      cx = p.x;
      cy = p.y;
    } else if (C === 'Q' || C === 'T') {
      const q = C === 'Q' ? { x: num() + ox, y: num() + oy } : lastQ ? { x: 2 * cx - lastQ.x, y: 2 * cy - lastQ.y } : { x: cx, y: cy };
      const p = { x: num() + ox, y: num() + oy };
      curveTo({ x: cx + (2 / 3) * (q.x - cx), y: cy + (2 / 3) * (q.y - cy) }, { x: p.x + (2 / 3) * (q.x - p.x), y: p.y + (2 / 3) * (q.y - p.y) }, p);
      lastQ = q;
      lastC = null;
      cx = p.x;
      cy = p.y;
    } else if (C === 'A') {
      const rx = num();
      const ry = num();
      const phi = num();
      const large = num() ? 1 : 0;
      const sweep = num() ? 1 : 0;
      const p = { x: num() + ox, y: num() + oy };
      for (const [c1, c2, e] of arcToBez(cx, cy, rx, ry, phi, large, sweep, p.x, p.y)) curveTo(c1, c2, e);
      cx = p.x;
      cy = p.y;
      lastC = lastQ = null;
    } else i++;
  }
  for (const s of subpaths) markSmooth(s);
  return subpaths.filter((s) => s.pts.length);
}

/** Anchors whose two handles line up are smooth. */
export function markSmooth(sp) {
  for (const p of sp.pts) {
    if (!hasIn(p) || !hasOut(p)) {
      p.k = 'corner';
      continue;
    }
    const a = Math.atan2(p.y - p.iy, p.x - p.ix);
    const b = Math.atan2(p.oy - p.y, p.ox - p.x);
    p.k = Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 0.03 ? 'smooth' : 'corner';
  }
  return sp;
}

export const clonePath = (subpaths) => subpaths.map((sp) => ({ closed: sp.closed, pts: sp.pts.map((p) => ({ ...p })) }));

export function transformPath(subpaths, m) {
  for (const sp of subpaths)
    for (const p of sp.pts) {
      const a = ap(m, p.x, p.y);
      const i = ap(m, p.ix, p.iy);
      const o = ap(m, p.ox, p.oy);
      Object.assign(p, { x: a.x, y: a.y, ix: i.x, iy: i.y, ox: o.x, oy: o.y });
    }
  return subpaths;
}

export function reverseSubpath(sp) {
  sp.pts.reverse();
  for (const p of sp.pts) [p.ix, p.iy, p.ox, p.oy] = [p.ox, p.oy, p.ix, p.iy];
  return sp;
}

/** The point on a path nearest to (x, y): { si, seg, t, x, y, d }. */
export function nearestOnPath(subpaths, x, y) {
  let best = null;
  subpaths.forEach((sp, si) => {
    for (const s of segments(sp)) {
      // Coarse samples, then refine around the best.
      let bt = 0;
      let bd = Infinity;
      const N = 24;
      for (let k = 0; k <= N; k++) {
        const p = bez(s.p0, s.c1, s.c2, s.p1, k / N);
        const d = (p.x - x) ** 2 + (p.y - y) ** 2;
        if (d < bd) (bd = d), (bt = k / N);
      }
      let step = 1 / N;
      for (let it = 0; it < 12; it++) {
        step /= 2;
        for (const t of [bt - step, bt + step]) {
          if (t < 0 || t > 1) continue;
          const p = bez(s.p0, s.c1, s.c2, s.p1, t);
          const d = (p.x - x) ** 2 + (p.y - y) ** 2;
          if (d < bd) (bd = d), (bt = t);
        }
      }
      if (!best || bd < best.d * best.d) {
        const p = bez(s.p0, s.c1, s.c2, s.p1, bt);
        best = { si, seg: s.i, t: bt, x: p.x, y: p.y, d: Math.sqrt(bd) };
      }
    }
  });
  return best;
}

/**
 * Scissors: cut a subpath at a point on one of its segments (seg, t as nearestOnPath gives them), or at an anchor
 * (splitAtAnchor). A closed subpath becomes one open subpath starting and ending at the cut; an open one becomes two.
 */
export function splitSubpath(sp, seg, t) {
  const copy = { closed: sp.closed, pts: sp.pts.map((p) => ({ ...p })) };
  const idx = insertAnchor([copy], 0, seg, t);
  return splitAtAnchor(copy, idx);
}
export function splitAtAnchor(sp, i) {
  const pts = sp.pts.map((p) => ({ ...p }));
  const N = pts.length;
  const p = pts[i];
  // The two ends of the cut: one keeps the in handle, the other the out handle.
  const endA = { ...p, ox: p.x, oy: p.y, k: 'corner' };
  const startB = { ...p, ix: p.x, iy: p.y, k: 'corner' };
  if (sp.closed) {
    const run = [startB];
    for (let k = 1; k < N; k++) run.push(pts[(i + k) % N]);
    run.push(endA);
    return [{ closed: false, pts: run }];
  }
  if (i <= 0 || i >= N - 1) return [{ closed: false, pts }];
  return [
    { closed: false, pts: [...pts.slice(0, i), endA] },
    { closed: false, pts: [startB, ...pts.slice(i + 1)] },
  ];
}

/** Put a new anchor on segment `seg` of subpath `si` at t, keeping the curve's shape. Returns its index. */
export function insertAnchor(subpaths, si, seg, t) {
  const sp = subpaths[si];
  const n = sp.pts.length;
  const a = sp.pts[seg];
  const b = sp.pts[(seg + 1) % n];
  const [l, r] = splitBez({ x: a.x, y: a.y }, { x: a.ox, y: a.oy }, { x: b.ix, y: b.iy }, { x: b.x, y: b.y }, t);
  a.ox = l[1].x;
  a.oy = l[1].y;
  b.ix = r[2].x;
  b.iy = r[2].y;
  const curved = hasOut(a) || hasIn(b) || Math.abs(l[2].x - l[3].x) > 1e-6 || Math.abs(l[2].y - l[3].y) > 1e-6;
  const p = { x: l[3].x, y: l[3].y, ix: l[2].x, iy: l[2].y, ox: r[1].x, oy: r[1].y, k: curved ? 'smooth' : 'corner' };
  sp.pts.splice(seg + 1, 0, p);
  return seg + 1;
}

/* ---------------- live corners ---------------- */

// An anchor with `cr` (a corner radius) is drawn rounded: the two segments meeting there are trimmed back and a
// circular arc (one cubic) joins them. The anchor itself stays where it is (the skeleton the user edits), like Figma's
// corner radius on a vertex. Works beside curves too: the trim is measured along the curve; neighbors that both want
// more room than a segment has share it in proportion.

const SAMPLES = 24;
/** A segment with an arc-length table. */
function measured(sg) {
  const pts = [];
  const len = [0];
  for (let k = 0; k <= SAMPLES; k++) pts.push(bez(sg.p0, sg.c1, sg.c2, sg.p1, k / SAMPLES));
  for (let k = 1; k <= SAMPLES; k++) len.push(len[k - 1] + dist(pts[k - 1], pts[k]));
  return { ...sg, pts, len, L: len[SAMPLES] };
}
/** The parameter t at arc length `d` along a measured segment. */
function paramAt(m, d) {
  if (d <= 0) return 0;
  if (d >= m.L) return 1;
  let k = 1;
  while (k < SAMPLES && m.len[k] < d) k++;
  const a = m.len[k - 1];
  const b = m.len[k];
  return (k - 1 + (b > a ? (d - a) / (b - a) : 0)) / SAMPLES;
}
/** The direction of travel at parameter t. */
function tangentAt(sg, t) {
  const d = (a, b) => ({ x: b.x - a.x, y: b.y - a.y });
  const mt = 1 - t;
  let v = {
    x: 3 * mt * mt * (sg.c1.x - sg.p0.x) + 6 * mt * t * (sg.c2.x - sg.c1.x) + 3 * t * t * (sg.p1.x - sg.c2.x),
    y: 3 * mt * mt * (sg.c1.y - sg.p0.y) + 6 * mt * t * (sg.c2.y - sg.c1.y) + 3 * t * t * (sg.p1.y - sg.c2.y),
  };
  if (Math.hypot(v.x, v.y) < 1e-9) v = t < 0.5 ? d(sg.p0, Math.hypot(sg.c2.x - sg.p0.x, sg.c2.y - sg.p0.y) > 1e-9 ? sg.c2 : sg.p1) : d(Math.hypot(sg.p1.x - sg.c1.x, sg.p1.y - sg.c1.y) > 1e-9 ? sg.c1 : sg.p0, sg.p1);
  const l = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / l, y: v.y / l };
}
/** A segment trimmed to the arc lengths [a, L - b]: { p0, c1, c2, p1 } (a piece of the same curve). */
function trimmed(m, a, b) {
  const t1 = paramAt(m, a);
  const t2 = paramAt(m, m.L - b);
  let piece = { p0: m.p0, c1: m.c1, c2: m.c2, p1: m.p1 };
  if (t2 < 1) {
    const [l] = splitBez(piece.p0, piece.c1, piece.c2, piece.p1, t2);
    piece = { p0: l[0], c1: l[1], c2: l[2], p1: l[3] };
  }
  if (t1 > 0) {
    const s = t2 > 0 ? t1 / t2 : 0;
    const [, r] = splitBez(piece.p0, piece.c1, piece.c2, piece.p1, Math.min(1, s));
    piece = { p0: r[0], c1: r[1], c2: r[2], p1: r[3] };
  }
  return { ...piece, m, t1, t2 };
}
/**
 * What a corner anchor looks like: the interior angle between its two segments (radians), the inward bisector, and the
 * most room its own segments give a rounding. null when it isn't a corner (an end of an open path, or straight through).
 */
export function cornerInfo(sp, i) {
  const N = sp.pts.length;
  if (N < 2 || (!sp.closed && (i === 0 || i === N - 1))) return null;
  const segs = segments(sp);
  const sin = segs.find((s) => s.i === (i - 1 + N) % N);
  const sout = segs.find((s) => s.i === i);
  if (!sin || !sout) return null;
  const tin = tangentAt(sin, 1); // arriving
  const tout = tangentAt(sout, 0); // leaving
  const back = { x: -tin.x, y: -tin.y };
  const cosT = Math.max(-1, Math.min(1, back.x * tout.x + back.y * tout.y));
  const theta = Math.acos(cosT); // interior angle: π when straight through
  if (theta > Math.PI - 0.02 || theta < 0.02) return null;
  let bx = back.x + tout.x;
  let by = back.y + tout.y;
  const bl = Math.hypot(bx, by) || 1;
  bx /= bl;
  by /= bl;
  const Lin = measured(sin).L;
  const Lout = measured(sout).L;
  // The tangent distance for radius r is r / tan(θ/2); it can't pass the far end of either segment.
  const maxR = Math.min(Lin, Lout) * Math.tan(theta / 2);
  return { theta, bis: { x: bx, y: by }, maxR, tanHalf: Math.tan(theta / 2) };
}
/** How far from the corner anchor the rounded corner's middle sits, for radius r: r (1 / sin(θ/2) − 1). */
export const cornerInset = (info, r) => r * (1 / Math.sin(info.theta / 2) - 1);

/**
 * A subpath with its `cr` anchors rounded. `report`, when given, gets report[i] = { mid } (the middle of anchor i's arc)
 * for the corner widgets.
 */
export function roundSubpath(sp, report = null) {
  const N = sp.pts.length;
  const want = sp.pts.map((p, i) => (p.cr > 0 ? cornerInfo(sp, i) : null));
  if (!want.some(Boolean)) return { closed: sp.closed, pts: sp.pts.map((p) => ({ ...p })) };
  const segs = segments(sp).map(measured);
  const segOf = new Map(segs.map((m) => [m.i, m]));
  // Each anchor's trim along both its segments: r / tan(θ/2).
  const trim = sp.pts.map((p, i) => (want[i] ? Math.max(0, Math.min(p.cr / want[i].tanHalf, Math.min(segOf.get((i - 1 + N) % N)?.L ?? 0, segOf.get(i)?.L ?? 0))) : 0));
  // Two corners on one segment share it in proportion.
  for (const m of segs) {
    const a = m.i;
    const b = (m.i + 1) % N;
    if (trim[a] + trim[b] > m.L && trim[a] + trim[b] > 0) {
      const f = m.L / (trim[a] + trim[b]);
      trim[a] *= f;
      trim[b] *= f;
    }
  }
  const pieces = new Map();
  for (const m of segs) pieces.set(m.i, trimmed(m, trim[m.i], trim[(m.i + 1) % N]));
  const out = [];
  const push = (x, y, ix, iy, ox, oy, k = 'corner', cr) => out.push({ x, y, ix, iy, ox, oy, k, ...(cr ? { cr } : {}) });
  for (let i = 0; i < N; i++) {
    const p = sp.pts[i];
    const pin = pieces.get((i - 1 + N) % N); // the piece arriving (undefined at an open start)
    const pout = pieces.get(i); // the piece leaving (undefined at an open end)
    const rounded = want[i] && trim[i] > 1e-6 && pin && pout;
    if (!rounded) {
      push(p.x, p.y, pin ? pin.c2.x : p.ix, pin ? pin.c2.y : p.iy, pout ? pout.c1.x : p.ox, pout ? pout.c1.y : p.oy, p.k, p.cr);
      continue;
    }
    // The arc from the end of the arriving piece to the start of the leaving one: one cubic hugging a circle.
    const A = pin.p1;
    const B = pout.p0;
    // Tangents from the whole segments (a piece trimmed to nothing has none of its own).
    const ta = tangentAt(pin.m, pin.t2);
    const tb = tangentAt(pout.m, pout.t1);
    const chord = dist(A, B);
    const phi = Math.PI - want[i].theta; // the turn
    const R = phi > 1e-6 ? chord / (2 * Math.sin(phi / 2)) : 0;
    const h = R ? (4 / 3) * Math.tan(phi / 4) * R : chord / 3;
    push(A.x, A.y, pin.c2.x, pin.c2.y, A.x + ta.x * h, A.y + ta.y * h, 'smooth');
    push(B.x, B.y, B.x - tb.x * h, B.y - tb.y * h, pout.c1.x, pout.c1.y, 'smooth');
    if (report) report[i] = { mid: bez(A, { x: A.x + ta.x * h, y: A.y + ta.y * h }, { x: B.x - tb.x * h, y: B.y - tb.y * h }, B, 0.5) };
  }
  // The round-trip markers (cr) on arc anchors are gone; the skeleton keeps them.
  return { closed: sp.closed, pts: out };
}
export const hasCorners = (subpaths) => subpaths.some((sp) => sp.pts.some((p) => p.cr > 0));
export const roundCorners = (subpaths) => subpaths.map((sp) => roundSubpath(sp));

/* ---------------- live shapes ---------------- */

const K = 0.5522847498;

/** A shape's frame: its local (0..w, 0..h) box placed at x, y and turned `rot` degrees around its middle. */
export function frameMatrix(n) {
  const m = mul(translate(n.x, n.y), rotateAt(n.rot || 0, n.w / 2, n.h / 2));
  return n.flip ? mul(m, scaleAt(-1, 1, n.w / 2, n.h / 2)) : m;
}

/** A rectangle's four corner radii [tl, tr, br, bl], each fitted to its size. */
export function cornerRadii(n) {
  const lim = Math.min(Math.abs(n.w) / 2, Math.abs(n.h) / 2);
  return [0, 1, 2, 3].map((i) => Math.max(0, Math.min(n.corners?.[i] ?? n.r ?? 0, lim)) || 0);
}

/** A live shape's outline in its own frame (not turned). */
export function shapeLocal(n) {
  const { w, h } = n;
  if (n.type === 'rect') {
    const rr = cornerRadii(n);
    if (!rr.some(Boolean)) return [{ closed: true, pts: [anchor(0, 0), anchor(w, 0), anchor(w, h), anchor(0, h)] }];
    const pts = [];
    // Clockwise from the top left. Each rounded corner is two anchors: where the side ends and where the next begins.
    const corner = (cx, cy, dxIn, dyIn, dxOut, dyOut, r) => {
      if (!r) return pts.push(anchor(cx, cy));
      const c = r * (1 - K);
      const a = anchor(cx - dxIn * r, cy - dyIn * r);
      a.ox = cx - dxIn * c;
      a.oy = cy - dyIn * c;
      const b = anchor(cx + dxOut * r, cy + dyOut * r);
      b.ix = cx + dxOut * c;
      b.iy = cy + dyOut * c;
      pts.push(a, b);
    };
    corner(0, 0, 0, -1, 1, 0, rr[0]);
    corner(w, 0, 1, 0, 0, 1, rr[1]);
    corner(w, h, 0, 1, -1, 0, rr[2]);
    corner(0, h, -1, 0, 0, -1, rr[3]);
    return [{ closed: true, pts }];
  }
  if (n.type === 'ellipse') {
    const rx = w / 2;
    const ry = h / 2;
    const p = (x, y, ix, iy, ox, oy) => ({ x, y, ix, iy, ox, oy, k: 'smooth' });
    return [
      {
        closed: true,
        pts: [p(rx, 0, rx - rx * K, 0, rx + rx * K, 0), p(w, ry, w, ry - ry * K, w, ry + ry * K), p(rx, h, rx + rx * K, h, rx - rx * K, h), p(0, ry, 0, ry + ry * K, 0, ry - ry * K)],
      },
    ];
  }
  if (n.type === 'polygon' || n.type === 'star') {
    const count = Math.max(3, Math.round(n.type === 'star' ? n.points || 5 : n.sides || 6));
    const verts = n.type === 'star' ? count * 2 : count;
    const inner = n.type === 'star' ? (n.inner ?? 0.5) : 1;
    const pts = [];
    for (let k = 0; k < verts; k++) {
      const a = -Math.PI / 2 + (k * 2 * Math.PI) / verts;
      const rr = n.type === 'star' && k % 2 ? inner : 1;
      pts.push(anchor(w / 2 + (Math.cos(a) * rr * w) / 2, h / 2 + (Math.sin(a) * rr * h) / 2));
    }
    if (n.r > 0) {
      pts.forEach((p) => (p.cr = n.r));
      return [roundSubpath({ closed: true, pts })];
    }
    return [{ closed: true, pts }];
  }
  return [];
}

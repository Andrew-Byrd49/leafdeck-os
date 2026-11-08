// Pathfinder (unite, minus front, intersect, exclude, divide), the Shape Builder's regions, and pencil smoothing, by
// Paper.js (public/vendor/paper, MIT), which works on the curves themselves, so results keep their Béziers. Loaded the
// first time it's needed.
import * as G from './geom.js';

let ready = null;
function paper() {
  ready ??= new Promise((resolve, reject) => {
    if (window.paper) return resolve(window.paper);
    const s = document.createElement('script');
    s.src = '/vendor/paper/paper-core.min.js';
    s.onload = () => {
      const p = window.paper;
      p.setup(new p.Size(1, 1));
      resolve(p);
    };
    s.onerror = () => reject(new Error('Couldn’t load the path tools'));
    document.head.append(s);
  });
  return ready;
}

const item = (p, subpaths, rule = 'nonzero') => {
  const it = p.PathItem.create(G.toD(subpaths) || 'M0 0');
  it.fillRule = rule;
  return it;
};
const back = (it) => {
  const d = it.pathData || '';
  it.remove();
  return d ? G.parseD(d) : [];
};

/**
 * Combine outlines (bottom to top; each { subpaths, rule }). 'unite' | 'minus' (the top ones cut from the bottom one) |
 * 'intersect' | 'exclude' → one path; 'divide' → a list of paths, one per piece.
 */
export async function combine(op, shapes) {
  const p = await paper();
  const items = shapes.map((s) => item(p, s.subpaths, s.rule));
  try {
    if (op === 'divide') return cutPieces(items).map(back).filter((s) => s.length);
    let r = items[0];
    if (op === 'minus') {
      let cut = items[1];
      for (const it of items.slice(2)) cut = cut.unite(it, { insert: false });
      r = r.subtract(cut, { insert: false });
    } else
      for (const it of items.slice(1)) {
        if (op === 'unite') r = r.unite(it, { insert: false });
        if (op === 'intersect') r = r.intersect(it, { insert: false });
        if (op === 'exclude') r = r.exclude(it, { insert: false });
      }
    return back(r);
  } finally {
    items.forEach((it) => it.remove());
  }
}

/** Every piece the items cut each other into: each one minus all the others' areas, plus every overlap (Paper items). */
function cutPieces(items) {
  let pieces = [items[0].clone({ insert: false })];
  for (const it of items.slice(1)) {
    const next = [];
    for (const pc of pieces) {
      const a = pc.intersect(it, { insert: false });
      const b = pc.subtract(it, { insert: false });
      if (!a.isEmpty()) next.push(a);
      if (!b.isEmpty()) next.push(b);
    }
    let rest = it.clone({ insert: false });
    for (const pc of pieces) rest = rest.subtract(pc, { insert: false });
    if (!rest.isEmpty()) next.push(rest);
    pieces = next;
  }
  // Split pieces that came apart into separate islands (holes stay with their outline).
  const out = [];
  for (const pc of pieces) {
    const kids = pc.children ? [...pc.children] : [pc];
    const outer = kids.filter((k) => k.clockwise === kids[0].clockwise);
    if (outer.length < 2) out.push(pc);
    else {
      for (const o of outer) {
        let piece = o.clone({ insert: false });
        for (const hole of kids.filter((k) => k.clockwise !== kids[0].clockwise && o.bounds.contains(k.bounds))) piece = piece.subtract(hole, { insert: false });
        out.push(piece);
      }
      pc.remove();
    }
  }
  return out;
}
/** A point inside a piece (its middle when that's inside, else a scan across it). */
function interior(p, pc) {
  const b = pc.bounds;
  const c = b.center;
  if (pc.contains(c)) return { x: c.x, y: c.y };
  for (let k = 1; k < 40; k++) {
    const x = b.left + (b.width * k) / 40;
    for (const y of [c.y, b.top + b.height * 0.25, b.top + b.height * 0.75, b.top + b.height * 0.5 + b.height * 0.1]) if (pc.contains(new p.Point(x, y))) return { x, y };
  }
  return { x: c.x, y: c.y };
}

/**
 * Shape Builder: the regions a set of shapes (bottom to top) cut each other into. Each region: { subpaths, at (a point
 * inside), sources (indices of the shapes it lies in, bottom to top) }. hit(x, y) finds the region at a point (-1 for
 * none). The Paper items stay alive for the hit tests until dispose().
 */
export async function planar(shapes) {
  const p = await paper();
  const items = shapes.map((s) => item(p, s.subpaths, s.rule));
  const pieces = cutPieces(items).filter((pc) => !pc.isEmpty() && Math.abs(pc.area) > 0.01);
  const regions = pieces.map((pc) => {
    const at = interior(p, pc);
    const pt = new p.Point(at.x, at.y);
    return { pc, subpaths: G.parseD(pc.pathData || ''), at, sources: items.map((it, i) => (it.contains(pt) ? i : -1)).filter((i) => i >= 0) };
  });
  return {
    list: regions.map(({ pc, ...r }) => {
      void pc;
      return r;
    }),
    hit: (x, y) => {
      const pt = new p.Point(x, y);
      return regions.findIndex((r) => r.pc.contains(pt));
    },
    dispose: () => {
      regions.forEach((r) => r.pc.remove());
      items.forEach((it) => it.remove());
    },
  };
}

/** A freehand stroke's points → a few smooth curves. `tolerance` in world units. */
export async function smoothStroke(points, tolerance = 2.5, closed = false) {
  const p = await paper();
  const path = new p.Path({ segments: points.map((q) => [q.x, q.y]), insert: false });
  if (closed) path.closed = true;
  path.simplify(tolerance);
  return back(path);
}

/** Paths of the same outline with fewer anchors (Object › Path › Simplify). */
export async function simplifyPath(subpaths, tolerance = 1) {
  const p = await paper();
  const out = [];
  for (const sp of subpaths) {
    const pts = [];
    for (const s of G.segments(sp)) for (let k = 0; k < 16; k++) pts.push(G.bez(s.p0, s.c1, s.c2, s.p1, k / 16));
    if (!sp.closed && sp.pts.length) pts.push(sp.pts[sp.pts.length - 1]);
    if (pts.length < 3) {
      out.push(sp);
      continue;
    }
    const r = await smoothStroke(pts, tolerance, sp.closed);
    out.push(...r);
  }
  return out;
}

/** Outline Stroke: the area a stroke covers, as a filled path. Strokes become filled outlines of themselves. */
export async function outlineStroke(subpaths, width, { cap = 'butt', join = 'miter', closed = null } = {}) {
  const p = await paper();
  // Paper has no stroke expansion: sample the stroke as many small quads and unite them, then simplify. Good enough for
  // signs and logos; exact offsets would need a dedicated library.
  const hw = width / 2;
  let acc = null;
  const add = (it) => {
    acc = acc ? acc.unite(it, { insert: false }) : it;
  };
  for (const sp of subpaths) {
    const pts = [];
    for (const s of G.segments(sp)) {
      const n = Math.max(4, Math.ceil(G.dist(s.p0, s.p1) / Math.max(2, hw)));
      for (let k = 0; k < n; k++) pts.push(G.bez(s.p0, s.c1, s.c2, s.p1, k / n));
    }
    if (sp.closed) pts.push(pts[0]);
    else if (sp.pts.length) pts.push(sp.pts[sp.pts.length - 1]);
    const left = [];
    const right = [];
    for (let k = 0; k < pts.length; k++) {
      const a = pts[Math.max(0, k - 1)];
      const b = pts[Math.min(pts.length - 1, k + 1)];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const nx = -(b.y - a.y) / len;
      const ny = (b.x - a.x) / len;
      left.push([pts[k].x + nx * hw, pts[k].y + ny * hw]);
      right.push([pts[k].x - nx * hw, pts[k].y - ny * hw]);
    }
    if (sp.closed) {
      const outer = new p.Path({ segments: left, closed: true, insert: false });
      const inner = new p.Path({ segments: right, closed: true, insert: false });
      const ring = Math.abs(outer.area) > Math.abs(inner.area) ? outer.subtract(inner, { insert: false }) : inner.subtract(outer, { insert: false });
      add(ring);
    } else {
      add(new p.Path({ segments: [...left, ...right.reverse()], closed: true, insert: false }));
      if (cap === 'round' || join === 'round')
        for (const q of [pts[0], pts[pts.length - 1]]) add(new p.Path.Circle({ center: [q.x, q.y], radius: hw, insert: false }));
    }
    if (join === 'round') for (const a of sp.pts) add(new p.Path.Circle({ center: [a.x, a.y], radius: hw, insert: false }));
  }
  if (!acc) return [];
  if (acc.children) acc.children.forEach((c) => c.simplify?.(0.4));
  else acc.simplify?.(0.4);
  return back(acc);
}

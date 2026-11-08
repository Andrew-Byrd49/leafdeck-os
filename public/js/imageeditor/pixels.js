// Image Editor's pixel work, with no UI: canvases, regions, flood fill, and the outline of a selection.

/** A canvas kept in main memory: pixels are read back often, and they survive the GPU resetting. */
export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  c.getContext('2d', { willReadFrequently: true });
  return c;
}
export const ctxOf = (c) => c.getContext('2d');

/** A piece of a canvas, as a new canvas. Parts outside `src` are transparent. */
export function copyRect(src, x, y, w, h) {
  const c = makeCanvas(w, h);
  ctxOf(c).drawImage(src, -x, -y);
  return c;
}
export const clone = (src) => copyRect(src, 0, 0, src.width, src.height);

export function rectFrom(x0, y0, x1, y1) {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}
export function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}
export function union(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/**
 * The pixels like the one at (sx, sy): those touching it, or with `contiguous` off, all of them in the picture.
 * `tolerance` is 0 to 100. Colors are compared premultiplied, so everything fully transparent counts as the same color.
 * `limit` (0 or 1 per pixel) keeps it inside a selection. Returns 0 or 1 per pixel.
 */
export function flood(img, sx, sy, tolerance, contiguous = true, limit = null) {
  const { data: d, width: w, height: h } = img;
  const out = new Uint8Array(w * h);
  const seed = (sy * w + sx) * 4;
  const a0 = d[seed + 3];
  const r0 = (d[seed] * a0) / 255;
  const g0 = (d[seed + 1] * a0) / 255;
  const b0 = (d[seed + 2] * a0) / 255;
  const t = (tolerance * 255) / 100;
  const like = (p) => {
    if (limit && !limit[p]) return false;
    const i = p * 4;
    const a = d[i + 3];
    if (Math.abs(a - a0) > t) return false;
    return Math.abs((d[i] * a) / 255 - r0) <= t && Math.abs((d[i + 1] * a) / 255 - g0) <= t && Math.abs((d[i + 2] * a) / 255 - b0) <= t;
  };
  const start = sy * w + sx;
  if (!like(start)) return out;
  if (!contiguous) {
    for (let p = 0; p < out.length; p++) if (like(p)) out[p] = 1;
    return out;
  }
  // Scanline fill: a run of the row at a time, remembering one pixel per run above and below it.
  const stack = [start];
  while (stack.length) {
    const p = stack.pop();
    if (out[p]) continue;
    const y = Math.floor(p / w);
    const first = y * w;
    const last = first + w - 1;
    let l = p;
    while (l > first && !out[l - 1] && like(l - 1)) l--;
    let r = p;
    while (r < last && !out[r + 1] && like(r + 1)) r++;
    let up = false;
    let down = false;
    for (let q = l; q <= r; q++) {
      out[q] = 1;
      if (y > 0) {
        const n = !out[q - w] && like(q - w);
        if (n && !up) stack.push(q - w);
        up = n;
      }
      if (y < h - 1) {
        const n = !out[q + w] && like(q + w);
        if (n && !down) stack.push(q + w);
        down = n;
      }
    }
  }
  return out;
}

/** 0-or-1 per pixel, as a canvas that's opaque where it's 1. */
export function maskToCanvas(mask, w, h) {
  const c = makeCanvas(w, h);
  const img = new ImageData(w, h);
  const d = img.data;
  for (let p = 0; p < mask.length; p++) if (mask[p]) d[p * 4 + 3] = 255;
  ctxOf(c).putImageData(img, 0, 0);
  return c;
}

/** Which pixels of a mask canvas count as inside: at least half covered. */
export function insideOf(maskCanvas) {
  const { width: w, height: h } = maskCanvas;
  const d = ctxOf(maskCanvas).getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let p = 0; p < out.length; p++) out[p] = d[p * 4 + 3] >= 128 ? 1 : 0;
  return out;
}

/**
 * What a selection's mask covers. Pixels at least half covered are inside: the outline goes around those. Fainter pixels
 * touching them are the selection's soft edge and stay; fainter ones further out are removed from the mask, since
 * nothing shows they're selected (taking away a soft shape leaves a ghost of its edge). `box` holds every pixel left in
 * the mask, so the pixels in it are all that an operation on the selection can change. It's null if nothing's selected.
 */
export function selectionShape(maskCanvas) {
  const { width: w, height: h } = maskCanvas;
  const c = ctxOf(maskCanvas);
  const img = c.getImageData(0, 0, w, h);
  const d = img.data;
  const inside = new Uint8Array(w * h);
  for (let p = 0; p < inside.length; p++) inside[p] = d[p * 4 + 3] >= 128 ? 1 : 0;
  const touchesInside = (x, y) => {
    for (let b = Math.max(0, y - 1); b <= Math.min(h - 1, y + 1); b++) {
      for (let a = Math.max(0, x - 1); a <= Math.min(w - 1, x + 1); a++) if (inside[b * w + a]) return true;
    }
    return false;
  };
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  let removed = false;
  for (let y = 0, p = 0; y < h; y++) {
    for (let x = 0; x < w; x++, p++) {
      if (!d[p * 4 + 3]) continue;
      if (!inside[p] && !touchesInside(x, y)) {
        d[p * 4 + 3] = 0;
        removed = true;
        continue;
      }
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  if (removed) c.putImageData(img, 0, 0);
  return { inside, box: x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } };
}

/** The box around the 1s, or null if there are none. */
export function boundsOf(mask, w, h) {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0, p = 0; y < h; y++) {
    for (let x = 0; x < w; x++, p++) {
      if (!mask[p]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** The edges between 1s and 0s, as a path in pixel coordinates, with long straight edges as one segment. */
export function traceOutline(mask, w, h) {
  const path = new Path2D();
  let segs = 0;
  const add = (x0, y0, x1, y1) => {
    path.moveTo(x0, y0);
    path.lineTo(x1, y1);
    segs++;
  };
  for (let y = 0; y <= h; y++) {
    let from = -1;
    for (let x = 0; x < w; x++) {
      const edge = (y < h ? mask[y * w + x] : 0) !== (y > 0 ? mask[(y - 1) * w + x] : 0);
      if (edge && from < 0) from = x;
      else if (!edge && from >= 0) {
        add(from, y, x, y);
        from = -1;
      }
    }
    if (from >= 0) add(from, y, w, y);
  }
  for (let x = 0; x <= w; x++) {
    let from = -1;
    for (let y = 0; y < h; y++) {
      const edge = (x < w ? mask[y * w + x] : 0) !== (x > 0 ? mask[y * w + x - 1] : 0);
      if (edge && from < 0) from = y;
      else if (!edge && from >= 0) {
        add(x, from, x, y);
        from = -1;
      }
    }
    if (from >= 0) add(x, from, x, h);
  }
  return { path, segs };
}

/** The box around everything not fully transparent, or null if the picture is empty. */
export function opaqueBounds(canvas) {
  const { width: w, height: h } = canvas;
  const d = ctxOf(canvas).getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  for (let p = 0; p < mask.length; p++) mask[p] = d[p * 4 + 3] ? 1 : 0;
  return boundsOf(mask, w, h);
}

/**
 * A copy with `filter` (CSS filter syntax) applied. `pad` is how far the filter reaches (a blur): the picture's edge
 * pixels are stretched that far outward first, so blurring doesn't fade the edges into transparency.
 */
export function filtered(src, filter, pad = 0) {
  const { width: w, height: h } = src;
  const out = makeCanvas(w, h);
  const c = ctxOf(out);
  if (!pad) {
    c.filter = filter;
    c.drawImage(src, 0, 0);
    c.filter = 'none';
    return out;
  }
  const big = makeCanvas(w + 2 * pad, h + 2 * pad);
  const b = ctxOf(big);
  b.imageSmoothingEnabled = false;
  const strip = (sx, sy, sw, sh, dx, dy, dw, dh) => b.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
  strip(0, 0, w, 1, pad, 0, w, pad);
  strip(0, h - 1, w, 1, pad, h + pad, w, pad);
  strip(0, 0, 1, h, 0, pad, pad, h);
  strip(w - 1, 0, 1, h, w + pad, pad, pad, h);
  strip(0, 0, 1, 1, 0, 0, pad, pad);
  strip(w - 1, 0, 1, 1, w + pad, 0, pad, pad);
  strip(0, h - 1, 1, 1, 0, h + pad, pad, pad);
  strip(w - 1, h - 1, 1, 1, w + pad, h + pad, pad, pad);
  b.drawImage(src, pad, pad);
  c.filter = filter;
  c.drawImage(big, -pad, -pad);
  c.filter = 'none';
  return out;
}

/** Unsharp mask: push each pixel away from its blurred self. `amount` 0 to 3; `radius` in pixels. */
export function sharpened(src, amount, radius) {
  const { width: w, height: h } = src;
  const blurred = filtered(src, `blur(${radius}px)`, Math.ceil(radius * 3));
  const out = makeCanvas(w, h);
  const img = ctxOf(src).getImageData(0, 0, w, h);
  const b = ctxOf(blurred).getImageData(0, 0, w, h).data;
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    d[i] += (d[i] - b[i]) * amount; // Uint8ClampedArray: clamps and rounds
    d[i + 1] += (d[i + 1] - b[i + 1]) * amount;
    d[i + 2] += (d[i + 2] - b[i + 2]) * amount;
  }
  ctxOf(out).putImageData(img, 0, 0);
  return out;
}

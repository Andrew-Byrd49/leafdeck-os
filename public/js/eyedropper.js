// Pick a color from anywhere on screen. The main process freezes the screens: on Windows and macOS it puts a window
// with a screenshot over each display (public/eyedropper.html, so other apps and other monitors work too); in Leafdeck
// OS Leafdeck is the whole screen, so the screenshot comes back here and the magnifier runs over the desktop itself.
// Move to look, click (or lift a finger) to pick, Esc or right-click to cancel.

const N = 15; // pixels across the magnifier (odd: one in the middle)
const CELL = 9; // screen pixels per magnified pixel

const hex2 = (n) => n.toString(16).padStart(2, '0');

/** Run the magnifier over a frozen screen image in `host`. Resolves '#rrggbb', or null when canceled. */
export function loupe(host, src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onerror = () => resolve(null);
    img.onload = () => {
      const pixels = document.createElement('canvas');
      pixels.width = img.naturalWidth;
      pixels.height = img.naturalHeight;
      const pc = pixels.getContext('2d', { willReadFrequently: true });
      pc.drawImage(img, 0, 0);

      const node = document.createElement('div');
      node.className = 'eyedrop';
      node.tabIndex = -1;
      node.innerHTML = `<div class="eyedrop-lens" hidden><canvas width="${N * CELL}" height="${N * CELL}"></canvas><span></span></div>`;
      node.prepend(img);
      host.append(node);
      const lens = node.querySelector('.eyedrop-lens');
      const lc = lens.querySelector('canvas').getContext('2d');
      const label = lens.querySelector('span');
      let color = null;

      function show(e) {
        // The image is stretched over the whole page: page pixels → image pixels.
        const sx = Math.floor((e.clientX / innerWidth) * pixels.width);
        const sy = Math.floor((e.clientY / innerHeight) * pixels.height);
        const [r, g, b] = pc.getImageData(Math.min(pixels.width - 1, Math.max(0, sx)), Math.min(pixels.height - 1, Math.max(0, sy)), 1, 1).data;
        color = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
        const size = N * CELL;
        lc.imageSmoothingEnabled = false;
        lc.fillStyle = '#000';
        lc.fillRect(0, 0, size, size);
        lc.drawImage(pixels, sx - (N >> 1), sy - (N >> 1), N, N, 0, 0, size, size);
        lc.strokeStyle = 'rgba(255,255,255,0.12)';
        lc.lineWidth = 1;
        lc.beginPath();
        for (let i = 1; i < N; i++) {
          lc.moveTo(i * CELL + 0.5, 0);
          lc.lineTo(i * CELL + 0.5, size);
          lc.moveTo(0, i * CELL + 0.5);
          lc.lineTo(size, i * CELL + 0.5);
        }
        lc.stroke();
        const c = (N >> 1) * CELL;
        lc.strokeStyle = '#000';
        lc.strokeRect(c - 0.5, c - 0.5, CELL + 1, CELL + 1);
        lc.strokeStyle = '#fff';
        lc.strokeRect(c + 0.5, c + 0.5, CELL - 1, CELL - 1);
        label.textContent = color.toUpperCase();
        label.style.setProperty('--c', color);
        // Centered on the pointer; above a finger, so it isn't hidden under it.
        const touch = e.pointerType === 'touch';
        lens.style.left = `${e.clientX}px`;
        lens.style.top = `${e.clientY - (touch ? size / 2 + 40 : 0)}px`;
        lens.hidden = false;
      }
      function finish(value) {
        node.remove();
        resolve(value);
      }
      node.addEventListener('pointermove', show);
      node.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.button !== 0) return finish(null);
        node.setPointerCapture(e.pointerId);
        show(e);
      });
      node.addEventListener('pointerup', (e) => e.button === 0 && finish(color));
      node.addEventListener('pointerleave', () => (lens.hidden = true));
      node.addEventListener('contextmenu', (e) => e.preventDefault());
      node.addEventListener('keydown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') finish(null);
        else if (e.key === 'Enter' && color) finish(color);
      });
      node.focus();
    };
    img.src = src;
  });
}

/** Pick a color from the screen: '#rrggbb', or null when canceled (or when this can't be done here). */
export async function pickScreenColor() {
  const shell = window.desktopShell;
  if (shell?.pickScreenColor) {
    const r = await shell.pickScreenColor().catch(() => null);
    if (r?.image) return loupe(document.body, r.image);
    return r?.color || null;
  }
  // In a browser (the local server): the browser's own eyedropper, where there is one.
  if (!window.EyeDropper) return null;
  try {
    return (await new window.EyeDropper().open()).sRGBHex;
  } catch {
    return null;
  }
}

// public/eyedropper.html: one of the windows over each screen.
if (window.leafdeckEyedropper) {
  const bridge = window.leafdeckEyedropper;
  bridge.image().then((src) => (src ? loupe(document.body, src) : null)).then((color) => bridge.done(color));
}

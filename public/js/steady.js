// Busy indicators on one clock.
//
// Chromium tells the compositor one damage rectangle per frame: the box around everything that changed. Leafdeck is one
// surface across every screen, so a spinner on one screen and a pulsing dot on another redraw everything between them,
// 60 times a second, for as long as they run (measured in ~/ldtests/perf: the GPU two-thirds busy with Claude working).
// So the spinners and pulses are steps() animations on an 80 ms grid, each one's start pinned to the document timeline:
// on one screen they all change in the same frame, and each screen's frame comes at its own point in the 80 ms, so the
// box stays on that screen instead of spanning the ones between (measured with three screens: about a third of the area
// redrawn; GPU busy barely moved, so it may be the compositor's work that this saves). Dots whose color already says
// "busy" don't animate at all.
import { screens } from './wm.js';

const STEP_MS = 80;
const STEPPED = new Set(['cl-spin', 'pulse', 'mcp-pulse', 'ac-pulse', 'ac-blink', 'indeterminate']);

function startFor(el) {
  const r = el.getBoundingClientRect();
  const all = screens();
  const i = all.findIndex((s) => r.x >= s.x && r.x < s.x + s.w && r.y >= s.y && r.y < s.y + s.h);
  return i > 0 ? Math.round((i * STEP_MS) / all.length) : 0;
}

addEventListener('animationstart', (e) => {
  if (!STEPPED.has(e.animationName) || !(e.target instanceof Element)) return;
  // The event's target owns the animation, also for its ::before/::after (subtree includes them).
  const start = startFor(e.target);
  for (const a of e.target.getAnimations({ subtree: true })) {
    if (STEPPED.has(a.animationName) && a.startTime !== start) a.startTime = start;
  }
}, true);

// Runs before the stylesheet paints, so a light theme doesn't flash dark while the store loads.
// main.js keeps this in step with Settings → Appearance.
try {
  const theme = localStorage.getItem('ws:theme');
  if (theme === 'light' || theme === 'system') document.documentElement.dataset.theme = theme;
} catch {}

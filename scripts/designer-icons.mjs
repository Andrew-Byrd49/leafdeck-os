// Build Designer's icon library (public/js/designer/icons.json) from Lucide (ISC) and Tabler Icons (MIT).
//   node scripts/designer-icons.mjs <lucide-static package dir> <@tabler/icons package dir>
// Get the packages with `npm pack lucide-static @tabler/icons` and unpack them anywhere (they aren't dependencies).
// The file: { sets: { id: { label, license, url, svg } }, icons: [[set, name, body, tags]] }, where `svg` is the
// root element's attributes and `body` what goes inside it, so an icon is `<svg ${svg}>${body}</svg>`.

import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';

const [lucideDir, tablerDir] = process.argv.slice(2);
if (!lucideDir || !tablerDir) throw new Error('Usage: node scripts/designer-icons.mjs <lucide-static dir> <@tabler/icons dir>');

/** What's inside the root <svg>, on one line, without Tabler's invisible 24×24 box. */
const body = (file) =>
  readFileSync(file, 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/<path stroke="none" d="M0 0h24v24H0z" fill="none"\s*\/>/, '')
    .replace(/\s*\n\s*/g, '')
    .replace(/\s*\/>/g, '/>')
    .trim();
const words = (list) => [...new Set((list || []).map((t) => String(t).toLowerCase()))].join(' ');

const STROKE = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const sets = {
  lucide: { label: 'Lucide', license: 'ISC', url: 'https://lucide.dev', svg: STROKE },
  tabler: { label: 'Tabler', license: 'MIT', url: 'https://tabler.io/icons', svg: STROKE },
  'tabler-filled': { label: 'Tabler filled', license: 'MIT', url: 'https://tabler.io/icons', svg: 'viewBox="0 0 24 24" fill="currentColor"' },
};
const icons = [];

const lucideTags = JSON.parse(readFileSync(path.join(lucideDir, 'tags.json'), 'utf8'));
for (const f of readdirSync(path.join(lucideDir, 'icons')).sort()) {
  if (!f.endsWith('.svg')) continue;
  const name = f.slice(0, -4);
  icons.push(['lucide', name, body(path.join(lucideDir, 'icons', f)), words(lucideTags[name])]);
}

const tabler = JSON.parse(readFileSync(path.join(tablerDir, 'icons.json'), 'utf8'));
for (const [style, set] of [['outline', 'tabler'], ['filled', 'tabler-filled']]) {
  const dir = path.join(tablerDir, 'icons', style);
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.svg')) continue;
    const name = f.slice(0, -4);
    const meta = tabler[name] || {};
    icons.push([set, name, body(path.join(dir, f)), words([...(meta.tags || []), meta.category])]);
  }
}

const out = path.join(import.meta.dirname, '..', 'public', 'js', 'designer', 'icons.json');
writeFileSync(out, JSON.stringify({ sets, icons }));
console.log(`${icons.length} icons, ${Math.round(statSync(out).size / 1024)} KB → ${path.relative(process.cwd(), out)}`);

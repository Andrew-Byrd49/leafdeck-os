// Loads this project's own Cloudflare credentials from .cloudflare.env (never committed) into process.env, so
// wrangler uses Leafdeck's API token instead of whichever account `wrangler login` was last used for on this machine.
//   node scripts/cf-env.mjs wrangler deploy        run a command with the token
// .cloudflare.env (in the project folder):
//   CLOUDFLARE_API_TOKEN=…
//   CLOUDFLARE_ACCOUNT_ID=…
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let loaded = false;
try {
  for (const line of readFileSync(path.join(root, '.cloudflare.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)\s*=\s*(.+?)\s*$/);
    if (m && m[2] && !m[2].startsWith('#')) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      loaded = true;
    }
  }
} catch {}
if (!loaded) console.warn('No .cloudflare.env found: using your `wrangler login` account (see scripts/cf-env.mjs).');

// Used as a command runner: node scripts/cf-env.mjs <command…>
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.length > 2) {
  const cmd = process.argv.slice(2).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  try {
    execSync(cmd === 'wrangler' || cmd.startsWith('wrangler ') ? 'npx ' + cmd : cmd, { stdio: 'inherit', cwd: process.cwd(), env: process.env });
  } catch (err) {
    process.exit(err.status || 1);
  }
}

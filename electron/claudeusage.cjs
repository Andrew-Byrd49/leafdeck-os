// Leafdeck OS: your Claude plan's usage limits for the menu bar, the same numbers Claude Code's /usage shows.
// Uses Claude Code's sign-in (~/.claude/.credentials.json) read-only: Claude Code refreshes it, we never do, so the
// two never fight over the refresh token. When it has expired, the panel says to open Claude Code.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const URL = 'https://api.anthropic.com/api/oauth/usage';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const FRESH = 120_000; // the tray asks every 15 seconds; the server only every two minutes
const FORCED = 15_000; // opening the panel asks again, but not more often than this
const PLAN_FRESH = 3600_000; // the plan's name rarely changes

let cache = null; // { at, value }
let pending = null;
let plan = null; // { at, name }

function credentials() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8')).claudeAiOauth || null;
  } catch {
    return null;
  }
}

const headers = (c) => ({ Authorization: `Bearer ${c.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' });

// The plan's name as claude.ai shows it, from the server: the sign-in file's plan and tier go stale after a plan change.
async function planName(c) {
  if (plan && Date.now() - plan.at < PLAN_FRESH) return plan.name;
  try {
    const res = await fetch(PROFILE_URL, { headers: headers(c), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Claude profile: ${res.status}`);
    const name = (await res.json()).organization?.plan_display_name;
    plan = { at: Date.now(), name: name ? `Claude ${name}` : 'Claude' };
  } catch {
    // Keep the last name; the next read of the usage tries again.
  }
  return plan?.name || 'Claude';
}

function label(l) {
  if (l.kind === 'session') return 'Current session';
  const scope = l.scope?.model?.display_name || l.scope?.surface?.display_name;
  if (l.group === 'weekly') return scope ? `Current week (${scope} only)` : 'Current week (all models)';
  return scope || String(l.kind || 'Limit').replace(/_/g, ' ');
}

function shape(planLabel, d) {
  let limits = Array.isArray(d.limits)
    ? d.limits.map((l) => ({ kind: l.kind, weekly: l.group === 'weekly', label: label(l), percent: Math.round(l.percent ?? 0), resetsAt: l.resets_at || null, severity: l.severity || 'normal' }))
    : [];
  // Older answers have no `limits`: the session and week are still there.
  if (!limits.length) {
    const old = [['session', 'Current session', d.five_hour], ['weekly_all', 'Current week (all models)', d.seven_day], ['weekly_opus', 'Current week (Opus only)', d.seven_day_opus], ['weekly_sonnet', 'Current week (Sonnet only)', d.seven_day_sonnet]];
    limits = old.filter(([, , w]) => w).map(([kind, lbl, w]) => ({ kind, weekly: kind !== 'session', label: lbl, percent: Math.round(w.utilization ?? 0), resetsAt: w.resets_at || null, severity: 'normal' }));
  }
  const x = d.extra_usage;
  const extra = x?.is_enabled
    ? { percent: x.utilization == null ? null : Math.round(x.utilization), used: x.used_credits, limit: x.monthly_limit, currency: x.currency || 'USD', decimals: x.decimal_places ?? 2 }
    : null;
  return { signedIn: true, plan: planLabel, at: Date.now(), limits, extra };
}

async function fetchUsage() {
  const c = credentials();
  if (!c?.accessToken) return { signedIn: false };
  if (c.expiresAt && c.expiresAt < Date.now()) return { signedIn: true, expired: true, plan: plan?.name || 'Claude' };
  const [res, planLabel] = await Promise.all([fetch(URL, { headers: headers(c), signal: AbortSignal.timeout(10_000) }), planName(c)]);
  if (res.status === 401) return { signedIn: true, expired: true, plan: planLabel };
  if (!res.ok) throw new Error(`Claude usage: ${res.status}`);
  return shape(planLabel, await res.json());
}

/** Your usage limits, or { signedIn: false } without Claude Code's sign-in. `force`: asked by opening the panel. */
async function usage(force) {
  const age = cache ? Date.now() - cache.at : Infinity;
  if (age < (force ? FORCED : FRESH)) return cache.value;
  pending ||= fetchUsage()
    .then((value) => ((cache = { at: Date.now(), value }), value))
    .catch((err) => {
      // Offline or the server is busy: keep showing the last numbers, marked stale.
      if (!cache?.value?.limits) throw err;
      cache = { at: Date.now(), value: { ...cache.value, stale: true } };
      return cache.value;
    })
    .finally(() => (pending = null));
  return pending;
}

module.exports = { usage };

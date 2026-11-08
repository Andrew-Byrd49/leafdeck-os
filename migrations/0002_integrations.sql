-- Connected accounts (Google Calendar, calendar subscriptions…). Tokens are AES-GCM encrypted with the TOKEN_KEY secret.
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  secret TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  error TEXT,
  last_sync INTEGER,
  created_at INTEGER NOT NULL
);

-- Short-lived OAuth sign-in attempts (state → PKCE verifier).
CREATE TABLE IF NOT EXISTS oauth_pending (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  verifier TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

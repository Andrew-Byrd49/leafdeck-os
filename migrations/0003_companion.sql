-- Companion devices (the Android app): incremental sync, shared browsing history, pairing, send-to-device.

-- Deleted records stay as tombstones (deleted = 1, empty data) so other devices learn about the deletion.
ALTER TABLE records ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;

-- Small key/value store: `epoch` bumps when everything is replaced (clients then reload fully).
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO meta (key, value) VALUES ('epoch', '1');

-- Paired devices. The owner (desktop / web, through Access) is the pseudo-device 'desktop'.
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,              -- 'desktop' | 'android'
  token_hash TEXT,                 -- SHA-256 of the bearer token; NULL for the owner
  tabs TEXT NOT NULL DEFAULT '[]', -- open tabs reported by the device: [{ url, title }]
  tabs_at INTEGER,
  created_at INTEGER NOT NULL,
  last_seen INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO devices (id, name, kind, created_at) VALUES ('desktop', 'Desktop', 'desktop', 0);

-- One-time pairing codes shown as a QR code on the desktop.
CREATE TABLE IF NOT EXISTS pairings (
  code TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

-- Browsing history from every device (ids are chosen by the device that made the visit).
CREATE TABLE IF NOT EXISTS history (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL DEFAULT '',
  visited_at INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_updated ON history (updated_at);
CREATE INDEX IF NOT EXISTS idx_history_visited ON history (visited_at);
CREATE INDEX IF NOT EXISTS idx_history_url ON history (url);

-- "Send to phone" / "Send to desktop".
CREATE TABLE IF NOT EXISTS sends (
  id TEXT PRIMARY KEY,
  from_device TEXT NOT NULL,
  to_device TEXT NOT NULL,         -- a device id or 'all'
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  opened_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sends_created ON sends (created_at);

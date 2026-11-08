# Leafdeck companion API

How the Android companion app, the desktop app and the Worker talk to each other.
Everything here is served by the Worker (`src/index.js`) at `https://<your-worker>/api/...`.

## Authentication

Two kinds of callers:

| Caller | How it authenticates | Called the **owner** below? |
|---|---|---|
| Desktop app / web version | Cloudflare Access cookie or service token (`CF-Access-Client-Id` / `CF-Access-Client-Secret`), plus `x-api-token` if `API_TOKEN` is set | yes |
| A paired device (the phone) | `Authorization: Bearer ldk_<token>` — plus the same Access service-token headers if the Worker is behind Access | no |

Device tokens are 32 random bytes, base64url, prefixed `ldk_`. The Worker stores only their SHA-256.
A revoked device gets `401 {"error":"Device revoked"}` and must pair again.

The owner is treated as a device with id `desktop` (created automatically) so it can report open tabs and receive sends.

## Pairing

1. Owner: `POST /api/devices/pair` → `{ "code": "ABCD-EFGH", "expiresAt": <ms> }` (10 minutes, one use).
2. Desktop shows a QR code containing JSON: `{ "u": "<server url>", "c": "<code>", "a": ["<access client id>", "<access client secret>"] }` — `a` is present only when the desktop uses an Access service token.
3. Phone: `POST /api/devices/claim` body `{ "code", "name": "Pixel 9", "kind": "android" }` (no bearer needed) → `{ "token": "ldk_…", "deviceId": "dev_…" }`.
4. Phone stores the token (and Access pair) in its keystore and from then on sends `Authorization: Bearer`.

## Records (the document store)

Unchanged for the desktop. Every app record is JSON keyed by `(collection, id)`; collections: `tasks, notes, sprints, contacts, bookmarks, links, events, settings, focus`.

- `GET /api/data` → `{ collections: { [name]: Record[] } , epoch }`
- `GET /api/:collection` → `Record[]`
- `PUT /api/:collection/:id` body = record → `{ ok, record, updatedAt, warning? }`
  - Optional `If-Match: <updatedAt>` (the `updatedAt` this client last received for the row). If the server row is newer → `409 { error: "Changed on another device", record, updatedAt }`. The phone sends it; the desktop doesn't.
- `POST /api/:collection/_bulk` body = `Record[]` → `{ ok, count }`
- `DELETE /api/:collection/:id` → `{ ok }` — leaves a tombstone so other devices learn about it
- `POST /api/import` → replaces everything and bumps `epoch` (clients seeing a new epoch reload fully)

Deleted rows are kept 30 days as tombstones (`deleted = 1`, empty data), then pruned by the cron.

## Changes feed (incremental sync)

`GET /api/changes?since=<ms>&limit=500` →

```json
{
  "epoch": 3,
  "cursor": 1760990000000,
  "more": false,
  "records": [ { "collection": "tasks", "id": "…", "data": { …record… } | null, "updatedAt": 1760990000000 } ],
  "history": [ { "id": "…", "url": "…", "title": "…", "host": "…", "visitedAt": 1760989000000, "deviceId": "dev_…", "deleted": 0, "updatedAt": 1760990000000 } ],
  "sends":   [ { "id": "…", "from": "desktop", "to": "dev_…", "url": "…", "title": "…", "createdAt": 1760990000000, "openedAt": null } ],
  "devices": [ { "id": "desktop", "name": "Andrew’s PC", "kind": "desktop", "lastSeen": …, "tabs": [ { "url": "…", "title": "…" } ], "tabsAt": … } ]
}
```

- `records.data === null` means deleted.
- `cursor` is the largest `updatedAt` in this page (or `since` if empty). Pass it back as `since` next time. Rows are returned where `updatedAt > since`, so nothing is skipped; clients de-duplicate by id.
- `history` excludes visits the caller made itself.
- `sends` includes only sends addressed to the caller (or to `all`) from other devices.
- `devices` is always the full current list (small), for the "open on other devices" UI.
- If `epoch` differs from the client's stored epoch, drop local data and reload with `GET /api/data`, `GET /api/history`.

## Browsing history (shared)

Table `history`: `id` (uuid, chosen by the device), `url`, `title`, `host`, `visited_at`, `device_id`, `deleted`, `updated_at`.

- `POST /api/history/_bulk` body `[ { id, url, title, host, visitedAt } ]` → `{ ok, count }`. Upsert: a repeat with the same id updates the title / visitedAt (used for "same page again within 10 min").
- `GET /api/history?q=<words>&before=<ms>&limit=300` → `[ { id, url, title, host, visitedAt, deviceId, deviceName } ]` newest first, not deleted.
- `GET /api/history/search?q=&limit=8` → distinct URLs matching every word, for address-bar suggestions.
- `DELETE /api/history/:id` → `{ ok }` (tombstone; every device removes it)
- `POST /api/history/_clear` body `{ since }` (0 = everything) → `{ ok, count }` (tombstones)

Retention: pref `historyRetentionDays` in `settings/prefs` (default 365, `0` = forever). The cron hard-deletes visits older than that, and tombstones older than 30 days.
Burner windows (desktop) and private tabs (phone) are never recorded.

## Devices, open tabs, send-to-device

- `GET /api/devices` → `Device[]` (as in the changes feed)
- `PUT /api/devices/me` body `{ name }` → `{ ok }` (phone renames itself; owner may use id `desktop`)
- `PUT /api/devices/me/tabs` body `{ tabs: [ { url, title } ] }` → `{ ok }`. Call it (debounced) whenever open tabs change. Max 50 tabs, each ≤ 2 KB. The owner uses `PUT /api/devices/desktop/tabs`.
- `DELETE /api/devices/:id` (owner only) → revoke
- `POST /api/sends` body `{ url, title, to: "<deviceId>" | "all" }` → `{ ok, id }`
- `POST /api/sends/:id/opened` → `{ ok }`
- `GET /api/sends?since=` → pending sends for me (also delivered through `/changes`)

Sends older than 7 days are pruned.

## Live updates

`GET /api/live` with the usual auth upgrades to a WebSocket (a Durable Object hub). After any write the Worker broadcasts `{"type":"changed","at":<ms>}`; clients then call `/changes`. Clients send `{"type":"ping"}` every 30 s; the hub replies `{"type":"pong"}`. The desktop polls `/changes` instead (its API goes through a local proxy that can't carry a socket): every 15 s while focused, 60 s otherwise, and right after each of its own writes.

The phone, when the app isn't open, syncs with a periodic background job (every 15 minutes) and schedules its own local reminders from synced events — there is no push service.

## Focus (shared)

Record `focus/state`: `{ id: "state", active: true|false, title, taskId, phase: "focus"|"break", endsAt, round, rounds, focusMin, breakMin, blocked: [hosts], startedBy: "<deviceId>" }`. Either device can start or stop a session by writing it; both read it.

## Error shape

Every error is `{"error": "<message>"}` with a 4xx/5xx status. `401` means sign in / pair again; `409` is a conflict (see If-Match) or a refused delete (read-only calendar event, body carries `record`).

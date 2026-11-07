# Sync API

Sync is **optional**. Without it, the extension and the iPhone app each keep their own For You batch and everything works on one device. With it, both devices share one batch: whichever fetches first creates the batch, and the other shows the same tweets.

A sync server is three small HTTP endpoints. [`sync/`](../sync) has a ready-made one (a Convex component), but anything that follows this contract works.

## Basics

- **Base URL:** an `https://` origin with no path, e.g. `https://sync.example.com` or `https://sync.example.com:8443`. Clients call `<base>/dreamscroll/<endpoint>`.
- **Auth:** every request sends `Authorization: Bearer <token>`. The token is a shared secret of 32 or more characters that you choose; clients refuse shorter ones. Answer `401` if it doesn't match (compare in constant time).
- **Format:** JSON request and response bodies, `content-type: application/json`. Send `cache-control: no-store`.
- **Clock:** the server's clock is the only one that counts. Clients send no times; ignore any they send (the `state` request carries a `day` query parameter that a server must ignore).
- **Timeouts:** clients give up after 5 seconds and fall back to their local copy, so keep handlers fast.
- **One user per server.** There are no accounts: whoever holds the token shares the batch.

## State

Every endpoint answers with the same `State` object:

```jsonc
{
  "now": 1794056965766,            // server time, ms since epoch
  "batch": {
    "active": true,                // false once the window has ended (or before the first batch)
    "startedAt": 1794056965766,    // ms; null when not active
    "endsAt": 1794064165766,       // ms; null when not active
    "tweets": [ /* Tweet objects, as stored; [] when not active */ ],
    "size": 10                     // tweets per batch
  },
  "budget": {                      // daily unlocked-scrolling budget (unused by the current UI; required)
    "day": "2026-11-07",           // the server's current day, YYYY-MM-DD in its time zone
    "usedMs": 0,
    "limitMs": 900000,             // 15 minutes
    "remainingMs": 900000
  }
}
```

Clients sanitize every tweet again before showing it, so the server only has to store and return them.

## Endpoints

### `GET /dreamscroll/state`

Returns the current `State`. No side effects.

### `POST /dreamscroll/snapshot`

```json
{ "tweets": [ { "id": "1849…", "author": { "handle": "ada", "name": "Ada" }, "segments": [ … ], … } ] }
```

A device captured a new batch. Rules:

1. **Validate.** `tweets` must be a non-empty array. Keep the first 10 entries, then drop any whose `id` isn't 1–25 digits or whose `author.handle` isn't 1–15 of `[A-Za-z0-9_]`. If none remain, or the JSON of what remains is over 200,000 bytes, answer **`422`** and store nothing (never truncate).
2. **First snapshot wins.** If a batch is active (`now < endsAt`), keep it unchanged and return it. The other device then shows the same tweets.
3. **Otherwise start a window:** `startedAt = now`, `endsAt = now + 2 hours`, with these tweets. Keep only this one batch; older ones can be deleted.

Return the resulting `State`.

### `POST /dreamscroll/spend`

```json
{ "ms": 12000 }
```

Adds unlocked-scrolling time to today's budget. The current UI no longer offers unlocking, but servers should still implement it. Clamp `ms` to 0–30,000 per request (ignore a non-number), and cap the day's total at `limitMs`. The day is decided by the server, in a time zone you configure (UTC by default), never by the client.

Return the resulting `State`.

### Errors

| Status | When |
|---|---|
| `400` | The body isn't valid JSON. |
| `401` | Missing or wrong token, or the server has no token of 32+ characters configured. |
| `422` | A snapshot that can't be stored (see above). |

On any other `4xx`, the clients keep their local batch until it ends instead of retrying. On a `5xx` or network error, they keep working locally and retry later.

## Testing a server

```sh
TOKEN=…; BASE=https://sync.example.com
curl -s -H "Authorization: Bearer $TOKEN" $BASE/dreamscroll/state      # safe: read-only
```

Only `POST` test snapshots to a throwaway deployment: the first snapshot wins, so a test batch would replace the real one on every device for two hours.

The tests in [`sync/convex/dreamscroll.test.ts`](../sync/convex/dreamscroll.test.ts) describe the same behavior as code.

# Ack via link — design

**Status:** approved 2026-05-02 · awaiting implementation plan
**Owner:** klausvbl@yahoo.com (Klaus)
**Implements:** one-tap acknowledge of FlashAware alerts from SMS / WhatsApp / email,
without requiring the recipient to log in.

---

## Why

Live data shows the existing dashboard-only ack flow is the wrong shape for the
recipient population:

| Metric (prod, 2026-05-02)                        |         Count |
| ------------------------------------------------ | ------------: |
| Active recipients                                |             8 |
| Distinct recipient emails                        |             6 |
| Recipient emails that ARE FlashAware login users |        4 of 6 |
| Recipient emails with no login account           | 2 of 6 (~33%) |
| Recipients with phone on file                    |             7 |
| Recipients who completed phone OTP verification  |             1 |

Two consequences:

1. ~⅓ of recipients have no FlashAware account, so a login-required ack flow
   shuts them out and forces the on-duty admin to ack on their behalf.
2. SMS/WhatsApp adoption is effectively zero (1 verified phone), so the only
   live channel today is email. Adding a one-tap ack link to the WhatsApp
   message — combined with the existing OTP gate — makes the channel actually
   useful.

## Goal

Each delivery (email / SMS / WhatsApp) carries a unique tokenised URL. Tapping
the link opens a public confirmation page that lets the recipient acknowledge
the alert in one click, without logging in. The ack applies to **all** alert
rows for the same risk-state event (per-event scope), so the dashboard's
unacked counter clears for everyone the moment any recipient confirms.

## Non-goals (explicitly YAGNI)

- Token rotation / regeneration (a single 48 h token is sufficient).
- "Snooze for 30 min" or "Forward to colleague" buttons.
- Per-recipient unsubscribe-from-this-location link in the same message
  (separate feature, future PR).
- Branded short-domain (`fa.ws/a/…`); the existing host is fine.
- Anti-replay deletion of the token after first POST (the
  `WHERE acknowledged_at IS NULL` guard makes additional clicks no-ops,
  which is the safer behaviour anyway).

---

## Architecture

```
                   alert dispatch
                         │
                         ▼
   alertService.dispatchAlerts()
   ─ generates ack_token (24-byte random, base64url)
   ─ generates ack_url = SERVER_URL + "/a/" + token
   ─ passes ack_url to template builders
   ─ inserts alerts row with token + 48 h expiry

           │ SMS / WhatsApp / email link
           ▼
   recipient phone / inbox
           │ tap link
           ▼
   GET /a/<token>     ← public SPA route, no login
   ─ AckPage component
   ─ on mount: GET /api/ack/by-token/<token>  (read-only validation)
   ─ shows: state + location + reason + [Acknowledge] button
           │ click button
           ▼
   POST /api/ack/by-token/<token>             (destructive, idempotent)
   ─ acks ALL alert rows sharing the same state_id
   ─ records audit row: actor_role = "recipient", actor_email = "recipient:<email>"
   ─ returns count acked
           │
           ▼
   Confirmation: "Acknowledged at HH:MM SAST. <N> deliveries cleared."
```

Two endpoints rather than a single GET-and-ack:

- **GET** is read-only — safe for email scanners, Outlook safelinks, browser
  prefetch, WhatsApp Business catalog crawlers. Visiting the URL never acks.
- **POST** is the destructive verb, only fired by an explicit button click.

---

## Data model

### Schema additions (one migration, registered as `runOnce` in `migrate.ts`)

```sql
ALTER TABLE alerts
  ADD COLUMN ack_token            TEXT,
  ADD COLUMN ack_token_expires_at TIMESTAMPTZ;

-- Partial unique index — most legacy alert rows have NULL token; we only
-- care that LIVE tokens are unique.
CREATE UNIQUE INDEX uq_alerts_ack_token
  ON alerts (ack_token)
  WHERE ack_token IS NOT NULL;
```

No new table needed. The token belongs to the alert row.

### Token format

- 24 bytes from `crypto.randomBytes(24)` → `base64url` encoded → 32 chars
- 192 bits of entropy → unguessable; brute-force not feasible
- Embedded in URLs as `https://lightning-risk-api.fly.dev/a/<token>`

### TTL

- 48 hours from `addAlert`.
- Rationale: covers a weekend storm where the on-duty operator clicks the link
  Monday morning. Long enough to be useful; short enough that stale links
  aren't a long-lived attack surface.
- Expired tokens stay in the row (audit). The public endpoint refuses them.

### Lifecycle

| Event                                                                                     | What happens                                                                                                                                               |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatchAlerts` writes the leading `recipient:'system'` audit row                        | **No token.** System rows aren't delivered to anyone, so no URL is needed.                                                                                 |
| `dispatchAlerts` builds a real delivery (per recipient × per channel: email/SMS/WhatsApp) | Generate one fresh token + 48 h expiry, pass into the body builder so the URL is embedded in the message, `addAlert` the row with token + expiry attached. |
| Recipient `GET /api/ack/by-token/<token>`                                                 | Read-only lookup. Returns `{state, locationName, reason, alreadyAckedAt?, alreadyAckedBy?, expired?}`.                                                     |
| Recipient `POST /api/ack/by-token/<token>`                                                | Acks all alert rows for the same `state_id` in one UPDATE. Idempotent (`WHERE acknowledged_at IS NULL`). Writes an audit row.                              |
| Operator acks via dashboard                                                               | Existing `/api/ack/:alertId` flow unchanged. Works in parallel — first writer wins per row.                                                                |
| Token expires (48 h)                                                                      | GET returns `expired: true`; POST returns `410 Gone`.                                                                                                      |
| Retention job (30 d)                                                                      | Deletes the alerts row; token goes with it.                                                                                                                |

### Per-event ack — SQL shape

```sql
WITH seed AS (
  SELECT state_id, location_id, recipient
    FROM alerts
   WHERE ack_token = $1
     AND ack_token_expires_at > NOW()
)
UPDATE alerts a
   SET acknowledged_at = NOW(),
       acknowledged_by = 'recipient:' || (SELECT recipient FROM seed)
  FROM seed
 WHERE a.state_id = seed.state_id
   AND a.location_id = seed.location_id
   AND a.acknowledged_at IS NULL
RETURNING a.id, a.location_id, (SELECT recipient FROM seed) AS by_recipient;
```

The `location_id = seed.location_id` clause is belt-and-braces: it stops the
ack from escaping its location even if `state_id` somehow matched across
locations (it shouldn't — `state_id` references a single risk-state row — but
the constraint costs nothing).

---

## Endpoints

### `server/publicAckRoutes.ts` (new file, mounted in `index.ts`)

Public — no `authenticate`/`requireRole` middleware. Two handlers:

#### `GET /api/ack/by-token/:token`

Read-only validation. Looks up the alert by token, joins to risk-state and
location for display. Returns:

```json
{
  "state": "STOP",
  "locationName": "Sun City Golf Course",
  "reason": "3 flashes within 10 km in the last 5 minutes",
  "expired": false,
  "alreadyAckedAt": null,
  "alreadyAckedBy": null,
  "recipient": "alice@example.com"
}
```

`404` for unknown token. The endpoint never modifies state, so safe for
prefetchers/crawlers.

#### `POST /api/ack/by-token/:token`

Destructive, idempotent. Runs the per-event UPDATE shown above and writes the
audit row. Returns:

```json
{ "acked": 3 }
```

If the UPDATE matches zero rows, the handler determines why:

| Cause                    |  HTTP | Body                              |
| ------------------------ | ----: | --------------------------------- |
| Token not found          | `404` | `{"error":"invalid"}`             |
| Token expired            | `410` | `{"error":"expired"}`             |
| All alerts already acked | `200` | `{"acked":0,"alreadyAcked":true}` |

### `audit.ts` extension

`logAudit(...)` gains an optional `actor_override: { email, role }` parameter so
the public ack endpoint can record `actor_role: "recipient"` and
`actor_email: "recipient:<email>"` instead of falling through to "anonymous"
(which the current code path uses when `req.user` is absent).

`audit_log.actor_role` is `TEXT NOT NULL` with no `CHECK` constraint, so
"recipient" goes in clean. The audit-log filter UI on `/audit` already
keys off `actor_email`; super-admins can filter `actor_email LIKE 'recipient:%'`
to see all link-acks.

---

## Public page UX

### Routing

Public route, mounted in `App.tsx` outside the auth gate (alongside
`/register`):

```tsx
<Route path="/a/:token" element={<AckPage />} />
```

Short path so SMS char counts stay low.

### `AckPage` component (new file, ~120 lines)

States and what each renders:

| State                         | Header colour                                   | Body                                                                                                                                                 | CTA                                             |
| ----------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `loading`                     | neutral spinner                                 | —                                                                                                                                                    | —                                               |
| `valid + unacked`             | state colour band (`STATE_CONFIG[state].color`) | reason text · masked-email "Sent to: a\*\*\*@example.com" · "Detected at HH:MM SAST" (sourced from `risk_states.changed_at` of the joined state row) | **[ Acknowledge — I've seen this ]** big button |
| `valid + already acked`       | neutral grey                                    | "Already acknowledged at HH:MM by alice@example.com"                                                                                                 | small "View dashboard" link → `/alerts`         |
| `acked-just-now` (after POST) | green check                                     | "Acknowledged at HH:MM SAST. \<N\> deliveries cleared."                                                                                              | small "View dashboard" link → `/alerts`         |
| `expired`                     | grey                                            | "This link expired 48 hours after the alert was sent."                                                                                               | "Open dashboard to ack" → `/alerts`             |
| `invalid`                     | grey                                            | "Link not recognised. Check the message and try again."                                                                                              | "Open dashboard" → `/alerts`                    |
| `error`                       | red                                             | "Couldn't load this alert. Try again?"                                                                                                               | retry button                                    |

### Mobile-first layout

- Single column.
- Acknowledge button ≥ 48 px tap target (Material spec).
- State colour fills the top band, mirroring the dashboard cards.
- Reuses `STATE_CONFIG` from `states.ts` — single source of truth for state
  colour/label/emoji.
- No login prompt. The "View dashboard" link below the confirmation is the
  only path back to the authenticated app.

---

## Message-template changes

`alertTemplates.ts` — every body builder gains an `ackUrl` parameter:

```ts
buildSmsBody(locationName, state, reason, ackUrl):
  ${emoji} FlashAware ${state} — ${locationName}
  ${shortReason}
  Ack: ${ackUrl}

buildWhatsAppBody(locationName, state, reason, ackUrl):
  *${emoji} FlashAware Alert*
  *${state}* — ${locationName}

  ${shortReason}

  *Acknowledge:* ${ackUrl}

  _${nowSast()} SAST_

buildEmailHtml(locationName, state, reason, ackUrl):
  ... existing colour-banded layout ...
  [big button-style anchor: "Acknowledge alert" → ackUrl]
  ... small "or log in to flashaware.com" link below ...
```

`SERVER_URL` env var (already present, used by the Twilio statusCallback)
supplies the host. Locally it falls back to `http://localhost:4000`.

---

## Edge cases

| Case                                                                       | Behaviour                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token typo'd in URL bar                                                    | `GET` 404 → AckPage `invalid` state                                                                                                                                                                                                                         |
| Token expired (>48 h)                                                      | `GET` returns `expired:true`; `POST` 410                                                                                                                                                                                                                    |
| User clicks twice (double-tap)                                             | First POST acks, second sees `acked:0, alreadyAcked:true` and treats it as success                                                                                                                                                                          |
| Two recipients click ~simultaneously                                       | `WHERE acknowledged_at IS NULL` is racefree at the row level; first writer's timestamp wins per row, both clients see 200                                                                                                                                   |
| Operator acked via dashboard before the link click                         | Same as above — `alreadyAcked:true`; page shows "Already acknowledged by alice@example.com"                                                                                                                                                                 |
| New alert dispatched for the _same_ `state_id` while link is being clicked | Persistence-alert mechanism. New alert has its own token; the older click only acks alerts that existed at click time. The new alert remains unacked and fires re-alert per `persistence_alert_min`. Operator handles the next persistence alert as normal. |
| Email link previewer / Outlook safelinks visits the URL                    | `GET`-only endpoint — no ack performed. No audit row written.                                                                                                                                                                                               |
| WhatsApp Business catalog scanner                                          | Same — `GET`-only, harmless.                                                                                                                                                                                                                                |
| Recipient row deleted between alert send and click                         | `alerts` doesn't FK to `location_recipients`; alert rows survive recipient deletion. Token still works.                                                                                                                                                     |
| Location deleted between send and click                                    | `alerts.location_id` has `ON DELETE CASCADE` → alert row gone → token resolves to invalid → "Link not recognised". Acceptable (storm passed and admin cleaned up).                                                                                          |
| Token in retention window but storm long gone                              | Page shows historical state info. Acking is still a valid "I saw this" record.                                                                                                                                                                              |
| Bot / scraper hits every base64url token                                   | 192-bit keyspace. Not feasible.                                                                                                                                                                                                                             |
| Recipient on a corporate network with URL-rewriting / safelinks            | The `GET`-safe design means a security gateway pre-fetching the URL doesn't accidentally ack. POST is only fired by the SPA's button click after page load.                                                                                                 |

---

## Testing strategy

### Unit (vitest, no DB)

- `generateAckToken()` — uniqueness across N=10 000 calls; correct length;
  base64url character set only (`A-Za-z0-9_-`).
- `alertTemplates.buildSmsBody / buildWhatsAppBody / buildEmailHtml` —
  given a fixed `ackUrl`, assert it appears in the output, isn't truncated,
  and is escaped/encoded correctly.

### Integration (vitest with PG)

- `POST` with valid token → all matching `state_id` rows acked, exactly one
  audit row written.
- `POST` with valid token, **twice** → second call returns
  `{acked:0, alreadyAcked:true}`; no second audit row.
- `POST` with expired token → 410.
- `POST` with random/invalid token → 404.
- `GET` vs `POST` — `GET` on a valid token does not modify any row.
- Per-event cascade — 3 recipients × 2 channels = 6 alert rows for one
  `state_id`; one POST → all 6 acked.
- Race — two parallel POSTs from different tokens but same `state_id` —
  both return success; total `acked` across the two responses sums correctly
  (no double-counting because of `WHERE acknowledged_at IS NULL`).

### Manual smoke (post-deploy)

1. Trigger a STOP on a demo location.
2. Verify the email / SMS / WhatsApp messages contain a working link.
3. Click the link on a phone that's _not_ logged in — page renders, state
   colour correct.
4. Tap **Acknowledge** → confirmation appears. Dashboard reflects the change
   within 30 s (next risk-engine tick or websocket push).
5. Click again → "already acknowledged".
6. Wait 48 h, click an old link → "expired".

---

## Rollout

- Backwards-compatible. New columns are nullable. Existing alerts
  (pre-deploy) have `NULL` token and never get a link.
- Dispatch code generates tokens unconditionally going forward.
- No client-side breakage — `/a/:token` is a new route alongside `/register`.
- Single deploy. No flag-gating needed.

---

## Files touched

New:

- `server/publicAckRoutes.ts` — public GET + POST endpoints
- `client/src/AckPage.tsx` — public ack page rendering the seven states above
- `client/src/utils/maskEmail.ts` — small helper (`a***@example.com` style)
- `server/tests/publicAck.integration.test.ts` — DB-backed integration tests
- `server/tests/alertTemplates.test.ts` — pure body-builder unit tests

Modified:

- `server/alertTemplates.ts` — body builders take `ackUrl`
- `server/alertService.ts` — generate token, pass `ackUrl` to builders, store
  on `addAlert`
- `server/queries.ts` — `addAlert` accepts the new fields
- `server/audit.ts` — `actor_override` parameter
- `server/migrate.ts` — `runOnce('20260502-alerts-ack-token', …)` adds
  columns + partial unique index
- `server/index.ts` — mount `publicAckRoutes`
- `client/src/App.tsx` — public route `/a/:token`
- `db/schema.sql` — snapshot the new columns + index
- `server/tests/` — new test files for the public endpoint and template
  builders

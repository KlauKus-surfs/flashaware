# FlashAware — Troubleshooting Runbook

On-call diagnostic guide, organised by symptom. For routine ops procedures
see `OPERATIONS.md`; for architecture see `ARCHITECTURE.md`.

Every section follows the same shape: **symptom → likeliest causes →
diagnostic checks → fix**. The diagnostics assume `fly` CLI is available.

The single richest signal in this system is `GET /api/health` — it returns
DB status, feed staleness/tier, websocket connections, and notifier
capability flags in one payload. Hit it first whenever something seems off.

```bash
curl -s https://lightning-risk-api.fly.dev/api/health | jq
```

Then `/api/health/feed` (just the staleness view) and the live machine logs:

```bash
fly logs -a lightning-risk-api
fly logs -a lightning-risk-ingestion
```

---

## Risk states stuck on DEGRADED

**Cause.** The risk engine flips a location to DEGRADED when the most recent
flash event is older than ~25 minutes. The check lives in `server/riskEngine.ts`
and uses `getLatestIngestionTime()` against `flash_events.flash_time_utc`.

**Diagnose.**

1. `curl -s .../api/health/feed` — returns `dataAgeMinutes`. If it's > 25
   the engine cannot trust the feed and is doing the right thing.
2. Look at the ingestion app: `fly status -a lightning-risk-ingestion`. Has
   the machine restarted recently? Is it actually running?
3. `fly logs -a lightning-risk-ingestion` — look for `Login error`, `OAuth`,
   or `404` from EUMETSAT. Credentials expire silently.

**Fix.**

- **EUMETSAT auth failure:** rotate `EUMETSAT_CONSUMER_KEY` and
  `EUMETSAT_CONSUMER_SECRET` via `fly secrets set -a lightning-risk-ingestion`.
  The collector exits with code 1 after 10 consecutive failures and Fly
  restarts it.
- **No products available** (rare): check
  https://api.eumetsat.int/data/search-products/ for collection
  `EO:EUM:DAT:0691`. Sometimes EUMETSAT has a publishing gap; nothing to do
  but wait it out and add an incident note.
- **Ingestion machine wedged** (rare): `fly machine restart -a
lightning-risk-ingestion <machine_id>`.

---

## No flashes appearing on the dashboard

**Cause.** The ingestion side is succeeding (DEGRADED is not firing) but
the API or dashboard isn't seeing them.

**Diagnose.**

1. `curl -s .../api/health | jq .flashCount` — flashes in the last hour. If
   non-zero, the issue is client-side (cache, websocket).
2. `fly ssh console -a lightning-risk-api -C "psql $DATABASE_URL -c 'SELECT
COUNT(*) FROM flash_events WHERE flash_time_utc >= NOW() - interval
''10 minutes'';'"` — direct DB read.
3. Browser devtools → WebSocket frames. The dashboard re-renders on
   `risk-state-change` and `alert-triggered` (see
   `server/websocket.ts`). If those fire but the map stays empty, the
   issue is the dashboard's flash-fetch query, not the socket.

**Fix.**

- Refreshing the page reconnects the websocket — clears most stuck states.
- Check `recipient_phone_otps` is not 100 % full of expired rows; same DB,
  shared write contention.

---

## Alerts not being delivered

**Cause.** Notifier mis-configuration, per-state opt-out, or per-recipient
opt-out.

**Diagnose.**

1. `curl -s .../api/health | jq .notifiers` — the three booleans tell you
   whether the channels can dispatch at all. Source of truth:
   `getNotifierCapabilities()` in `server/alertService.ts`.
2. If a flag is `false`, the channel is missing config:
   - **Email:** `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`.
   - **SMS:** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`.
   - **WhatsApp:** as above plus `TWILIO_WHATSAPP_FROM`.
3. If the flag is `true` but a specific recipient isn't getting alerts:
   check `recipients.notify_states` (per-state opt-in array) and
   `recipients.notify_email`/`notify_sms`/`notify_whatsapp` per-channel
   booleans. Default: opted-in.
4. Check `alerts` table for the most recent transition: was a row written?
   What's `error`? What's `delivered_at` vs `sent_at`?

**Fix.**

- Set the missing secret with `fly secrets set -a lightning-risk-api KEY=value`.
  The API restarts automatically after a secret change.
- Twilio SMS rejected: usually a malformed phone number. The client-side
  format is E.164. The OTP verification gate in `usePhoneVerification.ts`
  should have caught it earlier — if it didn't, log a bug.

---

## Ack links return 404 / "expired"

**Cause.** The tokenized URL `/a/<token>` is matched against `alerts.ack_token`
where `ack_token_expires_at > NOW()`. The token is generated at dispatch
time with a finite expiry (see `server/ackToken.ts`).

**Diagnose.**

1. SQL: `SELECT id, ack_token_expires_at, acknowledged_at, sent_at FROM
alerts WHERE ack_token = '<token from URL>';`. Three outcomes:
   - No row → token never existed (typo, log scrubber may have wiped it
     after PII scrub at 7 days).
   - Row exists, `acknowledged_at IS NOT NULL` → already acked once;
     subsequent clicks are no-ops by design.
   - `ack_token_expires_at < NOW()` → expired (default 24 h).
2. Check `ALERT_PII_SCRUB_DAYS` (default 7) — older alerts have their
   `ack_token` nulled out as part of POPIA scrubbing.

**Fix.**

- Expired/scrubbed: nothing to do — these are intentional. If users
  routinely complain, raise `ALERT_PII_SCRUB_DAYS` (and document why in
  the audit log) or shorten the link's lifetime so it's less likely to be
  clicked stale.
- If the route is genuinely broken (every link 404s), hit the route
  directly: `curl -i https://.../a/$KNOWN_GOOD_TOKEN`. Confirm the public
  ack route is mounted (see `server/index.ts` and `publicAckRoutes.ts`).

---

## Login fails immediately after a fresh deploy

**Cause.** `JWT_SECRET` not set, or set to the placeholder value
`change-me-to-a-random-secret-in-production`. The auth layer refuses to
sign tokens with the placeholder (loud warning at boot, returns 500 on
login).

**Diagnose.** `fly logs -a lightning-risk-api | grep JWT` — look for
`JWT_SECRET is using the default placeholder value`.

**Fix.** `fly secrets set -a lightning-risk-api JWT_SECRET=$(openssl rand -hex 32)`.

---

## Two machines both seem to be running the risk engine

**Cause.** The advisory-lock leader election in `server/leader.ts` should
make this impossible — only the lock holder runs the risk engine, retention,
and ingestion. If you see double, something is off.

**Diagnose.**

1. `psql ... -c "SELECT * FROM pg_locks WHERE locktype = 'advisory';"` —
   should show exactly one row holding the lock for the FlashAware key.
2. `fly logs -a lightning-risk-api | grep -i 'leader\|demoted\|elected'` —
   look for promotion/demotion churn.

**Fix.**

- Demote a follower by sending it `SIGTERM`: `fly machine stop <id> -a
lightning-risk-api`. It will re-attempt election on restart and lose to
  the existing leader.
- If the lock is genuinely orphaned (a dead connection still holding it),
  Postgres clears it on connection timeout. Force it with:
  `psql ... -c "SELECT pg_terminate_backend(pid) FROM pg_locks WHERE
locktype='advisory' AND granted IS TRUE;"` (do this only if you've
  verified the lock holder is actually dead).

---

## Migrations failing at boot

**Cause.** `server/migrate.ts` runs always-runs idempotent DDL plus
one-shot backfills tracked in a `migration_log` table. A failure at boot
usually means either:

- A backfill is mid-run on another machine (concurrent boot race).
- DDL is failing because the DB is in an unexpected state (e.g. a column
  was renamed by hand).

**Diagnose.** `fly logs -a lightning-risk-api | grep -A5 migration`. Each
backfill logs a name on enter and "OK" on success.

**Fix.**

- Concurrent race: kill all but one machine, let it complete, then start
  the others. Subsequent machines see the `migration_log` row and skip.
- DDL drift: read the failing statement, fix the schema by hand
  (`psql ...`), and add a one-shot `runOnce` entry in `migrate.ts` to
  document the manual fix for future fresh deploys.

---

## Help, none of this matches

1. Pull `/api/health` and the last 200 log lines from both apps.
2. Capture a `pg_dump` (see OPERATIONS.md → Backups → Manual snapshot).
3. Open a GitHub issue with the above — engineering will triage. Don't
   try `git revert` on master without a working theory; this system runs
   live operational decisions.

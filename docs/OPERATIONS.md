# FlashAware — Operations Runbook

Production operational procedures for the Fly.io deployment. For local
development setup see `SETUP.md`. For system architecture see
`docs/ARCHITECTURE.md`.

---

## Backups

Fly.io's free Postgres tier does **not** include automated backups. Plan
either daily snapshots from a host you control, or upgrade to a paid plan
with managed backups.

### Manual snapshot (any host with `fly` CLI installed)

`fly secrets list` does not expose secret values, so the DB password has to
come from somewhere you already control — your password manager, the Fly
dashboard, or `fly postgres ...` output captured at provisioning time.

```bash
# Open a tunnel in the background.
fly proxy 5433:5432 -a lightning-risk-db &

# Provide the password out-of-band; do NOT paste it on the command line.
read -s PGPASSWORD; export PGPASSWORD
pg_dump -h 127.0.0.1 -p 5433 -U postgres -d lightning_risk -Fc \
  -f "backups/lightning_$(date -u +%Y%m%d_%H%M).dump"
unset PGPASSWORD
kill %1
```

Store the resulting `.dump` file off-Fly (S3 / R2 / GCS / GitHub artifact).

### Scheduled backups

`.github/workflows/backup.yml` runs daily at **02:00 UTC** and uploads a
custom-format `pg_dump` as a workflow artifact with **14-day retention**.

Required GitHub configuration:

| Kind   | Name                 | Purpose                                    |
| ------ | -------------------- | ------------------------------------------ |
| Secret | `FLY_API_TOKEN`      | Already exists for the deploy workflow.    |
| Secret | `BACKUP_DB_PASSWORD` | Postgres password for the DB user below.   |
| Var    | `BACKUP_DB_APP`      | Optional; defaults to `lightning-risk-db`. |
| Var    | `BACKUP_DB_NAME`     | Optional; defaults to `lightning_risk`.    |
| Var    | `BACKUP_DB_USER`     | Optional; defaults to `postgres`.          |

Trigger an out-of-cycle run via the **Actions → Backup Postgres → Run
workflow** button. Failed runs surface as red badges in the Actions tab —
make sure someone is watching them.

If you outgrow GitHub artifact storage (5 GB org-wide, 14-day retention is
already configured here), swap the upload step for an `aws s3 cp` against
a versioned R2/S3 bucket. The dump format and proxy logic stay the same.

### Restore

```bash
fly proxy 5433:5432 -a lightning-risk-db
pg_restore -h 127.0.0.1 -p 5433 -U postgres -d lightning_risk \
  --clean --if-exists backups/lightning_YYYYMMDD_HHMM.dump
```

### Restore drill

`.github/workflows/backup-restore-drill.yml` runs at **04:00 UTC on the
1st of Jan / Apr / Jul / Oct** and on `workflow_dispatch`. It pulls the
most recent successful artifact from the backup workflow, restores it
into a throwaway `postgis/postgis:16-3.4` service container, and runs
smoke queries (table count, PostGIS version, core tables non-empty,
locations geometry valid).

A red badge on this workflow means the backup is **not** restorable
right now — investigate before the next real incident demands it.
Run an out-of-cycle drill before any Postgres major-version upgrade
or large schema change.

---

## Data retention & PII scrubbing

The retention job runs every 6 hours from the leader machine
(`server/index.ts` → `runRetention`):

| Table                          | Action                          | Default window     | Env var                |
| ------------------------------ | ------------------------------- | ------------------ | ---------------------- |
| `alerts`                       | Scrub `recipient`, `twilio_sid` | 7 days             | `ALERT_PII_SCRUB_DAYS` |
| `alerts`                       | Hard-delete                     | 30 days            | `DATA_RETENTION_DAYS`  |
| `flash_events`                 | Hard-delete                     | 30 days            | `DATA_RETENTION_DAYS`  |
| `risk_states`                  | Hard-delete                     | 30 days            | `DATA_RETENTION_DAYS`  |
| `audit_log`                    | Hard-delete (min 90 days)       | max(retention, 90) | n/a                    |
| `organisations` (soft-deleted) | Hard-delete after grace         | 30 days            | `ORG_HARD_DELETE_DAYS` |

The PII scrub keeps the alert row (state, location, time) for audit while
removing identifying data — this satisfies POPIA "minimum necessary"
without losing the operational trail.

---

## Common ops commands

```bash
# Health
curl https://flashaware.fly.dev/api/health
curl https://flashaware.fly.dev/api/health/feed

# Logs (last 5 min)
fly logs -a lightning-risk

# Live shell
fly ssh console -a lightning-risk

# Force a redeploy (no code change)
fly deploy -a lightning-risk --strategy=immediate

# Scale memory if OOM-ing
fly scale memory 512 -a lightning-risk

# Rotate JWT secret (forces all users to re-login)
fly secrets set JWT_SECRET="$(openssl rand -base64 48)" -a lightning-risk
```

---

## Risk-engine alert delivery: known caveats

The risk engine writes the new `risk_states` row, broadcasts the WS event,
then dispatches alerts. These three steps are **not transactional**: a
process crash between the `logEvaluation` insert and the `dispatchAlerts`
call can lose a one-shot alert.

- **STOP / HOLD recover automatically.** The persistence-alert path
  (`persistence_alert_min`, default 10 minutes) re-checks every cycle and
  re-dispatches if no alert has gone out for the location recently. So a
  lost STOP alert is at most ~10 minutes late, not lost forever.
- **One-shot transitions can be missed.** A clean PREPARE→PREPARE state
  has no persistence retry. If the API process crashes after writing the
  PREPARE row but before `dispatchAlerts` returns, the next tick sees
  `previousState=PREPARE` and won't re-fire. The dashboard correctly shows
  PREPARE; outbound email/SMS/WhatsApp for that single state change is the
  only thing missed.
- **DEGRADED is similar.** A one-shot DEGRADED transition can be lost the
  same way; the next non-DEGRADED→DEGRADED tick re-dispatches.

If this becomes a real operational issue (e.g. legal exposure on missed
PREPARE notifications), the fix is to wrap `logEvaluation` and
`dispatchAlerts` enqueue in a transaction with an outbox row, then drain
the outbox in a separate worker. We have not done this yet because the
crash window is small (single-digit milliseconds between two awaited DB
calls) and the operational cost of the more complex design exceeds the
current incident rate. Re-evaluate if we ever observe a lost alert in
practice.

---

## Incident: ingestion lag

`/api/health/feed` returns `dataAgeMinutes`. If it exceeds 25 minutes the
risk engine shifts every location into `DEGRADED`. Diagnostic order:

1. `fly logs -a lightning-risk` — look for `collector` warnings about
   EUMETSAT API failures or auth errors.
2. Confirm `EUMETSAT_CONSUMER_KEY` / `SECRET` are still valid (they expire
   yearly with EUMETSAT).
3. Check EUMETSAT status page for outages.
4. The collector has 3-attempt exponential backoff; if it gives up the
   next cycle (default 120s) tries again. No action needed for transient
   failures.

---

## Incident: notifier failure

`/api/health` exposes `notifiers.{email,sms,whatsapp}_enabled`. If a flag
is `false`, the corresponding channel is misconfigured (missing env var)
and no alerts will go out on that channel. Check:

- Email: `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` set as Fly secrets.
- SMS: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`.
- WhatsApp: as above plus `TWILIO_WHATSAPP_FROM`.

A failure-to-send (e.g. provider rate-limit) is logged but does not flip
the capability flag — that flag only reflects configuration completeness.

---

## Audit-log retention (90-day floor)

The retention job in `server/index.ts` enforces

```
auditRetentionDays = Math.max(DATA_RETENTION_DAYS, 90)
```

so the audit log is **never** purged sooner than 90 days even if
`DATA_RETENTION_DAYS` is set lower. Two reasons:

1. **Incident reconstruction.** STOP/PREPARE state changes drive
   real-world decisions (closing a mine shaft, evacuating a site). If
   a regulator, customer, or insurer asks "who acknowledged the 14:32
   alert at Rustenburg three months ago?", we need an answer. Other
   tables (`risk_states`, `alerts`) get scrubbed and purged on the
   shorter window; the audit log is what's left.
2. **POPIA / compliance trail.** The audit log records the
   _processing activities_ — who did what, when. It's the legal-basis
   evidence for every alert dispatched. Scrubbing it too aggressively
   removes the audit trail that protects the operator.

**If you ever need to lower the 90-day floor**, change the constant in
`server/index.ts`, document the regulatory or contractual basis here in
OPERATIONS.md, and reference the decision in the audit log itself. Do
not tune this down to save DB space — `flash_events` and `risk_states`
dominate row count by orders of magnitude; the audit table is small.

---

## Decommissioned services

### `lightning-risk-ingestion` (Fly app) — removed

A separate Python ingestion worker used to run as its own Fly app. It is
no longer deployed: the API process runs EUMETSAT ingestion in-process
via `server/eumetsatService.ts`, gated behind the same advisory-lock
leader election as the risk engine and retention jobs.

The standalone worker had drifted out of usefulness:

- Its `lightning-risk-ingestion` Fly app had no `EUMETSAT_CONSUMER_KEY`
  / `_SECRET` set, so every cycle failed with HTTP 401 on the EUMETSAT
  token endpoint.
- It was attached to a separate Fly Postgres database
  (`lightning_risk_ingestion`, distinct from the API's
  `lightning_risk_api`), so even if it had been authenticating its
  writes would never have reached the API's `flash_events` table.

Both the GitHub Actions deploy job and the manual `deploy.sh` step have
been removed. If you set up FlashAware before the change, destroy the
orphaned Fly app once with:

```bash
fly apps destroy lightning-risk-ingestion
```

Postgres-side, the `lightning_risk_ingestion` database can be dropped
once the app is gone — it holds at most a stale, empty `ingestion_log`.
The Python source under `ingestion/` (`collector.py`, `ingester.py`)
remains in the repo as a dev-only fallback for one-shot local
ingestion of `.nc` files; `parse_nc_json.py` is still imported by the
API at runtime, so don't delete the directory.

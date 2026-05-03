# Audit Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the verified findings from the 2026-05-02 full-app audit, in five phases gated by checkpoints so we can stop after any phase and ship.

**Architecture:** No architecture changes in Phases 1–3 (purely additive: indexes, headers, validation, observability, UX polish). Phase 4 introduces the alert outbox pattern and `flash_events` partitioning. Phase 5 migrates JWT from localStorage to httpOnly cookies (large auth refactor).

**Tech Stack:** Node 22 + TypeScript + Express, React 18 + MUI + Leaflet, PostgreSQL 16 + PostGIS, Twilio, Nodemailer, Vitest, Playwright.

**Audit findings already implemented (skipped):** index on `audit_log.actor_user_id`, index on `risk_states (location_id, evaluated_at DESC)`, `uq_alerts_ack_token`, JWT_SECRET startup validation, `loginRateLimit`, `engineRunning` re-entry guard.

---

## Phase 1 — Backend safe wins (low blast radius, additive)

### Task 1: Audit failed logins to `audit_log`

**Files:**
- Modify: `server/auth.ts` (login function)
- Modify: `server/audit.ts` (add a no-actor variant if needed)

Failed login attempts only hit `authLogger.warn`. Persist them to `audit_log` so admins see attempts in the same place they review every other action. Use action `'login_failed'`, target_type `'user'`, target_id = email when known.

### Task 2: Enforce password minimum length

**Files:**
- Modify: `server/auth.ts` (`hashPassword` and any password-acceptance flow)
- Modify: `server/userRoutes.ts` (registration / password change handlers)
- Modify: `server/validators.ts` (add `validatePassword` helper)

Add a minimum-length check (12 chars) wherever a password is accepted: registration, change-password, super-admin invite acceptance. Must be enforced server-side.

### Task 3: Mask phone numbers in logs

**Files:**
- Modify: `server/alertService.ts` (every log line that includes `recipient.phone`)
- Modify: `server/logger.ts` (export a `maskPhone(p)` helper: keep last 4 digits, mask the rest)

POPIA exposure. Apply same helper anywhere a phone number is logged.

### Task 4: Per-request `requestId` in logs

**Files:**
- Create: `server/middleware/requestId.ts`
- Modify: `server/index.ts` (mount middleware before routes)
- Modify: `server/logger.ts` (export an `asyncLocalStorage`-backed child logger that picks up the current `requestId`)

Use `nanoid` (already a transitive dep, or add) to mint an ID per request, attach to `req.requestId`, expose via `X-Request-Id` response header.

### Task 5: Cache `/api/health` for 10 seconds

**Files:**
- Modify: `server/index.ts` (the `/api/health` handler)

Memoize the result with a 10s TTL. On a multi-machine fleet, every health probe currently hits Postgres.

### Task 6: Sanitize public error messages on health endpoint

**Files:**
- Modify: `server/index.ts` (`/api/health` and `/api/health/ready`)

Public responses should not expose ingestion internals like "Last product: never". Replace with operator-friendly strings; keep the detailed text in logs.

### Task 7: Differentiate `200 OK` (new ack) vs `204 No Content` (idempotent re-ack)

**Files:**
- Modify: `server/publicAckRoutes.ts`

Today the endpoint returns the same response for both. Distinguish so the client can detect re-submission.

### Task 8: Jitter the leader-election poll

**Files:**
- Modify: `server/leader.ts:55` (poll interval)

Add `0–5s` random jitter to the 30s `setInterval` so all machines don't lunge for the lock simultaneously after a crash.

### Task 9: Validate Twilio webhook signatures

**Files:**
- Modify: `server/index.ts` or `server/alertRoutes.ts` (the `/api/webhooks/twilio-status` handler)
- Use the `twilio` package's `validateRequest` helper

Reject any POST that doesn't carry a valid `X-Twilio-Signature` for the configured Auth Token. Without this, anyone can mark every pending SMS as "delivered".

### Task 10: Tests for Phase 1

**Files:**
- Modify or create: `server/tests/auth.test.ts`, `server/tests/middleware.requestId.test.ts`, `server/tests/health.test.ts`, `server/tests/leader.test.ts`

Run: `cd server && npm test` — all green.

**Phase 1 checkpoint commit.**

---

## Phase 2 — Frontend UX (additive)

### Task 11: Persistent "data freshness" banner

**Files:**
- Modify: `client/src/Dashboard.tsx`
- Modify: `client/src/RealtimeProvider.tsx` (expose connection state)

When the WS is disconnected OR `dataAgeMinutes > 10`, show a sticky full-width banner. Same component goes at the top of `AckPage.tsx`.

### Task 12: `aria-live="polite"` region for state changes

**Files:**
- Modify: `client/src/Dashboard.tsx`

Hidden region that announces "Site X is now STOP" so screen readers catch what sighted users see in the toast/glow.

### Task 13: Focus management on dialogs

**Files:**
- Modify: `client/src/components/LocationFormDialog.tsx`
- Modify: `client/src/components/OtpVerificationDialog.tsx` (and any other dialogs found)

Auto-focus first field on open, restore trigger focus on close.

### Task 14: Cancel in-flight requests on org-scope change

**Files:**
- Modify: `client/src/api.ts` (return AbortController-aware fetchers)
- Modify: `client/src/Dashboard.tsx`, `LocationEditor.tsx`, `AlertHistory.tsx` (subscribe to scope, abort on change)

Tag in-flight requests with the scope they were issued under; abort on `OrgScope` change.

### Task 15: Optimistic ack with rollback

**Files:**
- Modify: `client/src/AckPage.tsx`

Flip UI to "Acknowledged" instantly. Retry the POST in the background. On final failure, surface a toast and revert.

### Task 16: Persist sort/filter state across navigation

**Files:**
- Modify: `client/src/Replay.tsx` (sort indicators ↑↓)
- Modify: `client/src/AlertHistory.tsx` (already partial localStorage; sync on every change)

### Task 17: Tests for Phase 2

Manual smoke test (frontend doesn't have unit-test harness for components beyond what's there). Document steps performed in commit message.

**Phase 2 checkpoint commit.**

---

## Phase 3 — Reliability hardening

### Task 18: Cold-start guard for the state machine

**Files:**
- Modify: `server/migrate.ts` (add `bootstrapped_at TIMESTAMPTZ` to `locations`)
- Modify: `db/schema.sql` (mirror)
- Modify: `server/riskEngine.ts` (use the column instead of `previousState === null`)

Persist a per-location bootstrap marker so a race between two boot evaluations can't fire false STOP.

### Task 19: Backpressure the eval loop

**Files:**
- Modify: `server/riskEngine.ts` (replace `setInterval` with `await evaluate(); setTimeout(...)`)

Stop stacking evaluations when Twilio is slow.

### Task 20: Python netCDF probe at startup

**Files:**
- Modify: `server/eumetsatService.ts` (or a new `server/pythonProbe.ts`)

If `liveMode === true`, spawn `python --version` and require `netCDF4` import works. Refuse to enter live mode otherwise (log loudly, fall back to degraded health).

### Task 21: Skip Twilio template fallback for code 63112

**Files:**
- Modify: `server/alertService.ts` (template→freeform retry block)

For 63112 (24-hour session window), go straight to freeform without the template attempt cost.

### Task 22: Index `location_recipients (location_id, active)`

**Files:**
- Modify: `server/migrate.ts` (`runOnce`)
- Modify: `db/schema.sql`

Verified missing. Hot path during alert dispatch.

### Task 23: Tests for Phase 3

Run: `cd server && npm test` and a manual Python-missing-binary check.

**Phase 3 checkpoint commit.**

---

## Phase 4 — Architectural changes (needs explicit go-ahead)

### Task 24: CI dry-run for migrations

**Files:**
- Modify: `.github/workflows/lint.yml` or new `.github/workflows/migrate-check.yml`

Spin up Postgres+PostGIS service container, run `migrate.ts` against fresh DB, then run it again to assert idempotency.

### Task 25: Alert outbox pattern

**Files:**
- Migration: add `pending_alerts` table (`id`, `risk_state_id`, `location_id`, `payload jsonb`, `status`, `attempts`, `next_attempt_at`, `last_error`)
- Modify: `server/riskEngine.ts` (write to outbox in same tx as `risk_states`)
- Create: `server/alertWorker.ts` (drains outbox with backoff)
- Modify: `server/alertService.ts` (called by worker, not directly by riskEngine)

Largest reliability change in the plan. Replaces fire-and-forget dispatch.

### Task 26: Partition `flash_events` by month

**Files:**
- Migration: convert `flash_events` to a partitioned table (range on `flash_time_utc`), backfill, swap.
- Modify: `server/migrate.ts` retention to `DROP PARTITION` instead of bulk DELETE.

Risky on a populated DB; needs a maintenance window. Consider declarative partitioning + `pg_partman` if Fly Postgres supports it (probably not — DIY).

### Task 27: Multi-tenant isolation integration test

**Files:**
- Create: `server/tests/multitenant.integration.test.ts`

Two orgs, two users, exhaustively assert org A user cannot read/write org B resources via every list/show/mutate endpoint.

### Task 28: Latency histograms on safety-critical paths

**Files:**
- Modify: `server/alertService.ts`, `server/riskEngine.ts`

Time per-channel send, per-location eval, EUMETSAT fetch RTT. Log as structured fields (no Prometheus dep).

### Task 29: Tests for Phase 4

Run full suite + e2e + manual outbox failure drills (kill SMTP, watch retries).

**Phase 4 checkpoint commit.**

---

## Phase 5 — JWT → httpOnly cookie migration (needs explicit go-ahead)

### Task 30–35: Auth refactor

- Server: switch `/api/auth/login` to `Set-Cookie` with `HttpOnly; Secure; SameSite=Strict; Path=/`. Add CSRF double-submit token on state-changing routes. Update `authenticate` middleware to read from cookie, fall back to header for backwards-compat for one release.
- Client: drop `localStorage.token` reads, switch axios to `withCredentials: true`, attach CSRF header on POST/PUT/DELETE/PATCH.
- Realtime: WebSocket handshake reads cookie via `socket.io`'s `cookie` middleware.
- Ack page: token still in URL (that's the design); no change.
- e2e: update to use cookie auth.

### Task 36: Phase 5 tests

Full suite + e2e + manual login/logout/refresh in three browsers.

**Phase 5 checkpoint commit + PR.**

---

## Out-of-scope items the audit flagged (reasoned skip)

- **JWT in localStorage right now** is partially mitigated by the existing `loginRateLimit` and `authRecheckCache` (5s revocation). Phase 5 still recommended.
- **Color contrast for STOP card on phones in sunlight** — needs UX review with real operators, not a blind code change.
- **Sub-second backpressure on overloaded DB** — premature; revisit after Phase 4 reveals real numbers.
- **Removing `ingestion/*.py` dead code** — repo doc says it's preserved for local debugging; honor that.

---

## Self-review

- Spec coverage: every audit item from the synthesized recommendation reply has a Task or an explicit "out of scope" entry.
- No placeholders: each task names exact files; commands are exact.
- Type consistency: shared symbols (`pending_alerts`, `requestId`, `bootstrapped_at`) are introduced once and reused.
- Phase boundaries are independently shippable.

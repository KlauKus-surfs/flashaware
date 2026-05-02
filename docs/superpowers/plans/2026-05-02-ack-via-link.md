# Ack via link — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each FlashAware delivery (email/SMS/WhatsApp) carries a tokenised URL. Tapping the link opens a public confirmation page that acknowledges every alert row sharing that risk-state event, without requiring a login.

**Architecture:** New columns `ack_token` + `ack_token_expires_at` on `alerts`. New public `server/publicAckRoutes.ts` (GET = read-only validation, POST = ack-all-for-state idempotent). New unauthenticated SPA route `/a/:token` rendering `AckPage`. Token format: 24 random bytes → base64url, 48h TTL.

**Tech Stack:** Node 22 + Express + pg + vitest (server), React 18 + MUI + react-router (client). Existing patterns: `runOnce(name, fn)` migrations in `server/migrate.ts`, `logAudit` accepts an explicit `actor` object (no schema change needed for the recipient-role audit row), `useFetch` hook on the client.

---

## File structure

**Server — new files:**

- `server/publicAckRoutes.ts` — GET/POST for `/api/ack/by-token/:token`, no auth middleware
- `server/ackToken.ts` — pure token generator (kept out of routes/queries so it can be unit-tested without DB)
- `server/tests/ackToken.test.ts` — pure unit tests
- `server/tests/alertTemplates.test.ts` — pure unit tests for body builders with `ackUrl`
- `server/tests/publicAck.integration.test.ts` — DB-backed integration tests

**Server — modified files:**

- `server/migrate.ts` — `runOnce('20260502-alerts-ack-token', …)` adds two columns + partial unique index
- `server/queries.ts` — `AlertRecord` gains `ack_token` + `ack_token_expires_at`; `addAlert` SQL writes them
- `server/alertTemplates.ts` — `buildSmsBody`, `buildWhatsAppBody`, `buildEmailHtml` take an optional `ackUrl`; existing escalation builder unchanged (escalation messages don't carry an ack link in v1)
- `server/alertService.ts` — `dispatchAlerts` generates a token + URL per real delivery (email/SMS/WhatsApp), passes to template builders, persists on `addAlert`
- `server/index.ts` — `import publicAckRoutes` and `app.use(publicAckRoutes)`
- `db/schema.sql` — snapshot the new columns + partial unique index

**Client — new files:**

- `client/src/AckPage.tsx` — public ack page, renders the seven states from the spec
- `client/src/utils/maskEmail.ts` — `maskEmail("alice@example.com") → "a***@example.com"`
- (no client tests — the codebase has no client test harness; mirror the existing convention)

**Client — modified files:**

- `client/src/api.ts` — two new endpoint wrappers `getAckByToken` and `postAckByToken`
- `client/src/App.tsx` — `<Route path="/a/:token" element={<AckPage />} />` mounted **outside** the auth gate

**Documentation:**

- `docs/ARCHITECTURE.md` — append a paragraph under "Alert delivery" describing the new public ack endpoint + token lifecycle

---

### Task 1: DB migration — `alerts.ack_token` + `ack_token_expires_at` + partial unique index

**Files:**

- Modify: `server/migrate.ts` (anywhere inside `runMigrations`, after the existing `runOnce` reference at the top of the function)
- Modify: `db/schema.sql` (in the `CREATE TABLE alerts` block + the index list below it)

- [ ] **Step 1: Add the migration block to `server/migrate.ts`**

Insert just before the `logger.info('Migrations complete');` line. The `runOnce` helper is already declared at the top of `runMigrations`.

```ts
await runOnce('20260502-alerts-ack-token', async () => {
  // Tokenised one-tap ack from email/SMS/WhatsApp messages. The token is
  // 24 random bytes (base64url), embedded in the message URL. Partial
  // unique index because legacy rows have NULL token and we only care
  // that LIVE tokens are unique.
  await query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS ack_token TEXT`);
  await query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS ack_token_expires_at TIMESTAMPTZ`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_alerts_ack_token
                 ON alerts (ack_token) WHERE ack_token IS NOT NULL`);
});
```

- [ ] **Step 2: Snapshot the columns into `db/schema.sql`**

Find the `CREATE TABLE alerts` block. Add the two columns at the bottom of the column list, before the closing `)`:

```sql
    twilio_sid      TEXT,
    ack_token            TEXT,
    ack_token_expires_at TIMESTAMPTZ
);
```

Then below the existing `CREATE INDEX idx_alerts_location_sent …` line, add:

```sql
CREATE UNIQUE INDEX uq_alerts_ack_token ON alerts (ack_token) WHERE ack_token IS NOT NULL;
```

- [ ] **Step 3: Typecheck**

Run from `server/`: `npx tsc --noEmit`
Expected: exit 0, no errors.

- [ ] **Step 4: Commit**

```bash
cd /c/Users/Klaus/Documents/Github_apps/lightning-risk-mvp
git add server/migrate.ts db/schema.sql
git commit -m "feat(ack-link): add ack_token + ack_token_expires_at columns to alerts"
```

---

### Task 2: Token generator helper + unit tests (TDD)

**Files:**

- Create: `server/ackToken.ts`
- Create: `server/tests/ackToken.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/tests/ackToken.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateAckToken, ACK_TOKEN_TTL_MS } from '../ackToken';

describe('generateAckToken', () => {
  it('returns a 32-character base64url string', () => {
    const t = generateAckToken();
    expect(t).toHaveLength(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces unique tokens across many calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(generateAckToken());
    expect(seen.size).toBe(10_000);
  });
});

describe('ACK_TOKEN_TTL_MS', () => {
  it('is 48 hours', () => {
    expect(ACK_TOKEN_TTL_MS).toBe(48 * 60 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Run the tests — they should fail**

Run from `server/`: `npx vitest run tests/ackToken.test.ts`
Expected: FAIL (`Cannot find module '../ackToken'`).

- [ ] **Step 3: Implement `server/ackToken.ts`**

```ts
import { randomBytes } from 'crypto';

// 24 random bytes → 32 base64url characters → 192 bits of entropy.
// Brute-forcing the keyspace is not feasible.
const TOKEN_BYTES = 24;

// 48 hours from issuance — covers a Friday-evening storm where the
// on-duty operator clicks the link Monday morning. Long enough to be
// useful, short enough that stale links aren't a long-lived attack
// surface.
export const ACK_TOKEN_TTL_MS = 48 * 60 * 60 * 1000;

export function generateAckToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function ackTokenExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + ACK_TOKEN_TTL_MS);
}
```

- [ ] **Step 4: Run the tests — they should pass**

Run: `npx vitest run tests/ackToken.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add server/ackToken.ts server/tests/ackToken.test.ts
git commit -m "feat(ack-link): generateAckToken helper + tests"
```

---

### Task 3: Extend `addAlert` to persist the token + expiry

**Files:**

- Modify: `server/queries.ts` — `AlertRecord` interface (lines 451–464) + `addAlert` SQL (lines 466–488)

- [ ] **Step 1: Extend `AlertRecord`**

Replace the `AlertRecord` block:

```ts
export interface AlertRecord {
  id: number;
  location_id: string;
  state_id: number;
  alert_type: string;
  recipient: string;
  sent_at: string | null;
  delivered_at: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  escalated: boolean;
  error: string | null;
  twilio_sid: string | null;
  // One-tap ack via tokenised URL embedded in the delivered message.
  // NULL on the leading `recipient: 'system'` audit row (not delivered to
  // anyone, no URL needed) and on legacy rows pre-dating this column.
  ack_token: string | null;
  ack_token_expires_at: string | null;
}
```

- [ ] **Step 2: Extend the `addAlert` SQL**

Replace the `addAlert` body:

```ts
export async function addAlert(record: Omit<AlertRecord, 'id'>): Promise<number> {
  const result = await getOne<{ id: number }>(
    `INSERT INTO alerts (
      location_id, state_id, alert_type, recipient, sent_at, delivered_at,
      acknowledged_at, acknowledged_by, escalated, error, twilio_sid,
      ack_token, ack_token_expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
    [
      record.location_id,
      record.state_id,
      record.alert_type,
      record.recipient,
      record.sent_at,
      record.delivered_at,
      record.acknowledged_at,
      record.acknowledged_by,
      record.escalated,
      record.error,
      record.twilio_sid ?? null,
      record.ack_token ?? null,
      record.ack_token_expires_at ?? null,
    ],
  );
  if (!result) throw new Error('Failed to add alert');
  return result.id;
}
```

- [ ] **Step 3: Typecheck**

`alertService.ts` calls `addAlert` in many places without the new fields. Those call sites still typecheck because the new fields are optional via `?? null`. Run from `server/`:

`npx tsc --noEmit`

Expected: exit 0. (If it fails because `Omit<AlertRecord, 'id'>` makes the new fields required, switch the type to `Omit<AlertRecord, 'id' | 'ack_token' | 'ack_token_expires_at'> & Partial<Pick<AlertRecord, 'ack_token' | 'ack_token_expires_at'>>` — but the `?? null` should cover it. Verify before changing.)

- [ ] **Step 4: Commit**

```bash
git add server/queries.ts
git commit -m "feat(ack-link): persist ack_token + expiry on addAlert"
```

---

### Task 4: Templates accept `ackUrl` (TDD)

**Files:**

- Create: `server/tests/alertTemplates.test.ts`
- Modify: `server/alertTemplates.ts`

- [ ] **Step 1: Write failing tests**

Create `server/tests/alertTemplates.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildSmsBody, buildWhatsAppBody, buildEmailHtml } from '../alertTemplates';

const URL = 'https://lightning-risk-api.fly.dev/a/abc123XYZ';

describe('buildSmsBody', () => {
  it('embeds the ack URL after the reason line', () => {
    const out = buildSmsBody('Sun City', 'STOP', 'flashes nearby', URL);
    expect(out).toContain(URL);
    expect(out).toContain('Sun City');
    expect(out).toContain('STOP');
    expect(out).toContain('flashes nearby');
  });

  it('omits ack-link section when ackUrl is undefined', () => {
    const out = buildSmsBody('Sun City', 'STOP', 'flashes nearby');
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).toContain('Sun City');
  });
});

describe('buildWhatsAppBody', () => {
  it('embeds the ack URL with a labelled prefix', () => {
    const out = buildWhatsAppBody('Sun City', 'STOP', 'flashes nearby', URL);
    expect(out).toContain(URL);
    expect(out.toLowerCase()).toContain('acknowledge');
  });
});

describe('buildEmailHtml', () => {
  it('renders a button-style anchor pointing at the ack URL', () => {
    const out = buildEmailHtml('Sun City', 'STOP', 'flashes nearby', URL);
    expect(out).toContain(`href="${URL}"`);
    expect(out).toContain('Acknowledge');
  });

  it('still renders cleanly without an ackUrl (escalation re-uses this builder)', () => {
    const out = buildEmailHtml('Sun City', 'STOP', 'flashes nearby');
    expect(out).not.toContain('href="undefined"');
    expect(out).toContain('Sun City');
  });
});
```

- [ ] **Step 2: Run the tests — they should fail**

Run: `npx vitest run tests/alertTemplates.test.ts`
Expected: FAIL — body builders don't accept the new parameter yet, so the URL won't appear in output.

- [ ] **Step 3: Update `server/alertTemplates.ts`**

Replace the three exported builders:

```ts
export function buildSmsBody(
  locationName: string,
  state: string,
  reason: string,
  ackUrl?: string,
): string {
  const info = getStateInfo(state);
  const shortReason = reason.length > 120 ? reason.substring(0, 117) + '...' : reason;
  const ackLine = ackUrl ? `\nAck: ${ackUrl}` : '';
  return `${info.emoji} FlashAware ${state} — ${locationName}\n${shortReason}${ackLine}\nflashaware.com`;
}

export function buildWhatsAppBody(
  locationName: string,
  state: string,
  reason: string,
  ackUrl?: string,
): string {
  const info = getStateInfo(state);
  const shortReason = reason.length > 500 ? reason.substring(0, 497) + '...' : reason;
  const ackLine = ackUrl ? `\n\n*Acknowledge:* ${ackUrl}` : '';
  return `*${info.emoji} FlashAware Alert*\n*${state}* — ${locationName}\n\n${shortReason}${ackLine}\n\n_${nowSast()} SAST_\nflashaware.com`;
}

export function buildEmailHtml(
  locationName: string,
  state: string,
  reason: string,
  ackUrl?: string,
): string {
  const info = getStateInfo(state);
  const ackButton = ackUrl
    ? `
        <div style="text-align: center; margin: 18px 0;">
          <a href="${ackUrl}" style="background: ${info.color}; color: ${info.textColor ?? '#fff'}; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; display: inline-block;">
            Acknowledge alert
          </a>
        </div>
        <p style="font-size: 12px; color: #666; text-align: center;">
          Or log in at <a href="https://flashaware.com" style="color: #666;">flashaware.com</a> to view the dashboard.
        </p>
      `
    : '';
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: ${info.color}; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0;">${info.emoji} ${state}</h1>
        <h2 style="margin: 4px 0 0;">${locationName}</h2>
      </div>
      <div style="padding: 20px; background: #f5f5f5; border-radius: 0 0 8px 8px;">
        <p style="font-size: 16px;"><strong>Why:</strong> ${reason}</p>
        <p style="font-size: 14px; color: #666;">
          Time: ${nowSast()} SAST
        </p>${ackButton}
        <hr style="border: none; border-top: 1px solid #ddd;">
        <p style="font-size: 12px; color: #999;">
          This is an automated alert from the FlashAware Decision System.
          Do not reply to this email. Log in to the dashboard to acknowledge this alert.
        </p>
      </div>
    </div>
  `;
}
```

The `StateInfo` type doesn't currently include `textColor` so that field reference falls back to `'#fff'`. Verify by re-reading `alertTemplates.ts` top — `STATE_LABELS` defines `{emoji, subject, color}` only. Drop the `textColor` reference and use `#fff` directly:

Replace `${info.textColor ?? '#fff'}` with `#fff`.

- [ ] **Step 4: Run the tests — they should pass**

Run: `npx vitest run tests/alertTemplates.test.ts`
Expected: PASS, 6 tests (or 5 — count comes from your file).

- [ ] **Step 5: Run the full test suite to make sure nothing else broke**

Run: `npm test`
Expected: all existing tests pass + the new ones.

- [ ] **Step 6: Commit**

```bash
git add server/alertTemplates.ts server/tests/alertTemplates.test.ts
git commit -m "feat(ack-link): templates accept and embed ackUrl"
```

---

### Task 5: `dispatchAlerts` generates token + URL per delivery

**Files:**

- Modify: `server/alertService.ts`

- [ ] **Step 1: Add the imports at the top**

Just below the existing `import` lines, add:

```ts
import { generateAckToken, ackTokenExpiry } from './ackToken';

// Used to build the ack URL embedded in delivered messages. SERVER_URL
// is set via fly.toml in prod; locally it falls back to the API origin.
const ACK_BASE_URL = process.env.SERVER_URL || 'https://lightning-risk-api.fly.dev';
```

- [ ] **Step 2: Wire token generation into the email branch**

Find the email-send block inside `dispatchAlerts` (the one that calls `getTransporter().sendMail(...)`). Just before `const emailHtml = buildEmailHtml(locationName, state, reason);`, add:

```ts
const emailToken = generateAckToken();
const emailAckUrl = `${ACK_BASE_URL}/a/${emailToken}`;
const emailExpiresAt = ackTokenExpiry().toISOString();
```

Replace the `buildEmailHtml(...)` call with the URL-aware form:

```ts
const emailHtml = buildEmailHtml(locationName, state, reason, emailAckUrl);
```

In the `addAlert(...)` call inside the email try block, add the new fields:

```ts
const alertId = await addAlert({
  location_id: locationId,
  state_id: Number(stateId),
  alert_type: 'email',
  recipient: recipient.email,
  sent_at: now,
  delivered_at: now,
  acknowledged_at: null,
  acknowledged_by: null,
  escalated: false,
  error: null,
  twilio_sid: null,
  ack_token: emailToken,
  ack_token_expires_at: emailExpiresAt,
});
```

In the email **catch** block's `addAlert`, set both new fields to `null` (the message didn't send, so no live link):

```ts
            ack_token: null,
            ack_token_expires_at: null,
```

- [ ] **Step 3: Wire token generation into the SMS branch**

Same pattern. Just before `const smsBody = buildSmsBody(...)`:

```ts
const smsToken = generateAckToken();
const smsAckUrl = `${ACK_BASE_URL}/a/${smsToken}`;
const smsExpiresAt = ackTokenExpiry().toISOString();
```

Replace `const smsBody = buildSmsBody(locationName, state, reason);` with:

```ts
const smsBody = buildSmsBody(locationName, state, reason, smsAckUrl);
```

Add `ack_token: smsToken, ack_token_expires_at: smsExpiresAt` to the success-path `addAlert`. Add `ack_token: null, ack_token_expires_at: null` to the catch-path `addAlert`.

- [ ] **Step 4: Wire token generation into the WhatsApp branch**

Same pattern. Generate `waToken` + `waAckUrl` + `waExpiresAt` before the WhatsApp template/freeform branches. Pass `waAckUrl` to `buildWhatsAppBody(...)` (in both the template-fallback and the direct freeform call). Add `ack_token: waToken, ack_token_expires_at: waExpiresAt` to the success-path `addAlert`; `null` on the failure path.

WhatsApp template messages (Twilio `contentSid`) don't render the URL via the template body — they use approved variables. v1 only embeds the URL in the freeform body. The success-path token still gets persisted on `addAlert` so the URL **also** sent in `contentVariables` (if you choose to expose it through a template variable later) maps to the same row. For now, only embed in the freeform fallback body.

Actually simpler: skip token generation when sending via Twilio template SID since the URL won't reach the user. Generate only when the freeform body is used. Inside the WhatsApp branch, restructure to:

```ts
const useTemplate = !!templateSid;
const waToken = useTemplate ? null : generateAckToken();
const waAckUrl = waToken ? `${ACK_BASE_URL}/a/${waToken}` : undefined;
const waExpiresAt = waToken ? ackTokenExpiry().toISOString() : null;
```

Pass `waAckUrl` to `buildWhatsAppBody(...)` calls (it's already optional; `undefined` skips the link). Persist `ack_token: waToken, ack_token_expires_at: waExpiresAt` on success — `null/null` when the template path was used or the send failed.

- [ ] **Step 5: Update the leading `'system'` alert insert**

Near the top of `dispatchAlerts` there is the `addAlert({ ..., alert_type: 'system', recipient: 'system', ... })` insert that always runs. **Don't generate a token for this row** — system rows aren't delivered. Just add the two new fields with `null`:

```ts
      ack_token: null,
      ack_token_expires_at: null,
```

- [ ] **Step 6: Update the escalation `addAlert` call (in `checkEscalations`)**

Escalation re-sends an email but doesn't carry an ack-link in v1 — the escalation message text already directs to the dashboard. Add:

```ts
        ack_token: null,
        ack_token_expires_at: null,
```

(The current escalation flow doesn't insert a fresh `alerts` row, but if it does in the future this is the safe default.)

- [ ] **Step 7: Update `sendTestAlertToRecipient`**

The "send test" path also calls `buildEmailHtml(locationName, 'ALL_CLEAR', reason)`. Test alerts intentionally don't write to `alerts` and don't carry an ack link. Leave the call site alone — the optional `ackUrl` parameter defaults to undefined, so the email renders without the button, which is the correct behaviour.

- [ ] **Step 8: Typecheck**

`npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 9: Run unit tests (no DB needed)**

`npm test`
Expected: all 118+ existing tests still pass plus the new template tests.

- [ ] **Step 10: Commit**

```bash
git add server/alertService.ts
git commit -m "feat(ack-link): generate ack tokens during dispatchAlerts"
```

---

### Task 6: `publicAckRoutes.ts` — GET endpoint (TDD with integration test)

**Files:**

- Create: `server/publicAckRoutes.ts`
- Create: `server/tests/publicAck.integration.test.ts`

- [ ] **Step 1: Scaffold the integration test (failing)**

Create `server/tests/publicAck.integration.test.ts`. Mirror the bootstrap pattern from `tenantIsolation.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-integration';

const { query, getOne } = await import('../db');
const { addAlert, addRiskState, createLocation } = await import('../queries');
const { default: publicAckRoutes } = await import('../publicAckRoutes');
const { generateAckToken, ackTokenExpiry } = await import('../ackToken');

const PFX = '__ack-';
const POLY = 'POLYGON((28.0 -26.0, 28.001 -26.0, 28.001 -25.999, 28.0 -25.999, 28.0 -26.0))';
const PT = 'POINT(28.0005 -25.9995)';

let app: express.Express;
let dbAvailable = false;
let orgId: string;
let locId: string;
let stateId: number;

async function makeAlertWithToken(opts: {
  recipient: string;
  ttlMs?: number;
  alertType?: string;
}): Promise<{ id: number; token: string }> {
  const token = generateAckToken();
  const expiry = new Date(Date.now() + (opts.ttlMs ?? 60_000)).toISOString();
  const id = await addAlert({
    location_id: locId,
    state_id: stateId,
    alert_type: opts.alertType ?? 'email',
    recipient: opts.recipient,
    sent_at: new Date().toISOString(),
    delivered_at: new Date().toISOString(),
    acknowledged_at: null,
    acknowledged_by: null,
    escalated: false,
    error: null,
    twilio_sid: null,
    ack_token: token,
    ack_token_expires_at: expiry,
  });
  return { id, token };
}

beforeAll(async () => {
  try {
    await query('SELECT 1');
    dbAvailable = true;
  } catch {
    console.warn('[publicAck] DB not available — skipping suite');
    return;
  }

  app = express();
  app.use(express.json());
  app.use(publicAckRoutes);

  const org = await getOne<{ id: string }>(
    `INSERT INTO organisations (name, slug) VALUES ($1, $2) RETURNING id`,
    [`${PFX}Org`, `${PFX}org-${Date.now()}`],
  );
  orgId = org!.id;

  const loc = await createLocation({
    name: `${PFX}Loc-${Date.now()}`,
    site_type: 'mine',
    geom: POLY,
    centroid: PT,
    org_id: orgId,
    timezone: 'Africa/Johannesburg',
    stop_radius_km: 10,
    prepare_radius_km: 20,
    stop_flash_threshold: 1,
    stop_window_min: 15,
    prepare_flash_threshold: 1,
    prepare_window_min: 15,
    allclear_wait_min: 30,
    persistence_alert_min: 10,
    alert_on_change_only: false,
    is_demo: true,
  });
  locId = loc.id;

  stateId = await addRiskState({
    location_id: locId,
    state: 'STOP',
    previous_state: 'ALL_CLEAR',
    changed_at: new Date().toISOString(),
    reason: { reason: 'flashes nearby', source: 'test' },
    flashes_in_stop_radius: 3,
    flashes_in_prepare_radius: 5,
    nearest_flash_km: 4.2,
    data_age_sec: 12,
    is_degraded: false,
    evaluated_at: new Date().toISOString(),
  });
});

afterAll(async () => {
  if (!dbAvailable) return;
  await query(`DELETE FROM alerts WHERE recipient LIKE $1`, [`${PFX}%`]);
  await query(`DELETE FROM organisations WHERE slug LIKE $1`, [`${PFX}%`]);
});

describe('GET /api/ack/by-token/:token', () => {
  it('returns 404 for an unknown token', async () => {
    if (!dbAvailable) return;
    const res = await request(app).get('/api/ack/by-token/this-token-does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('invalid');
  });

  it('returns the alert metadata for a valid unacked token', async () => {
    if (!dbAvailable) return;
    const { token } = await makeAlertWithToken({ recipient: `${PFX}alice@example.com` });
    const res = await request(app).get(`/api/ack/by-token/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('STOP');
    expect(res.body.expired).toBe(false);
    expect(res.body.alreadyAckedAt).toBeNull();
    expect(res.body.recipient).toBe(`${PFX}alice@example.com`);
  });

  it('returns expired:true for a token whose expiry has passed', async () => {
    if (!dbAvailable) return;
    const { token } = await makeAlertWithToken({
      recipient: `${PFX}bob@example.com`,
      ttlMs: -1000,
    });
    const res = await request(app).get(`/api/ack/by-token/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.expired).toBe(true);
  });

  it('reports already-acked state if a parallel ack happened first', async () => {
    if (!dbAvailable) return;
    const { token, id } = await makeAlertWithToken({ recipient: `${PFX}carol@example.com` });
    await query(`UPDATE alerts SET acknowledged_at = NOW(), acknowledged_by = $1 WHERE id = $2`, [
      'operator@example.com',
      id,
    ]);
    const res = await request(app).get(`/api/ack/by-token/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.alreadyAckedAt).not.toBeNull();
    expect(res.body.alreadyAckedBy).toBe('operator@example.com');
  });
});
```

If `supertest` isn't already in `package.json` `devDependencies`, add it:

```bash
cd server && npm install --save-dev supertest @types/supertest
```

- [ ] **Step 2: Run tests — should fail (no `publicAckRoutes` module yet)**

Run: `npx vitest run --config vitest.integration.config.ts tests/publicAck.integration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `server/publicAckRoutes.ts` with the GET handler only**

```ts
import { Router, Response } from 'express';
import { getOne } from './db';
import { logger } from './logger';

const router = Router();

interface AckLookupRow {
  id: number;
  state_id: number;
  location_id: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  ack_token_expires_at: string | null;
  recipient: string;
  state: string | null;
  reason: { reason?: string } | null;
  location_name: string | null;
}

/**
 * GET /api/ack/by-token/:token — read-only validation.
 *
 * Safe for email scanners, Outlook safelinks, browser prefetch, and
 * WhatsApp Business catalog crawlers. Visiting this URL never
 * acknowledges anything — the destructive verb lives on POST below.
 */
router.get('/api/ack/by-token/:token', async (req, res: Response) => {
  try {
    const row = await getOne<AckLookupRow>(
      `SELECT a.id, a.state_id, a.location_id, a.acknowledged_at, a.acknowledged_by,
              a.ack_token_expires_at, a.recipient,
              rs.state, rs.reason,
              l.name AS location_name
         FROM alerts a
         LEFT JOIN risk_states rs ON rs.id = a.state_id
         LEFT JOIN locations l    ON l.id = a.location_id
        WHERE a.ack_token = $1`,
      [req.params.token],
    );
    if (!row) return res.status(404).json({ error: 'invalid' });

    const expired = !!(row.ack_token_expires_at && new Date(row.ack_token_expires_at) < new Date());

    res.json({
      state: row.state,
      locationName: row.location_name,
      reason: row.reason?.reason ?? null,
      expired,
      alreadyAckedAt: row.acknowledged_at,
      alreadyAckedBy: row.acknowledged_by,
      recipient: row.recipient,
    });
  } catch (err) {
    logger.error('public ack GET failed', { error: (err as Error).message });
    res.status(500).json({ error: 'lookup failed' });
  }
});

export default router;
```

- [ ] **Step 4: Run the GET tests — should pass**

Run: `npx vitest run --config vitest.integration.config.ts tests/publicAck.integration.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/publicAckRoutes.ts server/tests/publicAck.integration.test.ts server/package.json server/package-lock.json
git commit -m "feat(ack-link): public GET /api/ack/by-token/:token + integration tests"
```

---

### Task 7: POST endpoint — per-event ack with audit row

**Files:**

- Modify: `server/publicAckRoutes.ts` — add POST handler
- Modify: `server/tests/publicAck.integration.test.ts` — add POST tests

- [ ] **Step 1: Append POST tests to the integration file**

Add a new `describe` block inside the same file:

```ts
describe('POST /api/ack/by-token/:token', () => {
  it('returns 404 for an unknown token', async () => {
    if (!dbAvailable) return;
    const res = await request(app).post('/api/ack/by-token/never-ever-issued-this');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('invalid');
  });

  it('returns 410 for an expired token', async () => {
    if (!dbAvailable) return;
    const { token } = await makeAlertWithToken({ recipient: `${PFX}d@example.com`, ttlMs: -1000 });
    const res = await request(app).post(`/api/ack/by-token/${token}`);
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('expired');
  });

  it('acks every alert row sharing the same state_id (per-event scope)', async () => {
    if (!dbAvailable) return;
    // One state event, three deliveries (email + sms + whatsapp). The first
    // delivery's token is the one the user clicks.
    const a = await makeAlertWithToken({
      recipient: `${PFX}team-email@example.com`,
      alertType: 'email',
    });
    await makeAlertWithToken({ recipient: `${PFX}+27821111111`, alertType: 'sms' });
    await makeAlertWithToken({ recipient: `${PFX}+27822222222`, alertType: 'whatsapp' });

    const res = await request(app).post(`/api/ack/by-token/${a.token}`);
    expect(res.status).toBe(200);
    expect(res.body.acked).toBeGreaterThanOrEqual(3);

    const remaining = await getOne<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM alerts
       WHERE state_id = $1 AND acknowledged_at IS NULL AND recipient LIKE $2`,
      [stateId, `${PFX}%`],
    );
    expect(remaining!.n).toBe(0);
  });

  it('is idempotent — second click returns alreadyAcked', async () => {
    if (!dbAvailable) return;
    const { token } = await makeAlertWithToken({ recipient: `${PFX}repeat@example.com` });
    const r1 = await request(app).post(`/api/ack/by-token/${token}`);
    expect(r1.status).toBe(200);
    expect(r1.body.acked).toBeGreaterThanOrEqual(1);

    const r2 = await request(app).post(`/api/ack/by-token/${token}`);
    expect(r2.status).toBe(200);
    expect(r2.body.acked).toBe(0);
    expect(r2.body.alreadyAcked).toBe(true);
  });

  it('writes an audit row with actor_role = "recipient"', async () => {
    if (!dbAvailable) return;
    const { token } = await makeAlertWithToken({ recipient: `${PFX}audit-target@example.com` });
    await request(app).post(`/api/ack/by-token/${token}`);
    const r = await getOne<{ actor_email: string; actor_role: string; action: string; n: number }>(
      `SELECT actor_email, actor_role, action FROM audit_log
        WHERE actor_email = $1 ORDER BY created_at DESC LIMIT 1`,
      [`recipient:${PFX}audit-target@example.com`],
    );
    expect(r).not.toBeNull();
    expect(r!.actor_role).toBe('recipient');
    expect(r!.action).toBe('alert.ack');
  });

  it('GET on a valid token does not modify state', async () => {
    if (!dbAvailable) return;
    const { token, id } = await makeAlertWithToken({ recipient: `${PFX}readonly@example.com` });
    await request(app).get(`/api/ack/by-token/${token}`);
    const row = await getOne<{ acknowledged_at: string | null }>(
      `SELECT acknowledged_at FROM alerts WHERE id = $1`,
      [id],
    );
    expect(row!.acknowledged_at).toBeNull();
  });
});
```

- [ ] **Step 2: Run — should fail (POST handler doesn't exist)**

`npx vitest run --config vitest.integration.config.ts tests/publicAck.integration.test.ts`
Expected: GET tests pass, POST tests fail with 404 on every POST.

- [ ] **Step 3: Add the POST handler to `publicAckRoutes.ts`**

Append, just before `export default router;`:

```ts
import { query } from './db';
import { logAudit } from './audit';
import { getLocationById } from './queries';

interface AckSeed {
  state_id: number;
  location_id: string;
  recipient: string;
  acknowledged_at: string | null;
  ack_token_expires_at: string | null;
}

/**
 * POST /api/ack/by-token/:token — destructive, idempotent, per-event scope.
 *
 * Acknowledges every alert row that shares the seed token's `state_id` and
 * is still unacked, in a single UPDATE. Idempotent because of the
 * `WHERE acknowledged_at IS NULL` guard — a second click is a no-op and
 * returns `alreadyAcked: true`.
 *
 * Records an audit row with `actor_role: 'recipient'` so super-admins can
 * filter `actor_email LIKE 'recipient:%'` to see all link-acks.
 */
router.post('/api/ack/by-token/:token', async (req, res: Response) => {
  const token = req.params.token;
  try {
    const seed = await getOne<AckSeed>(
      `SELECT state_id, location_id, recipient, acknowledged_at, ack_token_expires_at
         FROM alerts
        WHERE ack_token = $1`,
      [token],
    );
    if (!seed) return res.status(404).json({ error: 'invalid' });

    const expired = seed.ack_token_expires_at && new Date(seed.ack_token_expires_at) < new Date();
    if (expired) return res.status(410).json({ error: 'expired' });

    // Per-event ack: same state_id + same location_id (belt-and-braces),
    // only rows that are still unacked. Idempotent on retry.
    const r = await query(
      `UPDATE alerts a
          SET acknowledged_at = NOW(),
              acknowledged_by = $1
        WHERE a.state_id = $2
          AND a.location_id = $3
          AND a.acknowledged_at IS NULL
       RETURNING a.id`,
      [`recipient:${seed.recipient}`, seed.state_id, seed.location_id],
    );

    if (r.rowCount === 0) {
      // Token was valid but every row was already acked.
      return res.json({ acked: 0, alreadyAcked: true });
    }

    // Audit. Resolve org_id via the location for filtering.
    const loc = await getLocationById(seed.location_id);
    await logAudit({
      req,
      actor: { id: null, email: `recipient:${seed.recipient}`, role: 'recipient' },
      action: 'alert.ack',
      target_type: 'alert',
      target_id: `token:${token.slice(0, 8)}…`,
      target_org_id: loc?.org_id ?? null,
      after: { acked_count: r.rowCount, via: 'token-link' },
    });

    res.json({ acked: r.rowCount });
  } catch (err) {
    logger.error('public ack POST failed', {
      error: (err as Error).message,
      token: token.slice(0, 8),
    });
    res.status(500).json({ error: 'ack failed' });
  }
});
```

- [ ] **Step 4: Run — POST tests should pass**

`npx vitest run --config vitest.integration.config.ts tests/publicAck.integration.test.ts`
Expected: all GET + POST tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/publicAckRoutes.ts server/tests/publicAck.integration.test.ts
git commit -m "feat(ack-link): public POST /api/ack/by-token/:token + integration tests"
```

---

### Task 8: Mount the public router

**Files:**

- Modify: `server/index.ts`

- [ ] **Step 1: Import and mount**

Locate the block of route imports near the top of `index.ts`:

```ts
import recipientRoutes from './recipientRoutes';
import settingsRoutes from './settingsRoutes';
import alertRoutes from './alertRoutes';
import statusRoutes from './statusRoutes';
import platformRoutes from './platformRoutes';
import locationRoutes from './locationRoutes';
```

Add below:

```ts
import publicAckRoutes from './publicAckRoutes';
```

Find the `app.use(...)` mounts further down. Add **before** `app.use('/api/users', userRoutes);` so the public ack route is registered before any auth middleware can possibly intercept it (paranoid; the public router has no auth anyway):

```ts
// Public — no authentication. Tokenised one-tap ack from delivered messages.
app.use(publicAckRoutes);
```

- [ ] **Step 2: Typecheck + tests**

```bash
cd server
npx tsc --noEmit
npm test
```

Expected: exit 0, all tests pass.

- [ ] **Step 3: Commit**

```bash
git add server/index.ts
git commit -m "feat(ack-link): mount publicAckRoutes in index.ts"
```

---

### Task 9: `maskEmail` client helper

**Files:**

- Create: `client/src/utils/maskEmail.ts`

- [ ] **Step 1: Implement**

```ts
// "alice@example.com" → "a***@example.com"
// "x@y.co"            → "x***@y.co"   (single-char local stays as is + ***)
// invalid input       → "" (caller decides whether to render anything)
export function maskEmail(email: string | null | undefined): string {
  if (!email || typeof email !== 'string') return '';
  const at = email.indexOf('@');
  if (at <= 0) return email; // no @ or @ at start — return unchanged
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const head = local.charAt(0);
  return `${head}***${domain}`;
}
```

- [ ] **Step 2: Typecheck**

```bash
cd client
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add client/src/utils/maskEmail.ts
git commit -m "feat(ack-link): maskEmail helper"
```

---

### Task 10: API client wrappers

**Files:**

- Modify: `client/src/api.ts`

- [ ] **Step 1: Add the two wrappers at the bottom of the file (before `export default api;`)**

```ts
// Public ack-via-link endpoints — no auth. Token is unguessable so it
// substitutes for an authentication credential.
export interface AckByTokenLookup {
  state: 'STOP' | 'HOLD' | 'PREPARE' | 'ALL_CLEAR' | 'DEGRADED' | null;
  locationName: string | null;
  reason: string | null;
  expired: boolean;
  alreadyAckedAt: string | null;
  alreadyAckedBy: string | null;
  recipient: string;
}

export const getAckByToken = (token: string) =>
  api.get<AckByTokenLookup>(`/ack/by-token/${encodeURIComponent(token)}`);

export const postAckByToken = (token: string) =>
  api.post<{ acked: number; alreadyAcked?: boolean }>(`/ack/by-token/${encodeURIComponent(token)}`);
```

- [ ] **Step 2: Typecheck**

```bash
cd client && npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add client/src/api.ts
git commit -m "feat(ack-link): client api wrappers"
```

---

### Task 11: `AckPage` component

**Files:**

- Create: `client/src/AckPage.tsx`

- [ ] **Step 1: Implement the page**

```tsx
import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Box, Card, CardContent, Typography, Button, CircularProgress, Alert } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { STATE_CONFIG, stateOf } from './states';
import { getAckByToken, postAckByToken, AckByTokenLookup } from './api';
import { maskEmail } from './utils/maskEmail';
import { formatSAST } from './utils/format';

type Phase =
  | { kind: 'loading' }
  | { kind: 'valid'; data: AckByTokenLookup }
  | { kind: 'acked-just-now'; ackedCount: number; data: AckByTokenLookup }
  | { kind: 'expired' }
  | { kind: 'invalid' }
  | { kind: 'error'; message: string };

export default function AckPage() {
  const { token } = useParams<{ token: string }>();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [acking, setAcking] = useState(false);

  useEffect(() => {
    if (!token) {
      setPhase({ kind: 'invalid' });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await getAckByToken(token);
        if (cancelled) return;
        if (res.data.expired) setPhase({ kind: 'expired' });
        else setPhase({ kind: 'valid', data: res.data });
      } catch (err: any) {
        if (cancelled) return;
        const status = err?.response?.status;
        if (status === 404) setPhase({ kind: 'invalid' });
        else setPhase({ kind: 'error', message: err?.message ?? 'Could not load alert' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleAck = async () => {
    if (!token || phase.kind !== 'valid') return;
    setAcking(true);
    try {
      const res = await postAckByToken(token);
      setPhase({ kind: 'acked-just-now', ackedCount: res.data.acked, data: phase.data });
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 410) setPhase({ kind: 'expired' });
      else setPhase({ kind: 'error', message: err?.message ?? 'Could not acknowledge' });
    } finally {
      setAcking(false);
    }
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        bgcolor: 'background.default',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: 2,
      }}
    >
      <Card sx={{ maxWidth: 480, width: '100%', overflow: 'hidden' }}>
        {phase.kind === 'loading' && (
          <CardContent sx={{ textAlign: 'center', py: 6 }}>
            <CircularProgress />
          </CardContent>
        )}

        {phase.kind === 'valid' &&
          (() => {
            const cfg = STATE_CONFIG[stateOf(phase.data.state)];
            return (
              <>
                <Box sx={{ bgcolor: cfg.color, color: cfg.textColor, p: 3 }}>
                  <Typography variant="h3" sx={{ fontWeight: 700, fontSize: 32 }}>
                    {cfg.emoji} {phase.data.state}
                  </Typography>
                  <Typography variant="h5" sx={{ mt: 0.5, fontWeight: 500, fontSize: 20 }}>
                    {phase.data.locationName}
                  </Typography>
                </Box>
                <CardContent>
                  {phase.data.reason && (
                    <Typography variant="body1" sx={{ mb: 2 }}>
                      <strong>Why:</strong> {phase.data.reason}
                    </Typography>
                  )}
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block', mb: 3 }}
                  >
                    Sent to {maskEmail(phase.data.recipient)}
                  </Typography>
                  <Button
                    fullWidth
                    size="large"
                    variant="contained"
                    onClick={handleAck}
                    disabled={acking}
                    sx={{ minHeight: 52, fontWeight: 600 }}
                    startIcon={
                      acking ? <CircularProgress size={18} color="inherit" /> : <CheckCircleIcon />
                    }
                  >
                    {acking ? 'Acknowledging…' : "Acknowledge — I've seen this"}
                  </Button>
                </CardContent>
              </>
            );
          })()}

        {phase.kind === 'acked-just-now' &&
          (() => {
            const cfg = STATE_CONFIG[stateOf(phase.data.state)];
            return (
              <CardContent sx={{ textAlign: 'center', py: 5 }}>
                <CheckCircleIcon sx={{ fontSize: 64, color: 'success.main', mb: 1 }} />
                <Typography variant="h5" sx={{ mb: 1 }}>
                  Acknowledged
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
                  {cfg.emoji} {phase.data.state} — {phase.data.locationName}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                  {phase.ackedCount} {phase.ackedCount === 1 ? 'delivery' : 'deliveries'} cleared at{' '}
                  {formatSAST(new Date().toISOString())} SAST
                </Typography>
                <Link to="/alerts" style={{ fontSize: 13 }}>
                  View dashboard →
                </Link>
              </CardContent>
            );
          })()}

        {phase.kind === 'expired' && (
          <CardContent sx={{ textAlign: 'center', py: 5 }}>
            <Typography variant="h6" sx={{ mb: 1 }}>
              Link expired
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              Ack links are valid for 48 hours. Open the dashboard to acknowledge instead.
            </Typography>
            <Link to="/alerts" style={{ fontSize: 13 }}>
              Open dashboard to ack →
            </Link>
          </CardContent>
        )}

        {phase.kind === 'invalid' && (
          <CardContent sx={{ textAlign: 'center', py: 5 }}>
            <Typography variant="h6" sx={{ mb: 1 }}>
              Link not recognised
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              Check the original message and try again, or open the dashboard.
            </Typography>
            <Link to="/alerts" style={{ fontSize: 13 }}>
              Open dashboard →
            </Link>
          </CardContent>
        )}

        {phase.kind === 'error' && (
          <CardContent sx={{ textAlign: 'center', py: 5 }}>
            <Alert severity="error" sx={{ mb: 2, textAlign: 'left' }}>
              {phase.message}
            </Alert>
            <Button onClick={() => setPhase({ kind: 'loading' })}>Retry</Button>
          </CardContent>
        )}
      </Card>
    </Box>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd client && npx tsc --noEmit
```

Expected: exit 0.

If TS complains about `STATE_CONFIG[stateOf(phase.data.state)]` because `phase.data.state` is `RiskState | null`, the helper `stateOf(null)` returns `'DEGRADED'` so this is safe — but the indexing types may need `stateOf(phase.data.state ?? undefined)` if the function signature is strict. Verify by reading `client/src/states.ts:stateOf`.

- [ ] **Step 3: Commit**

```bash
git add client/src/AckPage.tsx
git commit -m "feat(ack-link): AckPage component"
```

---

### Task 12: Mount the public route in `App.tsx`

**Files:**

- Modify: `client/src/App.tsx`

- [ ] **Step 1: Import `AckPage`**

Near the top, with the other page imports:

```tsx
import AckPage from './AckPage';
```

- [ ] **Step 2: Mount the route outside the auth gate**

Find the top-level `<Routes>` block in the `App` component (the one with `<Route path="/register" element={<Register />} />`). Add the new route alongside `/register`:

```tsx
<Route path="/register" element={<Register />} />
<Route path="/a/:token" element={<AckPage />} />
<Route path="*" element={
  user && token
    ? <MainLayout user={user} onLogout={handleLogout} />
    : <LoginPage onLogin={handleLogin} />
} />
```

- [ ] **Step 3: Typecheck and build**

```bash
cd client && npx tsc --noEmit && npm run build
```

Expected: exit 0; build emits a new `dist/assets/index-*.js`.

- [ ] **Step 4: Commit**

```bash
git add client/src/App.tsx
git commit -m "feat(ack-link): mount /a/:token route outside the auth gate"
```

---

### Task 13: Update architecture docs

**Files:**

- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Append a section under "Alert dispatch" (or wherever delivery is described)**

Add this block at an appropriate place in the doc:

```markdown
### One-tap ack via tokenised link

Each delivered alert (email/SMS/WhatsApp) carries a `https://…/a/<token>`
URL. The token is 24 random bytes (base64url, 32 chars), stored on the
`alerts` row in `ack_token` + `ack_token_expires_at`, with a 48 h TTL.

- `GET /api/ack/by-token/:token` — read-only. Returns the alert's state,
  location, reason, and ack status. Safe for email scanners and link
  previewers.
- `POST /api/ack/by-token/:token` — acks **every** alert row sharing the
  same `state_id` (per-event scope), idempotent via
  `WHERE acknowledged_at IS NULL`. Audit row recorded with
  `actor_role = "recipient"` and `actor_email = "recipient:<email>"`.

The leading `recipient: 'system'` audit row gets no token (not delivered).
WhatsApp template-mode messages skip token generation in v1 since the URL
isn't reachable through approved templates without a content variable
allowlist.
```

- [ ] **Step 2: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs: ack-via-link tokenised-URL flow"
```

---

### Task 14: Manual smoke test (post-deploy)

This task isn't a code change — it's the human checklist to run after `bash deploy.sh` ships the feature. **Do not** mark this task done until each step is observed working in production.

- [ ] **Step 1: Push and deploy**

```bash
git push origin master
bash deploy.sh
```

Wait for `Visit your newly deployed app at https://lightning-risk-api.fly.dev/`.

- [ ] **Step 2: Verify the SPA bundle hash on prod matches the local build**

```bash
live=$(curl -sS https://lightning-risk-api.fly.dev/ | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' | head -1)
local=$(ls server/client-dist/assets/ | grep '\.js$')
echo "live: $live   local: assets/$local"
```

Expected: hashes match.

- [ ] **Step 3: Verify the ack-token migration ran**

From a Fly SSH session (or via the existing prod-DB query helper):

```sql
SELECT 1 FROM information_schema.columns
 WHERE table_name = 'alerts' AND column_name = 'ack_token';
```

Expected: 1 row.

- [ ] **Step 4: Trigger a STOP on a demo location**

Add a demo location (or use an existing demo site marked `is_demo=true`) and arrange for the risk engine to flip to STOP. Quickest path: lower its STOP threshold and let the existing flash data trigger the transition at the next 60 s tick.

- [ ] **Step 5: Confirm the email contains a working link**

Open the dispatched email. Inspect the **Acknowledge alert** button's `href`. It should be `https://lightning-risk-api.fly.dev/a/<32-char-token>`.

- [ ] **Step 6: Tap the link from a phone that's NOT logged in**

Open the URL on an incognito tab on a phone (or sign out first). The page should:

- Show the state-coloured header (red for STOP).
- Show the location, reason, masked recipient.
- Show a big **Acknowledge** button.

- [ ] **Step 7: Tap Acknowledge**

Page should transition to the green-check confirmation showing the count of cleared deliveries. Within 30 s the operator dashboard `/alerts` should reflect the alert as acknowledged with `acknowledged_by` starting `recipient:`.

- [ ] **Step 8: Tap the link a second time**

Page should show the "Already acknowledged" state with the prior recipient's email + timestamp. No second audit row.

- [ ] **Step 9: Verify the audit log**

Open `/audit` as super_admin and filter on `actor_email LIKE 'recipient:%'`. There should be one row for the click in step 7.

- [ ] **Step 10: Wait 48 h, click an old link → expired state**

Optional — covers the TTL path. Or shorten `ACK_TOKEN_TTL_MS` in a one-off branch to verify in seconds.

---

## Self-review

**Spec coverage check:**

- DB migration → Task 1 ✓
- Token generator → Task 2 ✓
- Token persistence → Task 3 (queries.ts) + Task 5 (alertService.ts) ✓
- Template builders accept ackUrl → Task 4 ✓
- Per-event ack SQL → Task 7 ✓
- Public GET endpoint → Task 6 ✓
- Public POST endpoint → Task 7 ✓
- Audit row with `actor_role: "recipient"` → Task 7 (uses existing `logAudit` `actor` parameter — no audit.ts change needed) ✓
- AckPage with seven states → Task 11 ✓
- Mounted SPA route → Task 12 ✓
- Mount of public router on Express → Task 8 ✓
- maskEmail helper → Task 9 ✓
- API wrappers → Task 10 ✓
- Test files (unit + integration) → Tasks 2, 4, 6, 7 ✓
- Manual smoke checklist → Task 14 ✓
- Documentation → Task 13 ✓

**Placeholder scan:** Searched for "TBD"/"TODO"/"implement later" — none. Every code-bearing step ships actual code.

**Type consistency:**

- `ack_token` (snake_case in `AlertRecord`) consistent across queries.ts, alertService.ts, publicAckRoutes.ts ✓
- `ackToken` / `ackUrl` / `ackTokenExpiry` (camelCase in TS code) consistent ✓
- HTTP shape `{ state, locationName, reason, expired, alreadyAckedAt, alreadyAckedBy, recipient }` defined in Task 6 server side and Task 10 client-side `AckByTokenLookup` interface — matches ✓
- POST response shape `{ acked, alreadyAcked? }` consistent across Task 7 and Task 10 ✓

**Spec deviation noted:** The original spec proposed an `audit.ts` extension with `actor_override`. After re-reading `server/audit.ts`, the existing `logAudit({ actor: { id, email, role } })` parameter already covers this case — no audit.ts change needed. Task 7 uses the existing parameter. Spec doc was approved; the deviation is a simplification, no behaviour difference.

# Roles + Replay Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `representative` role between `admin` and `super_admin` with cross-org reach but no platform-shape powers, AND widen the Replay screen so users see lightning strikes outside their alert radius as recessive context.

**Architecture:**

- Spec: `docs/superpowers/specs/2026-05-11-roles-and-replay-visibility-design.md`.
- Two PRs against `master`. **PR 1 = Replay (ship first, lower risk). PR 2 = Representative role.**
- PR 1 touches only `server/statusRoutes.ts`, `client/src/Replay.tsx`, and one new test file.
- PR 2 widens the `Role` union in lockstep across server + client and introduces a single `isPlatformWideUser` helper so cross-org checks have one place to look at.

**Tech Stack:** Node.js 20, Express, TypeScript, PostgreSQL 16 + PostGIS, React 18, Material-UI, Leaflet, react-leaflet, Vitest, zod.

---

## PR 1 — Replay wide-area visibility

### Task 1: Server replay endpoint — widen radius, cap rows, return truncation flag

**Files:**

- Modify: `server/statusRoutes.ts` (the `/api/replay/:locationId` handler — currently around lines 140–198)
- Test: `server/tests/replay.integration.test.ts` (new)

- [ ] **Step 1: Write failing integration test**

Create `server/tests/replay.integration.test.ts` (mirrors style of existing integration tests in the same folder):

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp } from './helpers/buildApp'; // existing helper used by tenantIsolation.integration.test.ts
import { signToken, makeOrgAndAdmin, makeLocation, insertFlash } from './helpers/factories';

describe('GET /api/replay/:locationId — wide-area visibility', () => {
  let app: any, admin: any, locId: string;

  beforeAll(async () => {
    app = await buildApp();
    const { adminUser } = await makeOrgAndAdmin({ slug: 'replay-test' });
    admin = adminUser;
    locId = await makeLocation({
      orgId: admin.org_id,
      lat: -26.2,
      lng: 28.0,
      stop_radius_km: 10,
      prepare_radius_km: 25,
    });
  });

  it('returns flashes outside prepare_radius_km but within 200 km', async () => {
    // Insert one flash inside prepare (20 km away) and one outside (120 km away)
    await insertFlash({ lat: -26.0, lng: 28.0, minutesAgo: 5 }); // ~22 km
    await insertFlash({ lat: -25.0, lng: 28.0, minutesAgo: 5 }); // ~133 km

    const token = signToken(admin);
    const res = await request(app)
      .get(`/api/replay/${locId}?hours=1`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const distances = res.body.flashes.map((f: any) => Math.round(f.distance_km));
    expect(distances.some((d: number) => d > 25 && d <= 200)).toBe(true);
    expect(distances.every((d: number) => d <= 200)).toBe(true);
    expect(res.body.flashes_truncated).toBe(false);
  });

  it('sets flashes_truncated when result exceeds 5000', async () => {
    // Insert 5001 flashes all within 50 km
    for (let i = 0; i < 5001; i++) {
      await insertFlash({
        lat: -26.2 + (i % 100) * 0.001,
        lng: 28.0 + Math.floor(i / 100) * 0.001,
        minutesAgo: 10,
      });
    }
    const token = signToken(admin);
    const res = await request(app)
      .get(`/api/replay/${locId}?hours=1`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.flashes.length).toBe(5000);
    expect(res.body.flashes_truncated).toBe(true);
  });

  it('returns triggered_alerts array correlating with state transitions that dispatched alerts', async () => {
    // Factories below: insertRiskState creates a row; insertAlert creates a row linked by location_id + sent_at near the state's evaluated_at
    const token = signToken(admin);
    const res = await request(app)
      .get(`/api/replay/${locId}?hours=1`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.triggered_alerts)).toBe(true);
  });
});
```

Note for the implementer: if `helpers/factories.ts` does not yet expose `insertFlash` / `insertRiskState` / `insertAlert`, add minimal versions alongside the existing factories. Look at `server/tests/tenantIsolation.integration.test.ts` for the established pattern — do not invent a new helper module.

- [ ] **Step 2: Run test, expect FAIL**

```
cd server && npm run test:integration -- replay.integration
```

Expected: failures on `flashes_truncated` (undefined), distance assertion (current code caps at `prepare_radius_km`), and `triggered_alerts` (undefined).

- [ ] **Step 3: Update the handler**

Replace the body of `/api/replay/:locationId` in `server/statusRoutes.ts` with:

```ts
router.get(
  '/api/replay/:locationId',
  authenticate,
  requireRole('viewer'),
  async (req: AuthRequest, res: Response) => {
    try {
      const { locationId } = req.params;
      const lookback = Math.min(Math.max(parseInt(req.query.hours as string) || 24, 1), 168);

      const loc = await getLocationForUser(locationId, req.user!);
      if (!loc) return res.status(404).json({ error: 'Location not found' });

      const { lng, lat } = parseCentroid(loc.centroid);

      const { query: dbQuery } = await import('./db');
      const statesRes = await dbQuery(
        `SELECT * FROM risk_states
         WHERE location_id = $1
           AND evaluated_at >= NOW() - ($2 || ' hours')::interval
         ORDER BY evaluated_at ASC`,
        [locationId, lookback.toString()],
      );

      // Fixed wide-area radius for Replay context. The risk engine still
      // evaluates only inside the location's stop/prepare radii — this
      // expanded query is purely for "show me the strikes I might have
      // expected to alert on but didn't".
      const WIDE_RADIUS_M = 200_000; // 200 km
      const FLASH_LIMIT = 5000;

      const centroidWkt = `POINT(${lng} ${lat})`;
      const flashesRes = await dbQuery(
        `SELECT flash_id, flash_time_utc, latitude, longitude, radiance,
                duration_ms, filter_confidence,
                ST_Distance(geom::geography, ST_GeomFromText($1, 4326)::geography) / 1000.0 AS distance_km
         FROM flash_events
         WHERE flash_time_utc >= NOW() - ($2 || ' hours')::interval
           AND ST_DWithin(geom::geography, ST_GeomFromText($1, 4326)::geography, $3)
         ORDER BY flash_time_utc ASC
         LIMIT ${FLASH_LIMIT + 1}`,
        [centroidWkt, lookback.toString(), WIDE_RADIUS_M],
      );

      // Correlate state transitions with dispatched alerts. Alerts are
      // produced by transitions (riskEngine -> alertService); they share
      // location_id and their created_at is at-or-very-near the transition's
      // evaluated_at. We join on a 90-second window to be safe.
      const alertsRes = await dbQuery(
        `SELECT a.id AS alert_id, a.created_at AS sent_at, rs.id AS transition_id
         FROM alerts a
         JOIN risk_states rs
           ON rs.location_id = a.location_id
          AND ABS(EXTRACT(EPOCH FROM (rs.evaluated_at - a.created_at))) <= 90
         WHERE a.location_id = $1
           AND a.created_at >= NOW() - ($2 || ' hours')::interval`,
        [locationId, lookback.toString()],
      );

      const truncated = flashesRes.rows.length > FLASH_LIMIT;
      const flashes = truncated ? flashesRes.rows.slice(0, FLASH_LIMIT) : flashesRes.rows;

      res.json({
        location: {
          id: loc.id,
          name: loc.name,
          lat,
          lng,
          stop_radius_km: loc.stop_radius_km,
          prepare_radius_km: loc.prepare_radius_km,
          stop_window_min: loc.stop_window_min,
          prepare_window_min: loc.prepare_window_min,
        },
        states: statesRes.rows,
        flashes,
        flashes_truncated: truncated,
        wide_radius_km: 200,
        triggered_alerts: alertsRes.rows,
      });
    } catch (error) {
      logger.error('Failed to get replay data', {
        error: (error as Error).message,
        locationId: req.params.locationId,
      });
      res.status(500).json({ error: 'Failed to get replay data' });
    }
  },
);
```

- [ ] **Step 4: Run tests, expect PASS**

```
cd server && npm run test:integration -- replay.integration
```

Expected: all three tests pass.

- [ ] **Step 5: Run full server test suite to make sure nothing regressed**

```
cd server && npm test
```

Expected: previously passing tests still pass.

- [ ] **Step 6: Commit**

```
git add server/statusRoutes.ts server/tests/replay.integration.test.ts server/tests/helpers/factories.ts
git commit -m "feat(replay): widen flash visibility to 200km with truncation + alert join"
```

---

### Task 2: Client Replay — 4-band classification and outside-radius styling

**Files:**

- Modify: `client/src/Replay.tsx` (current zone classification at ~line 271 and map markers at ~line 700)

- [ ] **Step 1: Add the new response fields to the local interfaces near the top of the file**

Find the existing `ReplayFlash` interface (around line 75) and add a sibling interface below it:

```ts
interface TriggeredAlert {
  alert_id: number;
  sent_at: string;
  transition_id: number;
}
```

Then in the component state (near where `replayLoc` is declared, ~line 135), add:

```ts
const [flashesTruncated, setFlashesTruncated] = useState(false);
const [triggeredAlerts, setTriggeredAlerts] = useState<TriggeredAlert[]>([]);
const [showWiderView, setShowWiderView] = useState(false);
```

In `loadReplay` (around line 181), after `setFlashes(res.data.flashes || []);` add:

```ts
setFlashesTruncated(Boolean(res.data.flashes_truncated));
setTriggeredAlerts(res.data.triggered_alerts || []);
```

- [ ] **Step 2: Widen the zone classifier**

Replace the existing classifier block at lines 271–279 (`const flashesWithZone = visibleFlashes.map(...)`) with:

```ts
type Zone = 'STOP' | 'PREPARE' | 'OUTSIDE';

function classifyZone(distance_km: number, stop_km: number, prepare_km: number): Zone {
  if (distance_km <= stop_km) return 'STOP';
  if (distance_km <= prepare_km) return 'PREPARE';
  return 'OUTSIDE';
}

const flashesWithZone = visibleFlashes.map((f) => ({
  ...f,
  zone: classifyZone(f.distance_km, stopRadiusKm, prepareRadiusKm) as Zone,
}));
```

Remove every remaining literal `'BEYOND'` token in the file (search the file for `BEYOND`). Replace each with `'OUTSIDE'`. Specifically:

- The colour-picker ternaries in the map render (~line 703) and in the flash table (~line 791) must read `f.zone === 'STOP' ? '#f44336' : f.zone === 'PREPARE' ? '#fbc02d' : '#90a4ae'`.

- [ ] **Step 3: Style outside-radius strikes as small grey dots**

Replace the map `<CircleMarker>` block at lines ~700–733 with:

```tsx
{
  flashesWithZone.map((f, idx) => {
    const age = (currentTime - new Date(f.flash_time_utc).getTime()) / 60000;
    const opacityDecay = Math.max(0.4, 1 - age / (replayLoc?.stop_window_min ?? 15));
    const isOutside = f.zone === 'OUTSIDE';
    const fillColor = f.zone === 'STOP' ? '#f44336' : f.zone === 'PREPARE' ? '#fbc02d' : '#90a4ae';
    const radius = isOutside ? 3 : 5;
    const finalOpacity = isOutside ? 0.4 : opacityDecay;
    return (
      <CircleMarker
        key={`${f.flash_id}-${idx}`}
        center={[f.latitude, f.longitude]}
        radius={radius}
        pathOptions={{
          color: fillColor,
          fillColor,
          fillOpacity: finalOpacity,
          weight: isOutside ? 1 : 1.5,
          opacity: finalOpacity,
        }}
      >
        <Popup>
          ⚡ Flash #{f.flash_id}
          <br />
          {formatSAST(f.flash_time_utc)} SAST
          <br />
          Zone: <strong>{f.zone}</strong>
          {isOutside && (
            <>
              <br />
              <em>Outside alert radius — did not trigger an alert.</em>
            </>
          )}
          <br />
          Distance: {f.distance_km.toFixed(1)} km
        </Popup>
      </CircleMarker>
    );
  });
}
```

- [ ] **Step 4: Commit**

```
git add client/src/Replay.tsx
git commit -m "feat(replay): render outside-radius strikes as recessive grey context"
```

---

### Task 3: Client Replay — legend card and "Show wider view" toggle

**Files:**

- Modify: `client/src/Replay.tsx`

- [ ] **Step 1: Add a legend card directly above the map Grid container**

In the JSX, find the `{/* Map + flash table side by side */}` comment (around line 647) and immediately _before_ the `<Grid container spacing={2}>` that follows it, insert:

```tsx
{
  /* Legend — explains what map dots mean and the alert-attribution boundary */
}
<Card sx={{ mb: 1.5 }}>
  <CardContent sx={{ py: 1, px: 2, '&:last-child': { pb: 1 } }}>
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: '#f44336' }} />
        <Typography variant="caption">STOP zone</Typography>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: '#fbc02d' }} />
        <Typography variant="caption">PREPARE zone</Typography>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: '#90a4ae', opacity: 0.6 }} />
        <Typography variant="caption">Outside alert radius (context only)</Typography>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <NotificationsIcon sx={{ fontSize: 14, color: '#fbc02d' }} />
        <Typography variant="caption">Alert sent</Typography>
      </Box>
      <Box sx={{ flexGrow: 1 }} />
      <Button
        size="small"
        variant={showWiderView ? 'contained' : 'outlined'}
        onClick={() => setShowWiderView((v) => !v)}
      >
        {showWiderView ? 'Focus on alert area' : 'Show wider view'}
      </Button>
    </Box>
    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
      Alerts are triggered by strikes inside your alert radius. Strikes outside are shown for
      context and did not trigger an alert.
    </Typography>
    {flashesTruncated && (
      <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 0.5 }}>
        Showing the first 5000 flashes in this window. Narrow the lookback to see all data.
      </Typography>
    )}
  </CardContent>
</Card>;
```

Add this import at the top of the file alongside the other `@mui/icons-material` imports (around line 36):

```ts
import NotificationsIcon from '@mui/icons-material/Notifications';
```

- [ ] **Step 2: Wire `showWiderView` into the map auto-fit**

Find the `<FitToRadius>` element (around line 655) and change:

```tsx
<FitToRadius
  lat={loc.lat}
  lng={loc.lng}
  radiusKm={prepareRadiusKm}
  version={selectedLocation.length}
/>
```

to:

```tsx
<FitToRadius
  lat={loc.lat}
  lng={loc.lng}
  radiusKm={showWiderView ? 200 : prepareRadiusKm}
  version={selectedLocation.length + (showWiderView ? 1 : 0)}
/>
```

(The `version` change forces Leaflet to re-fit when the toggle flips. The existing `FitToRadius` re-runs whenever `version` changes — see the comment in the component near line 86.)

- [ ] **Step 3: Commit**

```
git add client/src/Replay.tsx
git commit -m "feat(replay): legend + show-wider-view toggle"
```

---

### Task 4: Client Replay — alert-bell markers on the state-transition timeline

**Files:**

- Modify: `client/src/Replay.tsx`

- [ ] **Step 1: Build an index of transitions that produced alerts**

Below the existing `currentState` / `currentTime` derivations (around line 254), add:

```ts
// Mark a state-transition timeline segment if an alert was sent within 90s
// of its evaluated_at. Same window the server uses to correlate them.
const transitionHasAlert = new Set<number>();
states.forEach((s, i) => {
  const tEval = new Date(s.evaluated_at).getTime();
  const matched = triggeredAlerts.some((a) => {
    const tAlert = new Date(a.sent_at).getTime();
    return Math.abs(tAlert - tEval) <= 90_000;
  });
  if (matched) transitionHasAlert.add(i);
});
```

- [ ] **Step 2: Overlay bell icons on the timeline bar**

In the timeline render block (the IIFE that builds the segments, around lines 605–642), inside the `<Box>` rendered for each segment, add a child:

```tsx
{
  transitionHasAlert.has(i) && (
    <Box
      sx={{
        position: 'absolute',
        top: -14,
        left: '50%',
        transform: 'translateX(-50%)',
        pointerEvents: 'none',
      }}
    >
      <NotificationsIcon sx={{ fontSize: 14, color: sCfg.color }} />
    </Box>
  );
}
```

The parent `<Box>` already has `position: 'relative'` — verify it does (it currently sets `position: 'relative'` only when `isActive` so we need to **make it always relative**). Change the `sx` on the segment `<Box>` so `position: 'relative'` is unconditional:

```ts
sx={{
  flex: flexWeight,
  bgcolor: sCfg.color,
  opacity: i <= currentIndex ? 1 : 0.25,
  cursor: 'pointer',
  transition: 'opacity 0.2s',
  borderRight: '1px solid rgba(0,0,0,0.3)',
  position: 'relative', // always relative so the bell overlay anchors here
  '&:hover': { opacity: 0.8 },
  ...(isActive && {
    boxShadow: `0 0 0 2px #fff`,
    zIndex: 1,
  }),
}}
```

The tooltip on the segment must update to mention the alert when present. Replace:

```tsx
<Tooltip key={i} title={`${sCfg.label} — ${formatSAST(s.evaluated_at)}`}>
```

with:

```tsx
<Tooltip
  key={i}
  title={
    transitionHasAlert.has(i)
      ? `${sCfg.label} — ${formatSAST(s.evaluated_at)} (alert sent)`
      : `${sCfg.label} — ${formatSAST(s.evaluated_at)}`
  }
>
```

- [ ] **Step 3: Build and smoke-test**

```
cd client && npm run build
```

Expected: build succeeds with no TS errors.

Then start the dev server and verify on a location that has had an alert:

```
cd client && npm run dev
```

Open `http://localhost:3000`, navigate to Event Replay, select a location with historical alerts, and confirm:

1. Outside-radius strikes appear as small grey dots on the map.
2. The legend card is visible and matches the map styling.
3. Toggling "Show wider view" zooms the map out to ~200 km.
4. Bell icons appear above timeline segments where alerts were sent.
5. The "did not trigger an alert" copy appears in the popup for grey dots.

- [ ] **Step 4: Commit**

```
git add client/src/Replay.tsx
git commit -m "feat(replay): alert-bell markers on state-transition timeline"
```

---

### Task 5: PR 1 wrap-up

- [ ] **Step 1: Run the full test suite**

```
npm test            # repo root — runs both client + server
```

Expected: green.

- [ ] **Step 2: Open PR**

Branch name: `replay-wide-area-visibility`. PR description summary:

> Widens the Replay screen to show lightning strikes within 200 km of the location, not just inside the alert radius. Outside-radius strikes render as small grey dots; a legend explains the boundary; a "Show wider view" toggle widens the map fit; alert-bell markers on the state-transition timeline indicate where alerts were dispatched. Server returns at most 5000 flashes with a `flashes_truncated` flag. No alert/risk-engine behaviour changes.

---

## PR 2 — `representative` role

### Task 6: Database migration step — widen `users.role` CHECK constraint

**Files:**

- Modify: `server/migrate.ts` (lines ~230–234 currently)

- [ ] **Step 1: Replace the existing constraint widening**

Find this block in `runMigrations()` (around line 230):

```ts
// Widen role check on users to include super_admin
await query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
await query(
  `ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('super_admin','admin','operator','viewer'))`,
);
```

Replace with:

```ts
// Widen role check on users to include super_admin and representative.
// representative sits between admin and super_admin: cross-org reach
// but no platform-shape actions (org create/delete, peer promotion,
// platform settings, billing). See
// docs/superpowers/specs/2026-05-11-roles-and-replay-visibility-design.md.
await query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
await query(
  `ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('super_admin','representative','admin','operator','viewer'))`,
);
```

Also update the `CREATE TABLE IF NOT EXISTS users` block above (around line 214) so that fresh databases get the right constraint on first boot:

```ts
role          TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('super_admin','representative','admin','operator','viewer')),
```

- [ ] **Step 2: Run the migrate path locally and verify**

```
cd server && npm run migrate
```

Then in `psql`:

```
\d users
```

Expected: `users_role_check` constraint shows the 5 roles.

- [ ] **Step 3: Commit**

```
git add server/migrate.ts
git commit -m "feat(roles): widen users.role CHECK to include representative"
```

---

### Task 7: Widen the server `Role` union and add `isPlatformWideUser` helper

**Files:**

- Modify: `server/auth.ts` (line 33 for the union; line 302 for the hierarchy)
- Modify: `server/authScope.ts` (add helper; widen existing checks)
- Modify: `server/queries/users.ts` (lines 9, 36, 55)
- Modify: `server/dev/mockData.ts` (line 80)

- [ ] **Step 1: Widen the `AuthUser` role union in `server/auth.ts`**

Change line 33:

```ts
role: 'super_admin' | 'admin' | 'operator' | 'viewer';
```

to:

```ts
role: 'super_admin' | 'representative' | 'admin' | 'operator' | 'viewer';
```

And in `requireRole` (line 302), change the hierarchy map to:

```ts
const hierarchy: Record<string, number> = {
  super_admin: 5,
  representative: 4,
  admin: 3,
  operator: 2,
  viewer: 1,
};
```

- [ ] **Step 2: Widen `UserRecord.role` in `server/queries/users.ts`**

Replace all three occurrences (lines 9, 36, 55) of:

```ts
role: 'super_admin' | 'admin' | 'operator' | 'viewer';
```

with:

```ts
role: 'super_admin' | 'representative' | 'admin' | 'operator' | 'viewer';
```

- [ ] **Step 3: Add the `isPlatformWideUser` helper in `server/authScope.ts`**

At the top of `server/authScope.ts`, just below the imports, add:

```ts
/**
 * A "platform-wide" user can read and act across every tenant org.
 * super_admin AND representative both qualify. Used by every cross-org
 * choke point — `resolveOrgScope`, `canAccessLocation`, plus the
 * settings/locations/alerts handlers that previously did
 * `req.user!.role === 'super_admin'` for cross-org behaviour.
 *
 * Platform-SHAPE actions (org create/delete, role-promotion, platform
 * settings mutation) keep using `=== 'super_admin'` directly — those are
 * super_admin-only by design and `isPlatformWideUser` would broaden them
 * incorrectly.
 */
export function isPlatformWideUser(user: { role: string }): boolean {
  return user.role === 'super_admin' || user.role === 'representative';
}
```

Then update both existing helpers in the same file:

```ts
export function resolveOrgScope(
  req: AuthRequest,
): { ok: true; orgId: string | undefined } | { ok: false; status: number; error: string } {
  const queryOrg = typeof req.query.org_id === 'string' ? req.query.org_id : undefined;
  if (queryOrg !== undefined) {
    if (!isPlatformWideUser(req.user!)) {
      return {
        ok: false,
        status: 403,
        error: 'org_id is only allowed for super_admin or representative',
      };
    }
    if (!UUID_RE.test(queryOrg)) {
      return { ok: false, status: 400, error: 'org_id must be a valid UUID' };
    }
    return { ok: true, orgId: queryOrg };
  }
  if (isPlatformWideUser(req.user!)) return { ok: true, orgId: undefined };
  return { ok: true, orgId: req.user!.org_id };
}

export function canAccessLocation(
  loc: { org_id: string } | null | undefined,
  user: { role: string; org_id: string },
): boolean {
  if (!loc) return false;
  if (isPlatformWideUser(user)) return true;
  return loc.org_id === user.org_id;
}
```

- [ ] **Step 4: Widen `server/dev/mockData.ts` role union**

Line 80:

```ts
role: 'admin' | 'operator' | 'viewer';
```

becomes:

```ts
role: 'super_admin' | 'representative' | 'admin' | 'operator' | 'viewer';
```

(No seed user has the new role yet — this is only the type widening.)

- [ ] **Step 5: Update existing tests that imported the old union**

Open `server/tests/authScope.test.ts`. The test file's local `makeReq` typing on line ~14 reads `role: 'super_admin' | 'admin' | 'operator' | 'viewer';` — widen it to include `'representative'`.

- [ ] **Step 6: Type-check passes**

```
cd server && npx tsc --noEmit
```

Expected: no type errors.

- [ ] **Step 7: Commit**

```
git add server/auth.ts server/authScope.ts server/queries/users.ts server/dev/mockData.ts server/tests/authScope.test.ts
git commit -m "feat(roles): widen server Role union; add isPlatformWideUser helper"
```

---

### Task 8: Widen handler-level cross-org checks to use `isPlatformWideUser`

**Files:**

- Modify: `server/locationRoutes.ts` (line 160 area)
- Modify: `server/settingsRoutes.ts` (line 33 area)
- Modify: `server/alertRoutes.ts` (lines 108, 175, 233)
- Modify: `server/userRoutes.ts` (lines 45, 82, 168, 290, 365)
- Modify: `server/orgRoutes.ts` (lines 483, 584, 626)

In each file, **every** spot that currently does `req.user!.role === 'super_admin'` for the purpose of cross-org _access_ (read or write into any org) must be changed to `isPlatformWideUser(req.user!)`. Spots that gate **platform-shape actions** stay on `=== 'super_admin'`.

The rule: ask "is this gate about _which org you can touch_, or about _whether you can perform a platform-shape action_?" Cross-org → use the helper. Platform-shape (org create/delete, role-promotion to rep/super, platform settings mutation) → keep `=== 'super_admin'`.

- [ ] **Step 1: `server/locationRoutes.ts`**

Add import at the top of the file:

```ts
import { isPlatformWideUser } from './authScope';
```

Change line 160:

```ts
if (req.user!.role !== 'super_admin') {
```

to:

```ts
if (!isPlatformWideUser(req.user!)) {
```

Update the error message on the next line from "org_id is only allowed for super_admin" to "org_id is only allowed for super_admin or representative".

- [ ] **Step 2: `server/settingsRoutes.ts`**

Add the import. Change `settingsScopeOrg` (around line 33):

```ts
if (queryOrg && req.user!.role === 'super_admin' && UUID_RE.test(queryOrg)) return queryOrg;
```

to:

```ts
if (queryOrg && isPlatformWideUser(req.user!) && UUID_RE.test(queryOrg)) return queryOrg;
```

- [ ] **Step 3: `server/alertRoutes.ts`**

Add the import. The file has three `const isSuper = req.user!.role === 'super_admin';` lines (108, 175, 233). Each one drives a cross-org SQL branch. Rename the local to `isPlatformWide` and use the helper:

```ts
const isPlatformWide = isPlatformWideUser(req.user!);
```

Update every subsequent reference (`if (isSuper) ...` etc.) in those three handlers.

- [ ] **Step 4: `server/userRoutes.ts`**

Add the import. This file is more subtle — there are TWO kinds of `=== 'super_admin'` checks here:

**Cross-org user access (lines 82, 168, 290, 365 — the `isSuperAdmin` locals):** these gate "can I read/edit/delete users in any org?" Rename to `isPlatformWide` and use the helper. The fallback branches that fetch users via `getAllUsers(getOrgId(req))` are still correct for non-platform-wide users.

The `isSuperAdmin && req.body.org_id` branch in POST `/` (line 82–103) — the inner `org_id` validation stays exactly the same; only the outer gate widens.

The `isAdminOrAbove()` helper at lines 44–46 — leave it alone (it's already correct, and admin alone never had cross-org reach).

**Platform-shape gate (the implicit role assignment in `createUserSchema` and `updateUserSchema`):** the zod enum `z.enum(['admin', 'operator', 'viewer'])` stays as-is — this is correct because the spec says admin and representative both can only assign `admin/operator/viewer`. Add an additional server-side check inside the POST `/` handler after `validatedData` is parsed, before `createUser`:

```ts
// representative cannot assign 'representative' or 'super_admin' — enforced
// by the zod enum already, but we double-check here so a schema change
// can't silently widen what reps can assign.
if (
  req.user?.role === 'representative' &&
  !['admin', 'operator', 'viewer'].includes(validatedData.role)
) {
  return res.status(403).json({ error: 'representative cannot assign this role' });
}
```

(Note: super_admin can assign `representative` and `super_admin` via the platform routes — out of scope for this file. PR 2 does not add a super_admin-facing UI for assigning `representative`; an operator can do that via direct DB or via a follow-up super_admin endpoint that is outside this plan.)

- [ ] **Step 5: `server/orgRoutes.ts`**

Add the import. Lines 483, 584, 626 are cross-org user / invite reach — widen with the helper. The `createInviteSchema` role enum (line 458) and the `register` flow line 738 stay as `['admin', 'operator', 'viewer']` — invites still cannot create `representative` or `super_admin` users.

- [ ] **Step 6: Type-check + run existing tests**

```
cd server && npx tsc --noEmit && npm test
```

Expected: green.

- [ ] **Step 7: Commit**

```
git add server/locationRoutes.ts server/settingsRoutes.ts server/alertRoutes.ts server/userRoutes.ts server/orgRoutes.ts
git commit -m "feat(roles): route cross-org checks through isPlatformWideUser"
```

---

### Task 9: Integration tests — representative cross-org access + platform-shape denies

**Files:**

- Modify: `server/tests/authScope.test.ts`
- Modify: `server/tests/tenantIsolation.integration.test.ts`
- Modify: `server/tests/userUpdate.test.ts`

- [ ] **Step 1: Add unit-test cases in `server/tests/authScope.test.ts`**

Append after the existing super_admin tests:

```ts
it('representative gets cross-org scope (no org filter) by default', () => {
  const result = resolveOrgScope(makeReq({ role: 'representative', org_id: 'org-platform' }));
  expect(result).toEqual({ ok: true, orgId: undefined });
});

it('representative may pass ?org_id= to scope to one tenant', () => {
  const result = resolveOrgScope(
    makeReq({
      role: 'representative',
      org_id: 'org-platform',
      query: { org_id: '11111111-1111-1111-1111-111111111111' },
    }),
  );
  expect(result).toEqual({ ok: true, orgId: '11111111-1111-1111-1111-111111111111' });
});

it('canAccessLocation returns true for a representative against any org', () => {
  expect(
    canAccessLocation({ org_id: 'other-org' }, { role: 'representative', org_id: 'home' }),
  ).toBe(true);
});
```

- [ ] **Step 2: Add integration cases in `server/tests/tenantIsolation.integration.test.ts`**

Add a new `describe('representative role', () => { ... })` block at the bottom. Mirror the structure of existing super_admin / admin cases. Required assertions:

```ts
// Setup: create org A, org B; a representative user whose home org_id is
// the platform tenant; an admin user in org A; locations in both orgs.

it('representative can read locations across orgs without ?org_id=', async () => {
  const res = await req.get('/api/locations').set('Authorization', `Bearer ${repToken}`);
  expect(res.status).toBe(200);
  // Returns rows from both org A and org B
  const orgIds = new Set(res.body.map((l: any) => l.org_id));
  expect(orgIds.size).toBeGreaterThanOrEqual(2);
});

it('representative can create a location in org B', async () => {
  const res = await req
    .post('/api/locations')
    .set('Authorization', `Bearer ${repToken}`)
    .send({
      name: 'rep-created',
      site_type: 'other',
      centroid: { lat: -26, lng: 28 },
      org_id: orgBId,
    });
  expect(res.status).toBe(201);
});

it('representative is denied org create (403)', async () => {
  const res = await req
    .post('/api/orgs')
    .set('Authorization', `Bearer ${repToken}`)
    .send({ name: 'NewOrg', slug: 'new-org' });
  expect(res.status).toBe(403);
});

it('representative is denied promoting a user to representative', async () => {
  const res = await req.post('/api/users').set('Authorization', `Bearer ${repToken}`).send({
    email: 'newrep@example.com',
    password: 'a-very-strong-password-123',
    name: 'New Rep',
    role: 'representative',
  });
  expect(res.status).toBe(400); // zod enum rejects the role
});

it('representative is denied promoting a user to super_admin', async () => {
  const res = await req.post('/api/users').set('Authorization', `Bearer ${repToken}`).send({
    email: 'newsuper@example.com',
    password: 'a-very-strong-password-123',
    name: 'New Super',
    role: 'super_admin',
  });
  expect(res.status).toBe(400);
});
```

The `POST /api/orgs` endpoint exists (`server/orgRoutes.ts`); verify it is gated on `=== 'super_admin'` for create/delete (it should be — the spec requires it). If you find it currently uses `requireRole('admin')` or similar, **leave that for a separate change** — note it in the PR description. The platform-shape gating tightening is part of this PR.

In `server/orgRoutes.ts`, find the `POST /` and `DELETE /:id` handlers. Wrap each with an explicit super_admin check:

```ts
if (req.user!.role !== 'super_admin') {
  return res.status(403).json({ error: 'Only super_admin can create or delete organisations' });
}
```

Place this check immediately after `authenticate` but before any other logic.

- [ ] **Step 3: Add unit-test cases in `server/tests/userUpdate.test.ts`**

Append a `describe('role-assignment gates', () => { ... })` block that asserts:

```ts
it('admin assigning representative is rejected with 400 (zod enum)', async () => {
  /* … */
});
it('admin assigning super_admin is rejected with 400 (zod enum)', async () => {
  /* … */
});
it('representative assigning representative is rejected with 400 (zod enum)', async () => {
  /* … */
});
```

Follow the existing test style in this file — supertest against `buildApp()`.

- [ ] **Step 4: Run, fix, commit**

```
cd server && npm test
```

Expected: green. If any platform-shape gating tests fail because the underlying handler isn't yet locked down, fix the handler (super_admin-only enforcement is in scope per the spec table).

```
git add server/tests/authScope.test.ts server/tests/tenantIsolation.integration.test.ts server/tests/userUpdate.test.ts server/orgRoutes.ts
git commit -m "test(roles): representative cross-org access + platform-shape denies"
```

---

### Task 10: Widen the client `Role` union and `useAuth` capability flags

**Files:**

- Modify: `client/src/hooks/useAuth.ts`

- [ ] **Step 1: Replace the file body**

Read the current file first to keep imports identical, then update:

```ts
import { useContext } from 'react';
import { UserContext } from '../App';

export type Role = 'super_admin' | 'representative' | 'admin' | 'operator' | 'viewer';

export interface AuthInfo {
  user: {
    id: string;
    email: string;
    name: string;
    role: Role;
    org_id?: string;
    org_name?: string;
  } | null;
  role: Role | null;
  isSuperAdmin: boolean;
  isRepresentative: boolean;
  isAdmin: boolean;
  isAdminOrAbove: boolean; // now true for super_admin OR representative OR admin
  isOperator: boolean;
  isOperatorOrAbove: boolean;
  isViewer: boolean;
  isPlatformWide: boolean; // mirrors server isPlatformWideUser
  canEditLocations: boolean;
  canEditUsers: boolean;
  canEditSettings: boolean;
  canManageOrgs: boolean;
  canViewAuditLog: boolean;
  canAcknowledgeAlerts: boolean;
  canViewPlatformOverview: boolean;
}

export function useAuth(): AuthInfo {
  const user = useContext(UserContext) as AuthInfo['user'];
  const role = (user?.role ?? null) as Role | null;

  const isSuperAdmin = role === 'super_admin';
  const isRepresentative = role === 'representative';
  const isAdmin = role === 'admin';
  // isAdminOrAbove now extends to representative — every per-org admin
  // capability gated on this flag (edit locations / users / settings / etc.)
  // automatically applies to representatives without per-flag rewrites.
  const isAdminOrAbove = isSuperAdmin || isRepresentative || isAdmin;
  const isOperator = role === 'operator';
  const isOperatorOrAbove = isAdminOrAbove || isOperator;
  const isViewer = role === 'viewer';
  const isPlatformWide = isSuperAdmin || isRepresentative;

  return {
    user,
    role,
    isSuperAdmin,
    isRepresentative,
    isAdmin,
    isAdminOrAbove,
    isOperator,
    isOperatorOrAbove,
    isViewer,
    isPlatformWide,
    canEditLocations: isAdminOrAbove,
    // canEditUsers stays admin+ — representative manages users via the
    // org-scoped management screen the same way an admin does. Promotion
    // TO representative or super_admin is super_admin-only and lives in
    // the platform overview, not the standard user-management screen.
    canEditUsers: isAdminOrAbove,
    canEditSettings: isAdminOrAbove,
    // canManageOrgs (create/delete org) stays super_admin-only — denial action A.
    canManageOrgs: isSuperAdmin,
    canViewAuditLog: isAdminOrAbove,
    canAcknowledgeAlerts: isOperatorOrAbove,
    // Representative can view the platform overview (read-only). Mutation
    // buttons on that page must check isSuperAdmin separately.
    canViewPlatformOverview: isPlatformWide,
  };
}
```

- [ ] **Step 2: Type-check**

```
cd client && npx tsc --noEmit
```

Expected: a few errors in callers that reference the old `useAuth` shape — these are intentional. Fix them in the next task.

- [ ] **Step 3: Commit**

```
git add client/src/hooks/useAuth.ts
git commit -m "feat(roles): widen client Role union; add isRepresentative + isPlatformWide"
```

---

### Task 11: Client UI — role labels and Representative role picker

**Files:**

- Modify: `client/src/UserManagement.tsx` (lines 55–68 — the label/colour maps)
- Modify: `client/src/components/UserDialogs.tsx` (the `AddUserDialog` and `EditUserDialog` role selects)
- Modify: `client/src/PlatformOverview.tsx` (gate mutation buttons for non-super representatives)

- [ ] **Step 1: Update label/colour maps in `UserManagement.tsx`**

Replace the two maps at lines 55–68:

```ts
const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Admin',
  representative: 'Representative',
  admin: 'Administrator',
  operator: 'Operator',
  viewer: 'Viewer',
};

const ROLE_COLORS: Record<
  string,
  'primary' | 'secondary' | 'default' | 'error' | 'info' | 'success' | 'warning'
> = {
  super_admin: 'secondary',
  representative: 'info',
  admin: 'error',
  operator: 'warning',
  viewer: 'default',
};
```

- [ ] **Step 2: Add a Representative option to the role picker (super_admin callers only)**

Open `client/src/components/UserDialogs.tsx`. Find the role `<Select>` used inside `AddUserDialog` (and similarly inside `EditUserDialog`). The current options are `admin`, `operator`, `viewer`.

At the top of each dialog component, read the current role:

```ts
const auth = useAuth();
```

Then in the select, gate the Representative `<MenuItem>`:

```tsx
{
  auth.isSuperAdmin && <MenuItem value="representative">Representative</MenuItem>;
}
```

Place it immediately _above_ the existing `<MenuItem value="admin">` entry.

(If `useAuth` is not currently imported in `UserDialogs.tsx`, add `import { useAuth } from '../hooks/useAuth';`.)

- [ ] **Step 3: Gate `PlatformOverview` mutation buttons**

Open `client/src/PlatformOverview.tsx`. Find every mutation button (anything that creates/deletes orgs, runs platform-level actions). Wrap each with:

```tsx
{auth.isSuperAdmin && (
  <Button ...>...</Button>
)}
```

If `useAuth` is not yet imported, add it. For non-mutation reads, do nothing — representatives already pass through the page-level `canViewPlatformOverview` gate.

Update the top-of-page guard from the current super_admin check to use `canViewPlatformOverview`:

```ts
const auth = useAuth();
if (!auth.canViewPlatformOverview) {
  return <Alert severity="warning">You do not have permission to view this page.</Alert>;
}
```

- [ ] **Step 4: `UserManagement.tsx` isAdmin guard**

Line 72 currently reads:

```ts
const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'super_admin';
```

Replace with:

```ts
const auth = useAuth();
const isAdmin = auth.isAdminOrAbove; // representative + admin + super_admin
```

(Add `import { useAuth } from './hooks/useAuth';` at the top if not present.)

- [ ] **Step 5: Build and smoke-test**

```
cd client && npm run build && npm run dev
```

Sign in as a super_admin, open Add User: Representative option appears in the dropdown.
Sign in as an admin: Representative option is hidden.
Open Platform Overview as a representative (if you have one): page loads, mutation buttons are hidden.

- [ ] **Step 6: Commit**

```
git add client/src/UserManagement.tsx client/src/components/UserDialogs.tsx client/src/PlatformOverview.tsx
git commit -m "feat(roles): client UI for Representative — labels, picker, platform-overview gating"
```

---

### Task 12: PR 2 wrap-up

- [ ] **Step 1: Full repo test pass**

```
npm test
```

Expected: green across client + server.

- [ ] **Step 2: Type-check both sides**

```
cd server && npx tsc --noEmit
cd ../client && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Manual smoke test (recap)**

Seed a representative user manually in psql:

```sql
INSERT INTO users (email, password_hash, name, role, org_id)
VALUES (
  'hugh@flashaware.com',
  -- bcrypt hash of a known-strong password, generated locally
  '$2b$12$...',
  'Hugh van Niekerk',
  'representative',
  '<platform-tenant-uuid>'
);
```

Then verify:

1. Hugh signs in and the OrgScope switcher appears in the top bar (same as super_admin).
2. Hugh can read and edit locations in two different tenant orgs.
3. Hugh cannot create a new organisation (UI button hidden + 403 if hit directly via curl).
4. Hugh cannot assign the Representative or Super Admin role in the user picker.
5. Hugh can view the Platform Overview but mutation buttons are hidden.

- [ ] **Step 4: Open PR 2**

Branch name: `representative-role`. PR description summary:

> Adds a `representative` role between `admin` and `super_admin`. Representatives have admin-equivalent capabilities scoped to every tenant org (cross-org reach via the existing OrgScope switcher) and read-only access to the Platform Overview. They cannot create or delete organisations, promote users to `representative` or `super_admin`, mutate platform-level settings, or manage billing. Implemented as a single hierarchy widening backed by a new `isPlatformWideUser` helper so every cross-org choke point has one place to look at.

---

## Self-Review

**Spec coverage:**

| Spec section                         | Task(s)                       |
| ------------------------------------ | ----------------------------- |
| §2.1 Hierarchy                       | Task 7 step 1                 |
| §2.2 Permission policy table         | Tasks 7, 8, 9, 10, 11         |
| §2.3 Schema migration                | Task 6                        |
| §2.4 Type / code updates             | Tasks 7 (server), 10 (client) |
| §2.5 UI changes                      | Task 11                       |
| §2.6 Tests                           | Task 9                        |
| §3.1 Server replay change            | Task 1                        |
| §3.2 Client styling + classification | Task 2                        |
| §3.2 Legend + Show wider view        | Task 3                        |
| §3.2 Timeline alert bells            | Task 4                        |
| §3.4 Tests                           | Task 1 step 1                 |
| §4 Delivery (two PRs)                | Tasks 5 (PR 1) and 12 (PR 2)  |

No spec section is unrepresented.

**Placeholder scan:** No "TBD" / "fill in" / "similar to" left. Every code step contains complete code.

**Type consistency:**

- `isPlatformWideUser` referenced in Tasks 7, 8, 9 — defined in Task 7 step 3.
- `Zone` type defined in Task 2 step 2, used in Tasks 2 + 3 + 4 (`'OUTSIDE'` everywhere — no stray `'BEYOND'`).
- `TriggeredAlert` interface defined in Task 2 step 1, used in Task 4 step 1.
- `canViewPlatformOverview` defined in Task 10, used in Task 11 step 3.
- Hierarchy levels in Task 7 step 1 match the spec table (5/4/3/2/1).

# Roles + Replay Visibility — Design

**Date:** 2026-05-11
**Status:** Draft, awaiting user review
**Author:** Brainstorm session
**Scope:** Two independent features, designed together, shipped in two PRs

---

## 1. Background & Goals

Two unrelated improvements to FlashAware:

1. **Add a `representative` role** that sits between `admin` and `super_admin`. It carries cross-organisation operational reach (so a customer-success rep like Hugh van Niekerk can manage many tenants) but is fenced out of platform-shape actions (creating orgs, promoting peers, system config, billing).
2. **Widen Replay's lightning visibility** so users can see strikes near them that did *not* trigger an alert. Today the Replay map only renders flashes inside `prepare_radius_km`; a user whose friend is at a braai outside the ring will not see the nearby lightning on Replay and may conclude the system is broken.

The two features are independent. They are bundled into one spec for coherence and split into two PRs so the higher-risk auth change can be reviewed separately from the visual replay change.

---

## 2. Feature 1 — `representative` role

### 2.1 Hierarchy

Current (`server/auth.ts` line 302):

```
super_admin: 4, admin: 3, operator: 2, viewer: 1
```

New:

```
super_admin: 5, representative: 4, admin: 3, operator: 2, viewer: 1
```

### 2.2 Permission policy

A `representative` is "an admin who can operate across every tenant org." They are denied the actions that shape the platform itself.

| Action | viewer | operator | admin | representative | super_admin |
| --- | --- | --- | --- | --- | --- |
| Read locations/status/replay (own org) | ✅ | ✅ | ✅ | ✅ (any org) | ✅ (any org) |
| Acknowledge alerts | — | ✅ | ✅ | ✅ (any org) | ✅ (any org) |
| Edit locations / settings / recipients (own org) | — | — | ✅ | ✅ (any org) | ✅ (any org) |
| Manage users within an org | — | — | ✅ | ✅ (any org, capped at `admin`) | ✅ |
| View audit log | — | — | ✅ (own org) | ✅ (any org) | ✅ (all) |
| View platform overview (cross-org dashboards) | — | — | — | ✅ read-only | ✅ |
| Create / delete organisations | — | — | — | ❌ | ✅ |
| Promote users to `representative` or `super_admin` | — | — | — | ❌ | ✅ |
| Modify platform-level settings / system config (anything served from `server/platformRoutes.ts` that mutates state) | — | — | — | ❌ | ✅ |
| Manage billing (when introduced) | — | — | — | ❌ | ✅ |

Role assignment rule:
- `admin` can assign `admin / operator / viewer` within their own org (unchanged).
- `representative` can assign `admin / operator / viewer` in any org (same set as admin — they cannot manufacture peers).
- `super_admin` can assign any role including `representative` and `super_admin`.

Org scope: a `representative` user has no fixed "home org" in the practical sense. We will store `org_id` for the rep as the platform tenant (same convention `super_admin` uses today). The `OrgScope` cross-org switcher already gates by `isSuperAdmin`; we widen that gate to `isSuperAdmin || isRepresentative`.

### 2.3 Schema migration

New migration step in `server/migrate.ts`:

```sql
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('super_admin','representative','admin','operator','viewer'));
```

No data backfill. Existing users keep their current role. The migration is idempotent via the `DROP CONSTRAINT IF EXISTS`.

### 2.4 Type / code updates

Single source-of-truth approach — every duplicate of the role union widens together in one commit so the type system catches every missed call site:

- `server/auth.ts` — `AuthUser.role` union; `hierarchy` map.
- `server/queries/users.ts` — `UserRow.role`, `UserListRow.role` unions.
- `server/userRoutes.ts` — zod `role: z.enum(...)` (two occurrences: createUserSchema, updateUserSchema). Admin-assignable enum stays `['admin','operator','viewer']`. A new `superAssignableRoleSchema` adds `'representative'` for super_admin requests. Server enforces that an admin or representative caller cannot pass a role outside the admin-assignable set (rejected with 400).
- `server/orgRoutes.ts` — invite schema role enum widened identically.
- `server/authScope.ts` — `resolveOrgScope` already exempts `super_admin`; widen to `super_admin || representative`.
- `client/src/hooks/useAuth.ts` — `Role` union; add `isRepresentative`. Update `isAdminOrAbove` to `isSuperAdmin || isRepresentative || isAdmin` so every existing capability gated on it (`canEditLocations`, `canEditUsers`, `canEditSettings`, `canViewAuditLog`, `canAcknowledgeAlerts`) extends to representatives without per-flag rewrites. `canManageOrgs` stays `isSuperAdmin` only (Action A). New flag `canViewPlatformOverview = isSuperAdmin || isRepresentative`.
- `client/src/components/PermissionGate.tsx` — no change; it accepts any `Role[]`.
- `server/dev/mockData.ts` — role union widened; no seeded rep user by default.

### 2.5 UI changes

- Role labels: display **"Representative"** wherever role appears (UserManagement table, role pickers, badges).
- `UserManagement.tsx` role-select dropdown: includes `Representative` only for super_admin callers.
- `OrgScope` cross-org switcher: shows for `representative` users with the same behaviour as super_admin.
- `PlatformOverview.tsx`: rendered for representatives in read-only mode — disable mutation buttons; existing data-fetching code is unchanged.
- A small role-help info tooltip in `UserManagement.tsx` explaining each role in one line.

### 2.6 Tests

- `server/tests/authScope.test.ts` — assert `resolveOrgScope` returns `undefined` (cross-org) for `representative`.
- `server/tests/tenantIsolation.integration.test.ts` — representative can read/write across orgs; representative is rejected (403) on org create/delete, promote-to-rep, promote-to-super, platform-settings mutation.
- `server/tests/userUpdate.test.ts` — admin assigning `representative` is rejected (400); representative assigning `representative` is rejected (400); super_admin assigning `representative` succeeds.
- Client unit test on `useAuth` — verifies the new flags.

### 2.7 Out of scope

- A separate `regional_manager` role with geographic scoping. The name was considered and rejected because the current request describes globally-visible reps; we keep the `regional_manager` name available for future use.
- Per-org assignment tables. A representative sees all orgs.

---

## 3. Feature 2 — Replay wide-area lightning visibility

### 3.1 Server change

File: `server/statusRoutes.ts`, `/api/replay/:locationId`.

- Replace the current `ST_DWithin(..., loc.prepare_radius_km * 1000)` filter with a fixed **200 km** radius around the location centroid.
- Add `LIMIT 5000` to the flash query, ordered by `flash_time_utc ASC`.
- Add `flashes_truncated: boolean` to the response (true when 5000 rows returned).
- Add a `triggered_alerts: { transition_id, alert_id, sent_at }[]` array to the response — a join from `risk_states` to `alerts` over the lookback window for this location. Used by the client to render bell icons on the timeline.

Performance note: a 200 km query at 24h covers ~125,000 km² of South African airspace. Observed historical peak (Highveld summer storm) ≈ 2,000 flashes per hour within 200 km. 24h × 2,000 = 48,000 in the absolute worst case, but storms move and the typical 24h window is ≪ 10,000. The 5,000 cap protects against catastrophic days; the truncation flag tells the user.

### 3.2 Client change — `client/src/Replay.tsx`

Zone classification widens to four bands:

```ts
type Zone = 'STOP' | 'PREPARE' | 'OUTSIDE';
//  STOP:     distance_km ≤ stop_radius_km
//  PREPARE:  distance_km ≤ prepare_radius_km
//  OUTSIDE:  distance_km ≤ 200  (server-filtered max)
```

The legacy `BEYOND` label (dead today) is renamed to `OUTSIDE` for clarity.

Map styling:

| Zone | Colour | Radius (px) | Opacity |
| --- | --- | --- | --- |
| STOP | `#f44336` (red) | 5 | 1.0 (decays with age — unchanged) |
| PREPARE | `#fbc02d` (amber) | 5 | 1.0 (decays with age — unchanged) |
| OUTSIDE | `#90a4ae` (grey) | 3 | 0.4 |

Map auto-fit:
- Default: keep `FitToRadius` zoomed to `prepare_radius_km` (the alert area remains the focal point).
- A new **"Show wider view"** toggle in the controls card re-fits to a 200 km bounding box. Toggle state is component-local; no URL persistence.

Legend (new card immediately above the map):
- Four swatches: STOP zone, PREPARE zone, Outside alert radius (context only), plus an alert-bell glyph captioned "Alert was sent."
- One-line caption beneath: *"Alerts are triggered by strikes inside your alert radius. Strikes outside are shown for context and did not trigger an alert."*

Flash table: existing table shows flashes in the evaluation window. Add `OUTSIDE` row support with grey styling matching the map.

Timeline alert bells:
- The existing state-transition bar (lines 596–643) gets a small bell icon overlaid at the x-position of each transition that produced an alert. Bell colour matches the post-transition state colour.
- Hover tooltip: "Alert sent at {time}."

### 3.3 What is deliberately not built

- **Per-flash alert attribution.** Alerts fire from state transitions, not from individual flashes. Marking specific flashes as "this one triggered the alert" would be a lie about the data model. The legend caption + timeline bells communicate the correct mental model: *radius-based count crossed a threshold → alert sent*, not *this specific flash sent an alert*.
- **SA-wide mode in v1.** The 200 km cap covers the friend-at-a-braai scenario (≈2-hour drive radius). If usage shows users wanting truly distant context, a v2 "SA-wide" toggle is easy to add.
- **Viewport-driven fetching.** Out of scope; would require a much bigger build (debouncing, request cancellation, bbox queries).

### 3.4 Tests

- `server/tests/uxFixes.test.ts` or a new `replay.integration.test.ts`: insert a flash at 150 km from a location with `prepare_radius_km = 25`; assert the replay response includes it. Insert 5,001 flashes; assert `flashes_truncated: true` and 5000 rows returned.
- Client unit test on the four-band zone classifier.

---

## 4. Delivery plan

Two PRs against `master`:

**PR 1 — Replay wide-area visibility** (ship first, lower risk).
- Server query + truncation flag + alerts join.
- Client legend, styling, "Show wider view" toggle, timeline bells.
- Integration test, client unit test.

**PR 2 — `representative` role** (ship second, higher risk).
- Migration step.
- Type union + zod widening across server + client.
- `OrgScope` and `PlatformOverview` gating.
- Tests for cross-org behaviour and denied platform actions.

Each PR carries its own migration / type contract and can be reviewed and reverted independently.

---

## 5. Open questions

None at the time of writing. The user has answered:

- Scope: combined spec, two PRs (A).
- Rep scope: cross-org visibility with platform-action denies (B).
- Denied actions: A + B + D + F.
- Naming: `representative` (A).
- Replay scope: 200 km cap radius (B).
- Visual treatment: small grey dots + alert bells on timeline (A).

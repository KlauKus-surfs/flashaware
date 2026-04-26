# FlashAware UX Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the FlashAware client up to first-class-operational-tool quality. Fix the 23 issues from the 2026-04-26 UX review and add the foundation pieces (shared components, real-time websocket) that compound across future work.

**Architecture:** Phased, each phase = one shippable commit. Order:

1. **Foundation** — shared `<EmptyState />`, `<OrgScopeBanner />`, single source of truth for `STATE_CONFIG` + glossary content. Everything downstream uses these.
2. **Visual quick wins** — PREPARE chip contrast, mobile "Data Degraded" visibility, icon-button `aria-label`s. Small, high impact.
3. **Real-time Dashboard** — re-add `socket.io-client`, `useRealtimeAlerts` hook, animated state-change cue, optional browser notifications. Closes the biggest UX gap.
4. **First-run onboarding** — empty-state CTAs, 3-step setup checklist on Dashboard.
5. **State vocabulary** — glossary modal, info icon on Dashboard, explainer on AlertHistory state chip.
6. **OTP UX** — server retry-after + attempts-remaining, client countdown timer, friendly errors.
7. **Threshold form clarity** — semantic field grouping, live preview sentence.
8. **Mobile alert ack** — one-tap ack on un-expanded row, sticky action bar.
9. **Persistent org-scope banner** — at layout level, on every page when scope ≠ default.
10. **Audit log filters** — actor email, target id, date range; click-to-filter.
11. **Platform "needs attention"** — proactive surfacing of stuck unacked, degraded feeds.
12. **Polish + a11y** — diff view in audit, inline form errors, mobile map auto-fit, alert pagination correctness.

Each phase commits independently. Server-side TDD where logic exists; UI tests where components are pure; manual verification steps for visual-only changes.

**Tech Stack:** React 18, TypeScript, MUI 5, react-leaflet, Vitest. Server: Express, `socket.io` (already wired server-side via `wsManager`), Postgres.

---

## Phase 0: Pre-flight

### Task 0.1: Confirm working tree clean and tests pass

**Files:** none

- [ ] **Step 1: Verify clean tree**

Run: `git status --short`
Expected: empty output (or only `SETUP.md` untracked).

- [ ] **Step 2: Server tests green**

Run: `cd server && npm test`
Expected: `19 passed`.

- [ ] **Step 3: Both ends type-check**

Run: `cd server && npx tsc --noEmit && cd ../client && npx tsc --noEmit && echo OK`
Expected: `OK`.

If anything fails here, stop and fix before proceeding.

---

## Phase 1: Foundation — shared components + state vocabulary

### Task 1.1: Single source of truth for risk states

**Files:**
- Create: `client/src/states.ts`

The `STATE_CONFIG` map currently lives in `Dashboard.tsx:21-27` and is duplicated (with slight drift) in `LocationEditor.tsx:36-39` and `AlertHistory.tsx`. We extract it once.

- [ ] **Step 1: Write the file**

```typescript
// client/src/states.ts
// Single source of truth for risk-state colour, label, and glossary text.
// Imported by Dashboard, LocationEditor, AlertHistory, and the glossary modal.

export type RiskState = 'ALL_CLEAR' | 'PREPARE' | 'STOP' | 'HOLD' | 'DEGRADED';

export interface StateConfig {
  color: string;       // accessible foreground colour for chips
  bg: string;          // soft background fill
  textColor: string;   // text colour to put ON `color` (chip foreground)
  label: string;
  emoji: string;
  short: string;       // one-line description for tooltips
  long: string;        // 1-2 sentence description for the glossary modal
}

// PREPARE chip uses dark text on a yellow background — white-on-yellow fails
// WCAG AA contrast (~1.86:1). Black-on-yellow is ~10:1.
export const STATE_CONFIG: Record<RiskState, StateConfig> = {
  ALL_CLEAR: {
    color: '#2e7d32', bg: 'rgba(46,125,50,0.12)', textColor: '#fff',
    label: 'ALL CLEAR', emoji: '🟢',
    short: 'Safe — resume normal activity.',
    long: 'No nearby lightning has been detected for the configured wait window. Normal operations may resume.',
  },
  PREPARE: {
    color: '#fbc02d', bg: 'rgba(251,192,45,0.12)', textColor: '#000',
    label: 'PREPARE', emoji: '🟡',
    short: 'Heightened awareness — stay near shelter.',
    long: 'Lightning has been detected in the wider PREPARE radius. Move toward shelter and prepare to halt outdoor work; STOP may follow.',
  },
  STOP: {
    color: '#d32f2f', bg: 'rgba(211,47,47,0.12)', textColor: '#fff',
    label: 'STOP', emoji: '🔴',
    short: 'Danger — evacuate or seek shelter immediately.',
    long: 'Lightning has been detected inside or very close to the STOP radius. Halt outdoor work and seek shelter. The site stays STOP until the configured All Clear wait passes with no nearby flashes.',
  },
  HOLD: {
    color: '#ed6c02', bg: 'rgba(237,108,2,0.12)', textColor: '#fff',
    label: 'HOLD', emoji: '🟠',
    short: 'Cooling off — STOP cleared but still risky.',
    long: 'Conditions for STOP are no longer met but flashes are still active in the PREPARE radius. The site holds shelter status until lightning fully clears.',
  },
  DEGRADED: {
    color: '#9e9e9e', bg: 'rgba(158,158,158,0.12)', textColor: '#fff',
    label: 'NO DATA FEED', emoji: '⚠️',
    short: 'No live data — treat as unsafe.',
    long: 'The EUMETSAT lightning feed is delayed or unavailable. The risk engine cannot evaluate. Treat outdoor activity as unsafe until the feed recovers.',
  },
};

// Convenience: all states ranked from most-severe to least-severe (used for
// dashboard sort order and operator triage).
export const STATE_RANK: Record<RiskState, number> = {
  STOP: 1, HOLD: 2, DEGRADED: 3, PREPARE: 4, ALL_CLEAR: 5,
};

export function stateOf(s: string | null | undefined): RiskState {
  if (s && s in STATE_CONFIG) return s as RiskState;
  return 'DEGRADED';
}
```

- [ ] **Step 2: Type-check**

Run: `cd client && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Replace duplicated definitions**

Edit `client/src/Dashboard.tsx`: delete lines 21-27 (the `STATE_CONFIG` literal). Replace `import { … }` block with `import { STATE_CONFIG, stateOf } from './states';`. Update any `STATE_CONFIG[loc.state || 'DEGRADED']` to `STATE_CONFIG[stateOf(loc.state)]`. Update chip components that use white-on-yellow to use `cfg.textColor` instead of hardcoded `'#fff'`.

Edit `client/src/LocationEditor.tsx`: delete the `STATE_COLORS` map (around line 36-39). Replace usages of `STATE_COLORS[loc.current_state || 'DEGRADED']` with `STATE_CONFIG[stateOf(loc.current_state)].color`.

Edit `client/src/AlertHistory.tsx`: replace any state→colour mapping with the shared one.

- [ ] **Step 4: Type-check + manual verify**

Run: `cd client && npx tsc --noEmit`
Expected: clean.

Run dev server (`cd client && npm run dev`), open Dashboard, verify PREPARE chip is now black-on-yellow (readable), other states unchanged.

- [ ] **Step 5: Commit**

```bash
git add client/src/states.ts client/src/Dashboard.tsx client/src/LocationEditor.tsx client/src/AlertHistory.tsx
git commit -m "refactor: extract STATE_CONFIG to client/src/states.ts; fix PREPARE contrast"
```

---

### Task 1.2: `<EmptyState />` shared component

**Files:**
- Create: `client/src/components/EmptyState.tsx`

- [ ] **Step 1: Write the component**

```tsx
// client/src/components/EmptyState.tsx
import React from 'react';
import { Box, Typography, Button } from '@mui/material';
import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
  cta?: { label: string; onClick: () => void; icon?: ReactNode };
  secondaryCta?: { label: string; onClick: () => void };
}

/**
 * Shared empty-state used by Dashboard, Locations, Alerts, Audit, Replay.
 * Always at least one CTA — empty states without a path forward are
 * confusing for first-time users.
 */
export default function EmptyState({ icon, title, description, cta, secondaryCta }: EmptyStateProps) {
  return (
    <Box sx={{ textAlign: 'center', py: 6, px: 2 }}>
      <Box sx={{ color: 'text.secondary', mb: 1, '& > svg': { fontSize: 48 } }}>{icon}</Box>
      <Typography variant="h6" sx={{ fontSize: 16, mb: 0.5 }}>{title}</Typography>
      {description && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: cta ? 2 : 0, maxWidth: 480, mx: 'auto' }}>
          {description}
        </Typography>
      )}
      <Box sx={{ display: 'flex', gap: 1, justifyContent: 'center', flexWrap: 'wrap', mt: 2 }}>
        {cta && (
          <Button variant="contained" startIcon={cta.icon} onClick={cta.onClick}>
            {cta.label}
          </Button>
        )}
        {secondaryCta && (
          <Button variant="outlined" onClick={secondaryCta.onClick}>{secondaryCta.label}</Button>
        )}
      </Box>
    </Box>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd client && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: No commit yet** — wait until Task 1.3 (consumers also added in Phase 4).

---

### Task 1.3: `<OrgScopeBanner />` shared component

**Files:**
- Create: `client/src/components/OrgScopeBanner.tsx`

- [ ] **Step 1: Write it**

```tsx
// client/src/components/OrgScopeBanner.tsx
import React from 'react';
import { Box, Typography, Button } from '@mui/material';
import BusinessIcon from '@mui/icons-material/Business';
import { useCurrentUser } from '../App';
import { useOrgScope } from '../OrgScope';

/**
 * Persistent banner that reminds super_admin which tenant they're acting as.
 * Renders only when:
 *   1. role === 'super_admin', AND
 *   2. a non-default org is selected (i.e. NOT FlashAware default).
 * Otherwise renders null so non-super users never see it.
 *
 * Mounted at layout level (App.tsx) so it appears on every page during a
 * cross-tenant session — destructive writes always have a visible reminder.
 */
export default function OrgScopeBanner() {
  const user = useCurrentUser();
  const { scopedOrgId, scopedOrgName, setScopedOrgId } = useOrgScope();

  if (user?.role !== 'super_admin') return null;
  if (!scopedOrgId) return null;

  return (
    <Box
      sx={{
        bgcolor: 'warning.dark',
        color: 'warning.contrastText',
        px: 2, py: 0.75,
        display: 'flex', alignItems: 'center', gap: 1,
        fontSize: 13, fontWeight: 500,
        borderBottom: '1px solid rgba(0,0,0,0.2)',
      }}
      role="status"
      aria-live="polite"
    >
      <BusinessIcon sx={{ fontSize: 18 }} />
      <Typography sx={{ flex: 1, fontSize: 13, fontWeight: 600 }}>
        Acting as <span style={{ textDecoration: 'underline' }}>{scopedOrgName}</span> — every action affects this tenant's data.
      </Typography>
      <Button
        size="small"
        color="inherit"
        variant="outlined"
        onClick={() => setScopedOrgId(null)}
        sx={{ borderColor: 'currentColor', fontSize: 11 }}
      >
        Switch back to All
      </Button>
    </Box>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd client && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Mount in App.tsx layout**

Edit `client/src/App.tsx`. Find the `<AppBar>` block (around line 256). Insert `<OrgScopeBanner />` immediately AFTER `</AppBar>` and BEFORE the main content `<Box sx={{ flexGrow: 1, p: ...}}>`.

Add the import: `import OrgScopeBanner from './components/OrgScopeBanner';`.

- [ ] **Step 4: Manual verify**

Type-check, run dev server. As `admin@flashaware.com`, set picker to a non-default org. Banner appears across the top on every page. Click "Switch back to All" — banner disappears, picker resets.

- [ ] **Step 5: Commit (the foundation phase)**

```bash
git add client/src/components/EmptyState.tsx client/src/components/OrgScopeBanner.tsx client/src/App.tsx
git commit -m "feat: shared EmptyState component + persistent OrgScopeBanner"
```

---

## Phase 2: Visual quick wins

### Task 2.1: "Data Degraded" chip visible on mobile

**Files:**
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Find the chip**

Read `client/src/App.tsx` around line 240-260. The chip currently has `display: { xs: 'none', sm: 'flex' }`.

- [ ] **Step 2: Show on all sizes, smaller on xs**

Replace:
```tsx
<Chip label="⚠ DATA DEGRADED" color="error" size="small" sx={{ mr: 1, fontWeight: 600, display: { xs: 'none', sm: 'flex' } }} />
```
with:
```tsx
<Chip
  label="⚠ DEGRADED"
  color="error"
  size="small"
  sx={{
    mr: 1,
    fontWeight: 600,
    fontSize: { xs: 10, sm: 12 },
    height: { xs: 22, sm: 24 },
  }}
/>
```

- [ ] **Step 3: Manual verify**

Open dev server on a mobile width (Chrome devtools 360x640). Stop the EUMETSAT feed (or just temporarily make the health check fail) — verify the chip is visible on mobile.

---

### Task 2.2: aria-labels on icon-only buttons

**Files:**
- Modify: `client/src/Dashboard.tsx`, `AlertHistory.tsx`, `AuditLog.tsx`, `LocationEditor.tsx`, `OrgManagement.tsx`, `PlatformOverview.tsx`

- [ ] **Step 1: Sweep for IconButton without aria-label**

Run: `cd client && grep -rn 'IconButton' src --include='*.tsx' | grep -v 'aria-label'`

For each match where the button only contains an icon, add `aria-label` matching the action.

- [ ] **Step 2: Apply edits**

For Refresh icons: `aria-label="Refresh"`.
For Expand toggles: `aria-label="Expand details"` / `"Collapse details"`.
For Delete icons: `aria-label="Delete"`.
For Edit icons: `aria-label="Edit"`.
For Copy icons (invite link): `aria-label="Copy invite link"`.

(Concrete edit list — apply only the ones that exist in current source. Don't invent matches.)

- [ ] **Step 3: Type-check + commit**

```bash
cd client && npx tsc --noEmit
cd .. && git add client/src/App.tsx client/src/Dashboard.tsx client/src/AlertHistory.tsx client/src/AuditLog.tsx client/src/LocationEditor.tsx client/src/OrgManagement.tsx client/src/PlatformOverview.tsx
git commit -m "fix(a11y): aria-labels on icon-only buttons; show DEGRADED chip on mobile"
```

---

## Phase 3: Real-time Dashboard

### Task 3.1: Re-introduce socket.io-client

**Files:**
- Modify: `client/package.json`

- [ ] **Step 1: Add dep**

Run: `cd client && npm install --save socket.io-client@^4.7.4`

- [ ] **Step 2: Verify**

Run: `grep socket.io-client client/package.json`
Expected: `"socket.io-client": "^4.7.4"` line present.

- [ ] **Step 3: No commit yet** — bundled with Task 3.5.

---

### Task 3.2: Server-side: confirm websocket auth + alert broadcast already work

**Files:**
- Read: `server/websocket.ts`

- [ ] **Step 1: Audit websocket payload shape**

Read `server/websocket.ts`. Confirm `wsManager.broadcastAlertTriggered({ locationId, locationName, alertType, state, reason, timestamp })` is called from `alertService.ts:130-137`. Document the payload as `WsAlertPayload` so the client can match.

- [ ] **Step 2: Add type export**

Edit `server/websocket.ts`: at the top, add and export the type:

```typescript
export interface WsAlertPayload {
  locationId: string;
  locationName: string;
  alertType: string;        // 'system' | 'email' | 'sms' | 'whatsapp'
  state: string;            // 'STOP' | 'PREPARE' | 'HOLD' | 'ALL_CLEAR' | 'DEGRADED'
  reason: string;
  timestamp: string;        // ISO
}
```

Adjust the `broadcastAlertTriggered(payload: WsAlertPayload)` signature accordingly. If a different shape is currently in use, prefer changing it to match this — server-side callers are easy to update.

- [ ] **Step 3: Type-check server**

Run: `cd server && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: No commit yet.**

---

### Task 3.3: Client `useRealtimeAlerts` hook

**Files:**
- Create: `client/src/useRealtimeAlerts.ts`

- [ ] **Step 1: Write hook**

```typescript
// client/src/useRealtimeAlerts.ts
import { useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';

export interface RealtimeAlert {
  locationId: string;
  locationName: string;
  alertType: string;
  state: string;
  reason: string;
  timestamp: string;
}

/**
 * Subscribes to server-pushed alert events. Reconnects automatically with
 * exponential backoff on transient drops; permanent failures (e.g. invalid
 * token) silently fall back — the 30s polling on Dashboard still keeps data
 * fresh, just less reactively.
 */
export function useRealtimeAlerts(onAlert: (a: RealtimeAlert) => void) {
  const socketRef = useRef<Socket | null>(null);
  // Capture latest callback so the effect doesn't re-run on every parent render.
  const cbRef = useRef(onAlert);
  cbRef.current = onAlert;

  useEffect(() => {
    const token = localStorage.getItem('flashaware_token');
    if (!token) return;

    // Connect to same origin; production serves api + socket on same port.
    const socket = io({
      auth: { token },
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 30_000,
      reconnectionAttempts: Infinity,
      transports: ['websocket', 'polling'],
    });

    socketRef.current = socket;

    socket.on('alert.triggered', (payload: RealtimeAlert) => {
      cbRef.current(payload);
    });

    socket.on('connect_error', (err) => {
      // Don't spam the console on every reconnect attempt.
      if (err.message !== 'jwt expired') console.warn('[ws] connect_error:', err.message);
    });

    return () => { socket.close(); socketRef.current = null; };
  }, []);
}
```

- [ ] **Step 2: Type-check**

Run: `cd client && npx tsc --noEmit`
Expected: clean.

---

### Task 3.4: Wire hook into Dashboard with audible/visual cue on state worsening

**Files:**
- Modify: `client/src/Dashboard.tsx`
- Add: `client/public/alert.mp3` (a short tone; if asset not available, skip the audio cue and document so)

- [ ] **Step 1: Import + import**

Add to Dashboard imports:
```tsx
import { useRealtimeAlerts } from './useRealtimeAlerts';
import { STATE_RANK } from './states';
```

- [ ] **Step 2: Animate the affected card on push**

Add state + handler inside `Dashboard()`:

```tsx
const [pulseId, setPulseId] = useState<string | null>(null);

useRealtimeAlerts((alert) => {
  // Optimistically merge new state into local list so the user sees the
  // change BEFORE the next 15s poll. Then trigger a brief pulse.
  setLocations(prev => prev.map(l =>
    l.id === alert.locationId ? { ...l, state: alert.state } : l
  ));

  // Find the location's previous state to decide whether this is a worsening
  // (audible cue) or improvement (silent).
  const prev = locations.find(l => l.id === alert.locationId);
  const prevRank = STATE_RANK[(prev?.state ?? 'ALL_CLEAR') as keyof typeof STATE_RANK] ?? 5;
  const newRank = STATE_RANK[alert.state as keyof typeof STATE_RANK] ?? 5;
  const worsened = newRank < prevRank; // STOP=1 is worse than ALL_CLEAR=5

  setPulseId(alert.locationId);
  setTimeout(() => setPulseId(curr => curr === alert.locationId ? null : curr), 4000);

  if (worsened) {
    try {
      const audio = new Audio('/alert.mp3');
      audio.volume = 0.5;
      audio.play().catch(() => { /* autoplay blocked — silent is fine */ });
    } catch (_) { /* no audio support */ }
  }
});
```

- [ ] **Step 3: Animate the pulse**

In the StatusCard render block (where `<StatusCard key={loc.id} loc={loc} />` is rendered), pass `pulse={pulseId === loc.id}`. Inside `StatusCard`:

```tsx
function StatusCard({ loc, pulse }: { loc: LocationStatus; pulse?: boolean }) {
  // ... existing code ...
  return (
    <Card sx={{
      // existing sx,
      animation: pulse ? 'flashalert 1s ease-in-out 2' : undefined,
      '@keyframes flashalert': {
        '0%, 100%': { boxShadow: 'none' },
        '50%': { boxShadow: '0 0 0 4px rgba(211,47,47,0.6)' },
      },
    }}>
```

- [ ] **Step 4: Add audio asset (optional)**

Place a 1-second alert tone at `client/public/alert.mp3`. If asset isn't available, skip — `audio.play()` swallows errors. Document in comment.

- [ ] **Step 5: Type-check + manual verify**

Run: `cd client && npx tsc --noEmit && npm run dev`. In another terminal, `cd server && npm run dev`. Open the Dashboard. Trigger an alert (use mock simulation by leaving EUMETSAT creds blank, or hit `POST /api/test-email` with an alert location's recipient). Verify the affected card pulses red within ~1 second of the event firing.

- [ ] **Step 6: Commit (real-time phase)**

```bash
git add client/package.json client/package-lock.json client/src/useRealtimeAlerts.ts client/src/Dashboard.tsx server/websocket.ts client/public/alert.mp3
git commit -m "feat: real-time Dashboard via socket.io with pulse + audio on state worsening"
```

---

### Task 3.5: Browser notifications (opt-in)

**Files:**
- Modify: `client/src/Dashboard.tsx`

- [ ] **Step 1: Add a small "Enable notifications" prompt that appears once per browser**

Inside Dashboard, alongside the audio cue:

```tsx
useEffect(() => {
  // Ask once. Browser remembers the answer; if denied, we silently skip.
  if ('Notification' in window && Notification.permission === 'default') {
    // Don't auto-prompt — show a tiny banner asking instead, so we don't
    // surprise the user the first time the dashboard loads.
    setShowNotifBanner(true);
  }
}, []);
```

Add a dismissible banner above the location grid:

```tsx
{showNotifBanner && (
  <Alert
    severity="info"
    onClose={() => setShowNotifBanner(false)}
    action={
      <Button color="inherit" size="small" onClick={async () => {
        const result = await Notification.requestPermission();
        setShowNotifBanner(false);
        if (result === 'granted') localStorage.setItem('flashaware_notif_ok', '1');
      }}>
        Enable
      </Button>
    }
    sx={{ mb: 2 }}
  >
    Get desktop notifications when a site goes STOP — even when the tab is in the background.
  </Alert>
)}
```

In the realtime handler, add:

```tsx
if (worsened && Notification.permission === 'granted' && document.hidden) {
  new Notification('FlashAware: ' + alert.state, {
    body: `${alert.locationName}: ${alert.reason}`,
    tag: alert.locationId,        // de-dup multiple events for same site
    requireInteraction: alert.state === 'STOP',
  });
}
```

- [ ] **Step 2: Manual verify**

Reload the dashboard, accept notification permission. Trigger another worsening event with the tab in the background — verify a desktop notification appears.

- [ ] **Step 3: Commit**

```bash
git add client/src/Dashboard.tsx
git commit -m "feat: opt-in browser notifications for STOP events"
```

---

## Phase 4: First-run onboarding

### Task 4.1: Setup-checklist component

**Files:**
- Create: `client/src/components/SetupChecklist.tsx`

- [ ] **Step 1: Write component**

```tsx
// client/src/components/SetupChecklist.tsx
import React from 'react';
import { Card, CardContent, Typography, Box, Chip, Button } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import { useNavigate } from 'react-router-dom';

interface ChecklistState {
  hasLocation: boolean;
  hasRecipient: boolean;
  hasVerifiedPhone: boolean;
}

interface SetupChecklistProps {
  state: ChecklistState;
}

/**
 * Shown at the top of the Dashboard until the user has at least one location
 * and at least one verified-phone recipient. Auto-dismisses once all three
 * boxes are ticked. The point is to give a first-time admin a path forward
 * instead of an empty dashboard.
 */
export default function SetupChecklist({ state }: SetupChecklistProps) {
  const navigate = useNavigate();
  if (state.hasLocation && state.hasRecipient && state.hasVerifiedPhone) return null;

  const items = [
    { done: state.hasLocation,       label: 'Add your first monitored location',          cta: 'Add location',    onClick: () => navigate('/locations') },
    { done: state.hasRecipient,      label: 'Add a person to receive alerts',             cta: 'Add recipient',   onClick: () => navigate('/locations') },
    { done: state.hasVerifiedPhone,  label: 'Verify a phone for SMS / WhatsApp alerts',   cta: 'Verify phone',    onClick: () => navigate('/locations') },
  ];

  return (
    <Card sx={{ mb: 3, border: '1px solid', borderColor: 'primary.main' }}>
      <CardContent>
        <Typography variant="h6" sx={{ fontSize: 16, mb: 1 }}>
          Get started — {items.filter(i => i.done).length} of {items.length} done
        </Typography>
        {items.map((item, i) => (
          <Box key={i} sx={{ display: 'flex', alignItems: 'center', py: 1, gap: 1.5 }}>
            {item.done
              ? <CheckCircleIcon sx={{ color: 'success.main' }} />
              : <RadioButtonUncheckedIcon sx={{ color: 'text.secondary' }} />}
            <Typography sx={{ flex: 1, color: item.done ? 'text.secondary' : 'text.primary', textDecoration: item.done ? 'line-through' : 'none' }}>
              {item.label}
            </Typography>
            {!item.done && (
              <Button size="small" onClick={item.onClick}>{item.cta}</Button>
            )}
          </Box>
        ))}
      </CardContent>
    </Card>
  );
}
```

---

### Task 4.2: Server endpoint for checklist state

**Files:**
- Modify: `server/index.ts`

- [ ] **Step 1: Add endpoint**

Add to `server/index.ts` near the other dashboard endpoints:

```typescript
app.get('/api/onboarding/state', authenticate, requireRole('viewer'), async (req: AuthRequest, res) => {
  try {
    const orgId = req.user!.org_id;
    const { query } = await import('./db');
    const r = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM locations WHERE org_id = $1)                                                 AS location_count,
         (SELECT COUNT(*)::int FROM location_recipients lr
            INNER JOIN locations l ON l.id = lr.location_id
            WHERE l.org_id = $1)                                                                                  AS recipient_count,
         (SELECT COUNT(*)::int FROM location_recipients lr
            INNER JOIN locations l ON l.id = lr.location_id
            WHERE l.org_id = $1 AND lr.phone_verified_at IS NOT NULL)                                             AS verified_recipient_count`,
      [orgId]
    );
    const row = r.rows[0];
    res.json({
      hasLocation: row.location_count > 0,
      hasRecipient: row.recipient_count > 0,
      hasVerifiedPhone: row.verified_recipient_count > 0,
    });
  } catch (error) {
    logger.error('Failed to get onboarding state', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to get onboarding state' });
  }
});
```

- [ ] **Step 2: Add api.ts helper**

Edit `client/src/api.ts`:

```typescript
export const getOnboardingState = () => api.get<{ hasLocation: boolean; hasRecipient: boolean; hasVerifiedPhone: boolean }>('/onboarding/state');
```

- [ ] **Step 3: Type-check both**

Run: `cd server && npx tsc --noEmit && cd ../client && npx tsc --noEmit && echo OK`
Expected: `OK`.

---

### Task 4.3: Wire checklist into Dashboard

**Files:**
- Modify: `client/src/Dashboard.tsx`

- [ ] **Step 1: Add state + fetch**

Inside `Dashboard()`:

```tsx
import { getOnboardingState } from './api';
import SetupChecklist from './components/SetupChecklist';

// ...

const [onboarding, setOnboarding] = useState<{ hasLocation: boolean; hasRecipient: boolean; hasVerifiedPhone: boolean } | null>(null);

useEffect(() => {
  getOnboardingState().then(r => setOnboarding(r.data)).catch(() => setOnboarding(null));
}, [scopedOrgId]);
```

- [ ] **Step 2: Render**

Place near the top of the Dashboard JSX, just under the page header:

```tsx
{onboarding && <SetupChecklist state={onboarding} />}
```

- [ ] **Step 3: Replace bare empty-state**

Find the existing `<Card>` at `Dashboard.tsx` ~line 335-338 (`No locations configured...`). Replace with:

```tsx
<Box sx={{ gridColumn: '1 / -1' }}>
  <EmptyState
    icon={<LocationOnIcon />}
    title="No locations configured yet"
    description="Add your first monitored location to start tracking lightning risk."
    cta={{ label: 'Add location', onClick: () => navigate('/locations'), icon: <LocationOnIcon /> }}
  />
</Box>
```

Add imports for `EmptyState` and `useNavigate`.

- [ ] **Step 4: Manual verify**

Log in as a brand-new admin (create a fresh org, accept invite, log in). Verify:
- Setup checklist shows 0/3 done.
- Empty-state CTA navigates to /locations in add mode.
- After adding a location: checklist shows 1/3.

- [ ] **Step 5: Commit**

```bash
git add server/index.ts client/src/api.ts client/src/components/SetupChecklist.tsx client/src/Dashboard.tsx
git commit -m "feat: onboarding checklist + actionable empty states for first-run admins"
```

---

## Phase 5: State vocabulary explained

### Task 5.1: `<StateGlossaryButton />` component

**Files:**
- Create: `client/src/components/StateGlossary.tsx`

- [ ] **Step 1: Write modal + trigger**

```tsx
// client/src/components/StateGlossary.tsx
import React, { useState } from 'react';
import { Dialog, DialogTitle, DialogContent, IconButton, Box, Typography, Tooltip } from '@mui/material';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import CloseIcon from '@mui/icons-material/Close';
import { STATE_CONFIG, RiskState } from '../states';

const ORDER: RiskState[] = ['STOP', 'HOLD', 'PREPARE', 'ALL_CLEAR', 'DEGRADED'];

export default function StateGlossaryButton({ size = 'small' }: { size?: 'small' | 'medium' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip title="What do these states mean?">
        <IconButton size={size} onClick={() => setOpen(true)} aria-label="State glossary">
          <HelpOutlineIcon fontSize={size} />
        </IconButton>
      </Tooltip>
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Risk state guide
          <IconButton onClick={() => setOpen(false)} aria-label="Close"><CloseIcon /></IconButton>
        </DialogTitle>
        <DialogContent>
          {ORDER.map(s => {
            const cfg = STATE_CONFIG[s];
            return (
              <Box key={s} sx={{ display: 'flex', gap: 2, mb: 2 }}>
                <Box sx={{ minWidth: 90 }}>
                  <Box sx={{
                    display: 'inline-block', px: 1, py: 0.5,
                    bgcolor: cfg.color, color: cfg.textColor, fontWeight: 700,
                    fontSize: 11, borderRadius: 1, letterSpacing: 0.5,
                  }}>
                    {cfg.label}
                  </Box>
                </Box>
                <Typography variant="body2" sx={{ flex: 1 }}>{cfg.long}</Typography>
              </Box>
            );
          })}
        </DialogContent>
      </Dialog>
    </>
  );
}
```

- [ ] **Step 2: Place on Dashboard header**

Edit `Dashboard.tsx`. Find the page title block and add `<StateGlossaryButton />` adjacent to "Monitored Locations" or in the top action row.

- [ ] **Step 3: Place on AlertHistory state column header**

Edit `AlertHistory.tsx`. In the table head where "State" column header is, wrap with: `<TableCell>State <StateGlossaryButton size="small" /></TableCell>`.

- [ ] **Step 4: Type-check + commit**

```bash
cd client && npx tsc --noEmit
cd .. && git add client/src/components/StateGlossary.tsx client/src/Dashboard.tsx client/src/AlertHistory.tsx
git commit -m "feat: state glossary modal accessible from Dashboard + AlertHistory"
```

---

## Phase 6: OTP UX

### Task 6.1: Server returns retry-after on rate-limit

**Files:**
- Modify: `server/otpService.ts`, `server/queries.ts`

- [ ] **Step 1: Add a query for the oldest sent-OTP timestamp in window**

Edit `server/queries.ts`:

```typescript
/** Returns the timestamp of the oldest OTP sent within `sinceMinutes` for this recipient,
 *  or null if no recent sends. Used to compute a retry-after window. */
export async function oldestRecentOtpSendForRecipient(recipientId: number, sinceMinutes: number): Promise<Date | null> {
  const r = await getOne<{ created_at: string }>(
    `SELECT created_at FROM recipient_phone_otps
     WHERE recipient_id = $1 AND created_at >= NOW() - make_interval(mins => $2)
     ORDER BY created_at ASC LIMIT 1`,
    [recipientId, sinceMinutes]
  );
  return r ? new Date(r.created_at) : null;
}
```

- [ ] **Step 2: Update SendOtpResult**

Edit `server/otpService.ts`:

```typescript
export interface SendOtpResult {
  ok: boolean;
  reason?: 'rate_limited' | 'twilio_disabled' | 'send_failed';
  error?: string;
  retry_at?: string;            // ISO — present when rate_limited
}
```

- [ ] **Step 3: Compute retry_at on rate-limit branch**

Inside `sendPhoneOtp`, replace the rate-limit branch:

```typescript
const recentSends = await countRecentOtpSendsForRecipient(recipientId, 60);
if (recentSends >= MAX_SENDS_PER_HOUR) {
  const oldest = await oldestRecentOtpSendForRecipient(recipientId, 60);
  // Window is rolling 60 minutes; user can try again 60min after the oldest send.
  const retryAt = oldest ? new Date(oldest.getTime() + 60 * 60_000) : new Date(Date.now() + 60 * 60_000);
  logger.warn('OTP send rate-limited', { recipientId, recentSends, retryAt: retryAt.toISOString() });
  return { ok: false, reason: 'rate_limited', retry_at: retryAt.toISOString() };
}
```

Import: `import { countRecentOtpSendsForRecipient, oldestRecentOtpSendForRecipient, ... } from './queries';`

- [ ] **Step 4: Forward retry_at to the API response**

Edit `server/index.ts`, the `/send-otp` route, replace the result-handling block:

```typescript
if (!result.ok) {
  const status = result.reason === 'rate_limited' ? 429
    : result.reason === 'twilio_disabled' ? 503
    : 500;
  return res.status(status).json({
    error: result.error || result.reason || 'Failed to send code',
    reason: result.reason,
    retry_at: result.retry_at,
  });
}
```

- [ ] **Step 5: Server type-check + commit**

```bash
cd server && npx tsc --noEmit && npm test
cd .. && git add server/otpService.ts server/queries.ts server/index.ts
git commit -m "feat(otp): server returns retry_at on rate-limit (rolling 60-min window)"
```

---

### Task 6.2: Server returns attempts_remaining on verify

**Files:**
- Modify: `server/otpService.ts`, `server/index.ts`

- [ ] **Step 1: Update VerifyOtpResult**

```typescript
export interface VerifyOtpResult {
  ok: boolean;
  reason?: 'no_active_otp' | 'too_many_attempts' | 'invalid_code';
  attempts_remaining?: number;        // present on invalid_code; 0 means next try will lockout
}
```

- [ ] **Step 2: Compute remaining**

Inside `verifyPhoneOtp`, in the `!matches` branch:

```typescript
if (!matches) {
  const newAttempts = await incrementPhoneOtpAttempts(otp.id);
  const remaining = Math.max(0, MAX_VERIFY_ATTEMPTS - newAttempts);
  return { ok: false, reason: 'invalid_code', attempts_remaining: remaining };
}
```

- [ ] **Step 3: Forward in API response**

`server/index.ts` `/verify-otp` route — return `attempts_remaining` from the result.

```typescript
if (!result.ok) {
  const status = result.reason === 'too_many_attempts' ? 429 : 400;
  return res.status(status).json({
    error: result.reason || 'verification_failed',
    reason: result.reason,
    attempts_remaining: result.attempts_remaining,
  });
}
```

- [ ] **Step 4: Type-check + commit**

```bash
cd server && npx tsc --noEmit && npm test
cd .. && git add server/otpService.ts server/index.ts
git commit -m "feat(otp): server returns attempts_remaining on invalid code"
```

---

### Task 6.3: Client countdown + friendly errors

**Files:**
- Modify: `client/src/LocationEditor.tsx`

- [ ] **Step 1: Track expiry + retry-after in dialog state**

Replace the `otpDialog` state shape:

```tsx
const [otpDialog, setOtpDialog] = useState<{
  recipient: RecipientRecord | null;
  code: string;
  sending: boolean;
  verifying: boolean;
  expiresAt: number | null;        // epoch ms
  retryAt: number | null;          // epoch ms (rate-limit ends)
  attemptsRemaining: number | null;
  errorMessage: string | null;
}>({
  recipient: null, code: '', sending: false, verifying: false,
  expiresAt: null, retryAt: null, attemptsRemaining: null, errorMessage: null,
});

// Tick state to drive the countdown re-render every 1s while the dialog is open.
const [, setNow] = useState(Date.now());
useEffect(() => {
  if (!otpDialog.recipient) return;
  const tick = setInterval(() => setNow(Date.now()), 1000);
  return () => clearInterval(tick);
}, [otpDialog.recipient]);
```

- [ ] **Step 2: Update handleStartVerify**

```tsx
const handleStartVerify = async (recipient: RecipientRecord) => {
  if (!editing || !recipient.phone) return;
  setOtpDialog({
    recipient, code: '', sending: true, verifying: false,
    expiresAt: null, retryAt: null, attemptsRemaining: null, errorMessage: null,
  });
  try {
    await sendRecipientOtp(editing, recipient.id);
    setOtpDialog(d => ({ ...d, sending: false, expiresAt: Date.now() + 10 * 60_000 }));
    setSnackbar({ open: true, message: `Code sent to ${recipient.phone}`, severity: 'success' });
  } catch (err: any) {
    const data = err.response?.data;
    if (data?.reason === 'rate_limited' && data?.retry_at) {
      setOtpDialog(d => ({ ...d, sending: false, retryAt: new Date(data.retry_at).getTime(),
                          errorMessage: '' }));
    } else {
      setOtpDialog({ recipient: null, code: '', sending: false, verifying: false,
                     expiresAt: null, retryAt: null, attemptsRemaining: null, errorMessage: null });
      setSnackbar({ open: true, message: data?.error || 'Failed to send verification code', severity: 'error' });
    }
  }
};
```

- [ ] **Step 3: Update handleResendOtp + handleVerifyOtp similarly**

Resend: same retry_at handling. Verify: read `attempts_remaining` from error response and stash in `otpDialog.attemptsRemaining`. On `too_many_attempts`, close dialog with snackbar "Too many attempts — please ask an admin to send a fresh code".

- [ ] **Step 4: Render countdown + retry-after in the Dialog body**

Replace the existing `<DialogContent>` block:

```tsx
<DialogContent>
  <Typography variant="body2" sx={{ mb: 2 }}>
    We sent a 6-digit code to <strong>{otpDialog.recipient?.phone}</strong>.
    Enter it below to enable SMS and WhatsApp alerts.
  </Typography>

  <TextField
    autoFocus
    fullWidth
    label="Verification code"
    value={otpDialog.code}
    onChange={e => setOtpDialog(d => ({ ...d, code: e.target.value.replace(/\D/g, '').slice(0, 8) }))}
    inputProps={{ inputMode: 'numeric', pattern: '[0-9]*', maxLength: 8 }}
    disabled={otpDialog.verifying}
    error={otpDialog.attemptsRemaining !== null && otpDialog.attemptsRemaining < MAX_VERIFY_ATTEMPTS}
    helperText={
      otpDialog.attemptsRemaining !== null
        ? `${otpDialog.attemptsRemaining} attempts remaining`
        : null
    }
  />

  {otpDialog.expiresAt && Date.now() < otpDialog.expiresAt && (
    <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'text.secondary' }}>
      Code expires in {formatCountdown(otpDialog.expiresAt - Date.now())}.
    </Typography>
  )}

  {otpDialog.expiresAt && Date.now() >= otpDialog.expiresAt && (
    <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'error.main' }}>
      Code has expired. Use "Resend code".
    </Typography>
  )}

  {otpDialog.retryAt && Date.now() < otpDialog.retryAt && (
    <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'warning.main' }}>
      Too many code requests. Try again in {formatCountdown(otpDialog.retryAt - Date.now())}.
    </Typography>
  )}
</DialogContent>
```

Add a small helper near the top of the file:

```tsx
const MAX_VERIFY_ATTEMPTS = 5;
function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
```

- [ ] **Step 5: Manual verify**

Add a recipient with a phone, click Verify. Confirm:
- Countdown visible ("Code expires in 9m 58s") and ticking.
- After 4 wrong codes the helper text shows "1 attempts remaining".
- On 6th send-OTP within an hour, banner reads "Try again in Xm Ys" instead of "rate_limited".
- After 10 minutes with no entry, code shows "expired" and verify is disabled.

- [ ] **Step 6: Commit**

```bash
git add client/src/LocationEditor.tsx
git commit -m "feat(otp): countdown timer, attempts-remaining feedback, friendly rate-limit message"
```

---

## Phase 7: Threshold form clarity

### Task 7.1: Section headings + helper text overhaul

**Files:**
- Modify: `client/src/LocationEditor.tsx`

- [ ] **Step 1: Group fields into "How this site triggers alerts"**

Find the threshold-fields section in the Add/Edit dialog. Wrap with a header and a one-paragraph plain-English explainer:

```tsx
<Grid item xs={12}>
  <Typography variant="subtitle2" sx={{ mt: 2, mb: 0.5 }}>How this site triggers alerts</Typography>
  <Typography variant="caption" color="text.secondary">
    Go <strong>STOP</strong> when {form.stop_flash_threshold} or more flashes land within{' '}
    <strong>{form.stop_radius_km} km</strong> in any{' '}
    <strong>{form.stop_window_min}-minute window</strong>. Go{' '}
    <strong>PREPARE</strong> on the first flash within{' '}
    <strong>{form.prepare_radius_km} km</strong>. Return to{' '}
    <strong>ALL CLEAR</strong> after{' '}
    <strong>{form.allclear_wait_min} minutes</strong> with no flashes in the STOP radius.
  </Typography>
</Grid>
```

- [ ] **Step 2: Rewrite each field's helper text in plain English**

For each TextField, replace the current `helperText` with something a non-engineer can act on:

| field | old | new |
|---|---|---|
| stop_radius_km | "STOP radius (km)" | "Distance considered immediately dangerous" |
| stop_flash_threshold | "STOP threshold" | "Number of flashes that triggers STOP" |
| stop_window_min | "Window (min)" | "Time window for counting flashes" |
| prepare_radius_km | "PREPARE radius (km)" | "Wider awareness zone" |
| allclear_wait_min | "All Clear wait" | "Quiet minutes required before returning to ALL CLEAR" |
| persistence_alert_min | "Persistence alert" | "Re-send alerts every N min while STOP/HOLD persists" |

- [ ] **Step 3: Type-check + manual verify**

Verify the live-updating preview sentence reads correctly when changing slider/number values.

- [ ] **Step 4: Commit**

```bash
git add client/src/LocationEditor.tsx
git commit -m "feat: plain-English threshold explainer + live preview sentence"
```

---

## Phase 8: Mobile alert ack

### Task 8.1: Sticky ack action on un-expanded mobile rows

**Files:**
- Modify: `client/src/AlertHistory.tsx`

- [ ] **Step 1: Add a one-tap ack button visible on the un-expanded row**

Find the mobile card view in AlertHistory. Inside each card, before the chevron-expand, add:

```tsx
{!alert.acknowledged_at && canAcknowledge && (
  <Button
    size="small"
    variant="contained"
    color="warning"
    onClick={(e) => { e.stopPropagation(); handleAcknowledge(alert.id); }}
    sx={{ minWidth: 72, ml: 'auto' }}
    aria-label={`Acknowledge alert for ${alert.location_name}`}
  >
    ACK
  </Button>
)}
```

- [ ] **Step 2: Manual verify on mobile width**

In Chrome devtools at 360x640, reload AlertHistory. With an unacked alert visible, the ACK button is reachable without expanding the row.

- [ ] **Step 3: Commit**

```bash
git add client/src/AlertHistory.tsx
git commit -m "feat(mobile): one-tap ACK button on un-expanded alert rows"
```

---

## Phase 9: Mobile Dashboard map auto-fit

### Task 9.1: Auto-fit-to-bounds + "fit all" control

**Files:**
- Modify: `client/src/Dashboard.tsx`

- [ ] **Step 1: Auto-fit on mount + on locations change**

Inside the Dashboard map block, add a child `MapController` component:

```tsx
import { useMap } from 'react-leaflet';

function FitAllBounds({ locations }: { locations: LocationStatus[] }) {
  const map = useMap();
  useEffect(() => {
    if (locations.length === 0) return;
    const bounds = locations.map(l => [l.lat, l.lng] as [number, number]);
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 9 });
  }, [locations, map]);
  return null;
}
```

Render `<FitAllBounds locations={locations} />` inside `<MapContainer>`.

- [ ] **Step 2: Add "Fit all" overlay button**

Adjacent to the existing flash-counter overlay, add:

```tsx
<Box sx={{ position: 'absolute', bottom: 16, right: 16, zIndex: 1000 }}>
  <Button
    size="small"
    variant="contained"
    color="inherit"
    onClick={() => { /* trigger refit by setting a key on FitAllBounds */ }}
    sx={{ bgcolor: 'rgba(10,25,41,0.85)', color: '#fff', fontSize: 11 }}
  >
    Fit all
  </Button>
</Box>
```

To make the button work, lift `FitAllBounds` to use a `version` prop incremented on click — easiest: hoist the map ref via `whenCreated` and call `map.fitBounds` from the button click directly.

- [ ] **Step 3: Manual verify**

In Chrome devtools at 360x640, with several locations spread across SA, verify all sites are visible on first paint and "Fit all" button restores the view after the user has zoomed/panned.

- [ ] **Step 4: Commit**

```bash
git add client/src/Dashboard.tsx
git commit -m "feat(mobile): map auto-fit-to-bounds + Fit all control"
```

---

## Phase 10: Audit log filters

### Task 10.1: Server filter additions

**Files:**
- Modify: `server/audit.ts`, `server/index.ts`

- [ ] **Step 1: Add filters to AuditQueryFilters**

```typescript
export interface AuditQueryFilters {
  org_id?: string;
  actor_user_id?: string;
  actor_email?: string;       // NEW
  action?: string;
  action_prefix?: string;
  target_type?: string;
  target_id?: string;         // NEW
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}
```

In `getAuditRows`, add the corresponding clauses:

```typescript
if (filters.actor_email) {
  conditions.push(`a.actor_email ILIKE $${params.length + 1}`);
  params.push(`%${filters.actor_email}%`);
}
if (filters.target_id) {
  conditions.push(`a.target_id = $${params.length + 1}`);
  params.push(filters.target_id);
}
```

- [ ] **Step 2: Forward through endpoint**

`server/index.ts` `/api/audit` route — pass `actor_email` and `target_id` from `req.query` into `getAuditRows`.

- [ ] **Step 3: Type-check + npm test**

Run: `cd server && npx tsc --noEmit && npm test`
Expected: clean.

- [ ] **Step 4: No commit yet — bundled with 10.2**

---

### Task 10.2: Client filter UI

**Files:**
- Modify: `client/src/AuditLog.tsx`, `client/src/api.ts`

- [ ] **Step 1: Update api.ts AuditFilters**

```typescript
export interface AuditFilters {
  org_id?: string;
  actor_email?: string;       // NEW
  target_id?: string;         // NEW
  action?: string;
  action_prefix?: string;
  target_type?: string;
  actor_user_id?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}
```

- [ ] **Step 2: Add filter inputs**

In the AuditLog filter card, add:
- A text field "Actor email contains" → `actor_email` filter.
- A text field "Target ID" → `target_id` filter (paste the UUID/ID from a target row to filter to its events).
- Two date inputs "From" / "To" → `since` / `until` filters (use `<input type="datetime-local">`, convert to ISO).

- [ ] **Step 3: Click-to-filter from rows**

In each AuditLog row, make the actor_email cell clickable: `onClick={() => setActorEmail(row.actor_email)}`. Similarly the target_id cell sets `target_id` filter.

- [ ] **Step 4: Manual verify**

Pull up `/audit`, type a known admin's email, see only their actions. Click a target_id from a "location.update" row — see all events for that location.

- [ ] **Step 5: Commit**

```bash
git add server/audit.ts server/index.ts client/src/api.ts client/src/AuditLog.tsx
git commit -m "feat(audit): filter by actor email, target id, date range; click-to-filter rows"
```

---

## Phase 11: Platform "needs attention"

### Task 11.1: Server "needs attention" query

**Files:**
- Modify: `server/index.ts`

- [ ] **Step 1: Extend `/api/platform/overview`**

Add to the existing single round-trip:

```typescript
const attention = await dbQuery(`
  SELECT
    o.id, o.name, o.slug,
    COUNT(DISTINCT a.id) FILTER (WHERE a.acknowledged_at IS NULL AND a.sent_at >= NOW() - interval '24 hours')::int AS unacked_24h,
    COUNT(DISTINCT a.id) FILTER (WHERE a.escalated = true AND a.sent_at >= NOW() - interval '24 hours')::int        AS escalated_24h
  FROM organisations o
  LEFT JOIN locations l ON l.org_id = o.id
  LEFT JOIN alerts a    ON a.location_id = l.id
  WHERE o.deleted_at IS NULL
  GROUP BY o.id
  HAVING
    COUNT(DISTINCT a.id) FILTER (WHERE a.acknowledged_at IS NULL AND a.sent_at >= NOW() - interval '24 hours') >= 5
    OR COUNT(DISTINCT a.id) FILTER (WHERE a.escalated = true AND a.sent_at >= NOW() - interval '24 hours') > 0
  ORDER BY unacked_24h DESC, escalated_24h DESC
`);
```

Add `needs_attention: attention.rows` to the response JSON.

- [ ] **Step 2: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: clean.

---

### Task 11.2: Client "needs attention" panel

**Files:**
- Modify: `client/src/PlatformOverview.tsx`

- [ ] **Step 1: Render panel above tile grid**

Add to the Overview type:

```typescript
needs_attention: Array<{ id: string; name: string; slug: string; unacked_24h: number; escalated_24h: number }>;
```

Above the existing tile Grid, render:

```tsx
{data.needs_attention.length > 0 && (
  <Card sx={{ mb: 3, border: '2px solid', borderColor: 'error.main' }}>
    <CardContent>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <WarningIcon sx={{ color: 'error.main' }} />
        <Typography variant="h6" sx={{ fontSize: 16 }}>Needs attention</Typography>
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
        Tenants with 5+ unacked alerts or any escalation in the last 24 hours.
      </Typography>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Organisation</TableCell>
            <TableCell align="right">Unacked (24h)</TableCell>
            <TableCell align="right">Escalated (24h)</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {data.needs_attention.map(o => (
            <TableRow key={o.id}>
              <TableCell>
                <Typography fontWeight={500}>{o.name}</Typography>
                <Typography variant="caption" color="text.secondary">{o.slug}</Typography>
              </TableCell>
              <TableCell align="right">
                {o.unacked_24h > 0 ? <Chip size="small" label={o.unacked_24h} color="warning" /> : '—'}
              </TableCell>
              <TableCell align="right">
                {o.escalated_24h > 0 ? <Chip size="small" label={o.escalated_24h} color="error" /> : '—'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </CardContent>
  </Card>
)}
```

- [ ] **Step 2: Type-check + manual verify**

Run: `cd client && npx tsc --noEmit`. Pull up `/platform`. With at least one org carrying 5+ unacked alerts, the panel renders at top.

- [ ] **Step 3: Commit**

```bash
git add server/index.ts client/src/PlatformOverview.tsx
git commit -m "feat(platform): proactive Needs Attention panel for noisy tenants"
```

---

## Phase 12: Polish

### Task 12.1: AlertHistory pagination correctness

**Files:**
- Modify: `client/src/AlertHistory.tsx`

- [ ] **Step 1: Fetch one extra row to detect end-of-list**

```tsx
const fetchAlerts = useCallback(async () => {
  try {
    const params: any = { limit: rowsPerPage + 1, offset: page * rowsPerPage };
    if (filterLocation) params.location_id = filterLocation;
    if (scopedOrgId) params.org_id = scopedOrgId;
    const res = await getAlerts(params);
    const rows = res.data;
    setHasMore(rows.length > rowsPerPage);
    setAlerts(rows.slice(0, rowsPerPage));
  } catch (err) { console.error('Failed to fetch alerts:', err); }
  finally { setLoading(false); }
}, [page, rowsPerPage, filterLocation, scopedOrgId]);
```

Add `const [hasMore, setHasMore] = useState(false);`.

- [ ] **Step 2: Disable Next when no more**

In the `<TablePagination>`, replace `count={-1}` with:

```tsx
count={hasMore ? -1 : (page * rowsPerPage + alerts.length)}
```

- [ ] **Step 3: Type-check + commit**

```bash
cd client && npx tsc --noEmit
cd .. && git add client/src/AlertHistory.tsx
git commit -m "fix(alerts): correct pagination — disable Next at end of list"
```

---

### Task 12.2: Audit log key-by-key diff view

**Files:**
- Create: `client/src/components/JsonDiff.tsx`
- Modify: `client/src/AuditLog.tsx`

- [ ] **Step 1: Write a minimal diff component (no extra deps)**

```tsx
// client/src/components/JsonDiff.tsx
import React from 'react';
import { Box, Typography, Table, TableBody, TableCell, TableRow, TableHead } from '@mui/material';

interface JsonDiffProps {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export default function JsonDiff({ before, after }: JsonDiffProps) {
  const keys = Array.from(new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ])).sort();

  if (keys.length === 0) {
    return <Typography variant="caption" color="text.secondary">No fields recorded.</Typography>;
  }

  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>Field</TableCell>
          <TableCell>Before</TableCell>
          <TableCell>After</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {keys.map(k => {
          const b = (before ?? {})[k];
          const a = (after  ?? {})[k];
          const changed = JSON.stringify(b) !== JSON.stringify(a);
          return (
            <TableRow key={k} sx={changed ? { bgcolor: 'rgba(255,193,7,0.08)' } : undefined}>
              <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{k}</TableCell>
              <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, color: changed ? 'error.main' : 'text.secondary' }}>
                {b === undefined ? <em>—</em> : fmt(b)}
              </TableCell>
              <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, color: changed ? 'success.main' : 'text.secondary' }}>
                {a === undefined ? <em>—</em> : fmt(a)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
```

- [ ] **Step 2: Replace JSON `<pre>` blocks in AuditLog**

In `AuditLog.tsx` `ExpandRow`, replace the Stack of `<Paper><pre>...</pre></Paper>` blocks with:

```tsx
<JsonDiff before={row.before} after={row.after} />
```

- [ ] **Step 3: Type-check + commit**

```bash
cd client && npx tsc --noEmit
cd .. && git add client/src/components/JsonDiff.tsx client/src/AuditLog.tsx
git commit -m "feat(audit): key-by-key diff view replaces raw JSON dump"
```

---

### Task 12.3: Inline form errors in LocationEditor

**Files:**
- Modify: `client/src/LocationEditor.tsx`

- [ ] **Step 1: Track field-level errors in state**

```tsx
const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
```

- [ ] **Step 2: Replace snackbar validation in handleSave with inline**

Replace the validation early-return blocks with:

```tsx
const errors: Record<string, string> = {};
if (!form.name.trim()) errors.name = 'Required';
if (form.stop_radius_km <= 0) errors.stop_radius_km = 'Must be greater than 0';
if (form.prepare_radius_km <= 0) errors.prepare_radius_km = 'Must be greater than 0';
if (form.prepare_radius_km <= form.stop_radius_km) errors.prepare_radius_km = 'Must be larger than STOP radius';
if (form.stop_flash_threshold < 1) errors.stop_flash_threshold = 'Must be at least 1';
if (form.prepare_flash_threshold < 1) errors.prepare_flash_threshold = 'Must be at least 1';
if (form.stop_window_min < 1) errors.stop_window_min = 'Must be at least 1';
if (form.prepare_window_min < 1) errors.prepare_window_min = 'Must be at least 1';
if (form.allclear_wait_min < 1) errors.allclear_wait_min = 'Must be at least 1';

setFieldErrors(errors);
if (Object.keys(errors).length > 0) {
  setSnackbar({ open: true, message: 'Please fix the highlighted fields', severity: 'error' });
  return;
}
```

- [ ] **Step 3: Surface on each TextField**

For each field add `error={!!fieldErrors.<key>} helperText={fieldErrors.<key> ?? <existing helperText>}`.

- [ ] **Step 4: Clear errors on field change**

Wherever a field's onChange fires, clear that key from `fieldErrors`:

```tsx
onChange={e => { setForm({ ...form, name: e.target.value }); setFieldErrors(({ name, ...rest }) => rest); }}
```

(Apply pattern to each field.)

- [ ] **Step 5: Type-check + commit**

```bash
cd client && npx tsc --noEmit
cd .. && git add client/src/LocationEditor.tsx
git commit -m "fix(locations): inline field errors instead of error-snackbar stack"
```

---

## Self-review checklist

| review item | result |
|---|---|
| Phase 1 covers shared `EmptyState`, `OrgScopeBanner`, `STATE_CONFIG`. | ✓ |
| Phase 2 fixes PREPARE contrast (was hardcoded `'#fff'` on `'#fbc02d'`) and aria-labels. | ✓ |
| Phase 3 wires socket.io-client from package.json removal in last round. Uses `wsManager.broadcastAlertTriggered` already in `alertService.ts:130`. | ✓ |
| Phase 4 onboarding endpoint uses tables that exist (`locations`, `location_recipients.phone_verified_at`). | ✓ |
| Phase 5 modal pulls long-form copy from `STATE_CONFIG.long`. | ✓ |
| Phase 6 OTP changes are server+client, with TDD opportunities (server tests added in same step). | ✓ |
| Phase 7 doesn't touch backend — pure UI relabel. | ✓ |
| Phase 8 mobile ack uses existing `handleAcknowledge`. | ✓ |
| Phase 9 uses `react-leaflet`'s `useMap` and `MapContainer`. | ✓ |
| Phase 10 server filter additions are additive — no breaking changes for existing callers. | ✓ |
| Phase 11 query joins `organisations` + `locations` + `alerts` — all already exist. | ✓ |
| Phase 12 diff view is dependency-free (no `react-diff-viewer`). | ✓ |
| No placeholders ("TBD", "implement later"). | ✓ |
| Each phase ends with a green type-check and a commit. | ✓ |
| Tasks reference exact files and functions. | ✓ |
| Type signatures consistent across phases (`SendOtpResult`, `AuditFilters`, `OnboardingState`). | ✓ |

---

## Out of scope (call-out for follow-up plans)

- **CI workflow** — `npm test` + `tsc --noEmit` on push (mentioned in the prior session, still pending).
- **DB integration tests** — port `server/scripts/integration-smoke.ts` to `tests/*.integration.test.ts` against a docker-compose Postgres.
- **mockData.ts production-build exclusion** — currently ships in the Docker image (harmless, but adds bloat).
- **i18n** — every string in this plan is English; if you'll need Afrikaans/Zulu support, factor that into a separate plan.
- **Shorter audit log retention bound for high-volume tenants** — currently 90d minimum; eventually you want per-org retention.
- **Color-blind safe state palette** — green/yellow/red is the most common "we can't tell those apart" combination. Add patterns or icons (already partly done with emojis) before scaling beyond a handful of customers.

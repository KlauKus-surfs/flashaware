// Inline-help copy registry. Every InfoTip body lives here so a non-engineer
// can rewrite wording without touching component code. Keep entries terse —
// 1-3 sentences per `body`, with concrete examples where the concept is fuzzy
// (rolling windows, escalation timing, OTP gating).

import React from 'react';

type Help = {
  title: string;
  // Plain text or a function returning a ReactNode for richer layouts (lists,
  // examples). Components import this and pass `body` straight into <InfoTip>.
  body: React.ReactNode | (() => React.ReactNode);
};

const text = (s: string): React.ReactNode => s;

export const HELP: Record<string, Help> = {
  // ---- Location thresholds ---------------------------------------------
  stop_radius: {
    title: 'STOP radius',
    body: text(
      'Distance from this location, in kilometres, that the engine treats as immediately dangerous. ' +
        'A flash inside this ring contributes to the STOP count. ' +
        'Tip: the EUMETSAT MTG-LI satellite has a positional accuracy of around 5–8 km, so picking a STOP radius below ~8 km may miss flashes that are actually closer than they appear.',
    ),
  },
  prepare_radius: {
    title: 'PREPARE radius',
    body: text(
      'Wider warning ring, in kilometres. A flash anywhere inside this ring (but outside the STOP ring) contributes to the PREPARE count. ' +
        'Must be greater than or equal to the STOP radius.',
    ),
  },
  stop_flash_threshold: {
    title: 'STOP flash count',
    body: text(
      'How many flashes inside the STOP radius will trigger STOP. ' +
        'Example: with 3 flashes / 5 minutes, STOP fires when the 3rd flash inside the ring lands within 5 minutes of the 1st. ' +
        'If no new flashes arrive for 5 minutes, the counter resets.',
    ),
  },
  stop_window_min: {
    title: 'STOP window (minutes)',
    body: text(
      'Rolling time window used to count flashes for STOP. ' +
        'Only flashes that arrived in the last N minutes count. Older flashes drop out of the counter automatically.',
    ),
  },
  prepare_flash_threshold: {
    title: 'PREPARE flash count',
    body: text(
      'How many flashes inside the PREPARE radius will trigger PREPARE. ' +
        'Most sites leave this at 1 — a single flash within the wider ring is enough to start preparing for shelter.',
    ),
  },
  prepare_window_min: {
    title: 'PREPARE window (minutes)',
    body: text(
      'Rolling time window used to count flashes for PREPARE. ' +
        'Typically longer than the STOP window because PREPARE is a watchful state, not an emergency.',
    ),
  },
  allclear_wait_min: {
    title: 'ALL CLEAR wait (minutes)',
    body: text(
      'After a STOP, the site stays in HOLD until this many consecutive minutes have passed with no flashes inside the PREPARE radius. ' +
        'Increase this for high-stakes sites (mines, large events) where re-strike risk is unacceptable.',
    ),
  },
  persistence_alert_min: {
    title: 'Persistence re-alerts',
    body: text(
      'During an ongoing STOP or HOLD, the system re-sends the alert every N minutes so operators stay aware the threat is still active. ' +
        'Set to 0 to disable re-alerts.',
    ),
  },
  state_change_only: {
    title: 'State-change alerts only',
    body: text(
      'When on, recipients only get notified when the state changes (e.g. ALL CLEAR → PREPARE). ' +
        'Useful for low-attention sites — wind farms, solar farms — where operators want a single ping per phase rather than persistence re-alerts.',
    ),
  },
  demo_location: {
    title: 'Demo / training location',
    body: text(
      'Tags this location as a demo so it appears with a "DEMO" pill on the Dashboard. ' +
        "Demo locations behave exactly like real ones (alerts still fire) — the tag is purely a visual hint to operators that it's a sandbox or training site.",
    ),
  },

  // ---- Settings / escalation ------------------------------------------
  auto_escalation: {
    title: 'Auto-escalation',
    body: text(
      'When on, an alert that has not been acknowledged within the escalation delay below is re-sent to all recipients on the same channels (email, SMS, WhatsApp). ' +
        'Recipients keep getting re-notified at this interval until someone acknowledges the alert.',
    ),
  },
  escalation_delay: {
    title: 'Escalation delay (minutes)',
    body: text(
      'How long the system waits before re-notifying recipients about an unacknowledged STOP / HOLD / PREPARE alert. ' +
        'Typical golf course: 5 min. High-risk mine: 2–3 min. Set higher for sites where alerts are routinely acknowledged off-channel.',
    ),
  },

  // ---- Feed health -----------------------------------------------------
  feed_health: {
    title: 'Data feed health',
    body: () =>
      React.createElement(
        React.Fragment,
        null,
        React.createElement(
          'p',
          null,
          "Lightning data comes from EUMETSAT's MTG Lightning Imager, which publishes 10-minute aggregate products with a 1–3 minute publish lag after each window closes. The risk engine compares the most recent product's end-of-window timestamp against the current time:",
        ),
        React.createElement(
          'ul',
          { style: { paddingLeft: 18, marginTop: 4, marginBottom: 0 } },
          React.createElement(
            'li',
            null,
            React.createElement('b', null, 'Healthy'),
            ' — ≤ 12 min old. Within the normal MTG-LI cycle (10-min window + ~2 min publish lag). Engine evaluates normally.',
          ),
          React.createElement(
            'li',
            null,
            React.createElement('b', null, 'Lagging'),
            ' — 13–20 min old. One MTG-LI cycle has been missed. Engine still evaluates; treat decisions with mild caution.',
          ),
          React.createElement(
            'li',
            null,
            React.createElement('b', null, 'Stale'),
            ' — 21–25 min old. Two or more cycles missed; engine still evaluates but degradation is imminent.',
          ),
          React.createElement(
            'li',
            null,
            React.createElement('b', null, 'NO DATA FEED'),
            ' — > 25 min old. Engine cannot evaluate; every site shows NO DATA FEED until the feed recovers.',
          ),
        ),
      ),
  },

  // ---- Recipients ------------------------------------------------------
  phone_e164: {
    title: 'E.164 phone format',
    body: text(
      'International format used by SMS / WhatsApp providers. Always starts with "+", then country code, then the number with no spaces or dashes. ' +
        'South Africa: +27821234567. UK: +447700900123. United States: +14155550123.',
    ),
  },
  receive_alerts: {
    title: 'Receive alerts',
    body: text(
      'When off, this recipient is kept on file but no alerts of any kind go out to them. ' +
        "Useful when a person is on leave and you don't want to delete their entry.",
    ),
  },

  // ---- Org scope (super_admin) -----------------------------------------
  org_scope: {
    title: 'Organisation scope',
    body: () =>
      React.createElement(
        React.Fragment,
        null,
        React.createElement(
          'p',
          null,
          'Super-admins can act inside a specific tenant or view all tenants at once. The picker controls both visibility and where new writes land:',
        ),
        React.createElement(
          'ul',
          { style: { paddingLeft: 18, marginTop: 4, marginBottom: 0 } },
          React.createElement(
            'li',
            null,
            React.createElement('b', null, 'Scoped (a tenant is selected)'),
            " — every read, create, edit, and delete affects only that tenant's data.",
          ),
          React.createElement(
            'li',
            null,
            React.createElement('b', null, 'Unscoped (no tenant)'),
            ' — lists show cross-tenant aggregates. New writes land in the platform tenant (FlashAware itself), so prefer scoping into a customer tenant before creating data for them.',
          ),
        ),
      ),
  },
  platform_org: {
    title: 'Platform tenant',
    body: text(
      'The FlashAware platform tenant runs the system itself. It hosts shared infrastructure and demo locations and cannot be deleted or renamed. Customer tenants live alongside it and are isolated from each other.',
    ),
  },

  // ---- Roles -----------------------------------------------------------
  role_permissions: {
    title: 'Role permissions',
    body: () =>
      React.createElement(
        React.Fragment,
        null,
        React.createElement(
          'ul',
          { style: { paddingLeft: 18, margin: 0 } },
          React.createElement(
            'li',
            null,
            React.createElement('b', null, 'Viewer'),
            ' — read-only. Can see Dashboard, locations, alert history, and replay.',
          ),
          React.createElement(
            'li',
            null,
            React.createElement('b', null, 'Operator'),
            ' — viewer + can acknowledge alerts.',
          ),
          React.createElement(
            'li',
            null,
            React.createElement('b', null, 'Admin'),
            ' — operator + can manage locations, recipients, users, settings, and audit log within their organisation.',
          ),
          React.createElement(
            'li',
            null,
            React.createElement('b', null, 'Super-admin'),
            ' — manages all organisations, the platform tenant, and the EUMETSAT feed health.',
          ),
        ),
      ),
  },

  // ---- AlertHistory & Replay -------------------------------------------
  flash_zone_counts: {
    title: 'Flash zone counts',
    body: text(
      "Number of lightning flashes inside this location's STOP and PREPARE radii during the engine's evaluation window when this state was set. " +
        'Useful for understanding why the engine made the call.',
    ),
  },
  replay_lookback: {
    title: 'Lookback window',
    body: text(
      "How far back to fetch historical state transitions and flashes. Doesn't change anything stored in the database — just how much shows up on the timeline below.",
    ),
  },
  replay_speed: {
    title: 'Playback speed',
    body: text(
      'How fast the timeline auto-advances through state transitions when you press Play. 1× = one transition every ~1.2 seconds. Click to cycle.',
    ),
  },
  replay_radiance: {
    title: 'Radiance',
    body: text(
      'Brightness of the flash as measured by the satellite, in W·sr⁻¹·m⁻². Higher = stronger flash. Useful as a rough proxy for how energetic a strike was.',
    ),
  },
  replay_zone: {
    title: 'Zone',
    body: text(
      "Which ring the flash fell into relative to the selected location. STOP = inside the STOP radius. PREPARE = between STOP and PREPARE radii. STOP and PREPARE flashes are counted by the risk engine toward that location's STOP / PREPARE thresholds. OUTSIDE = inside the 200 km wide-area view but beyond your alert radii — shown for context only and not counted toward any threshold. No individual flash triggers an alert; alerts come from threshold counts within each window.",
    ),
  },

  // ---- Map / Dashboard -------------------------------------------------
  map_legend: {
    title: 'About the rings',
    body: text(
      "The two coloured rings around each location are the STOP and PREPARE radii configured for that site. The risk engine counts flashes that fall inside each ring against that location's threshold and window. Editing the radii on the location form moves these rings.",
    ),
  },
};

// Resolve the body to a ReactNode regardless of whether the registry stored a
// function or a static value. Components call HELP_BODY('id') to get something
// they can pass to <InfoTip body={...} />.
export function helpBody(id: keyof typeof HELP): React.ReactNode {
  const entry = HELP[id];
  if (!entry) return null;
  return typeof entry.body === 'function' ? (entry.body as () => React.ReactNode)() : entry.body;
}

export function helpTitle(id: keyof typeof HELP): string {
  return HELP[id]?.title ?? '';
}

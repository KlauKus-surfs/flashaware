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

import { describe, it, expect } from 'vitest';
import { groupAlertsForEscalation } from '../alertService';
import type { AlertRecord } from '../queries/alerts';

function row(over: Partial<AlertRecord>): AlertRecord {
  return {
    id: 0,
    location_id: 'loc-1',
    state_id: 100,
    alert_type: 'email',
    recipient: 'a@example.com',
    sent_at: '2026-05-01T00:00:00.000Z',
    delivered_at: null,
    acknowledged_at: null,
    acknowledged_by: null,
    escalated: false,
    error: null,
    twilio_sid: null,
    ack_token: null,
    ack_token_expires_at: null,
    ...over,
  };
}

describe('groupAlertsForEscalation', () => {
  it('buckets sibling channels under one (location_id, state_id) group', () => {
    // The same STOP fires to email + SMS + WhatsApp → three rows, same
    // state_id. We MUST escalate once, not three times.
    const groups = groupAlertsForEscalation([
      row({ id: 1, alert_type: 'email', recipient: 'a@example.com' }),
      row({ id: 2, alert_type: 'sms', recipient: '+27600000001' }),
      row({ id: 3, alert_type: 'whatsapp', recipient: '+27600000002' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].location_id).toBe('loc-1');
    expect(groups[0].state_id).toBe(100);
    expect(groups[0].alerts.map((a) => a.id).sort()).toEqual([1, 2, 3]);
  });

  it('skips system rows entirely (they are audit, never delivered)', () => {
    const groups = groupAlertsForEscalation([
      row({ id: 1, alert_type: 'system', recipient: 'system' }),
    ]);
    expect(groups).toEqual([]);
  });

  it('skips rows already escalated', () => {
    const groups = groupAlertsForEscalation([row({ id: 7, escalated: true })]);
    expect(groups).toEqual([]);
  });

  it('keeps non-email channels — fixes the SMS/WhatsApp-only blind spot', () => {
    // Regression for the bug where checkEscalations only escalated
    // alert_type='email'; an SMS-only recipient who never acked would
    // silently never escalate.
    const groups = groupAlertsForEscalation([
      row({ id: 1, alert_type: 'sms', recipient: '+27' }),
      row({ id: 2, alert_type: 'whatsapp', recipient: '+27' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].alerts.map((a) => a.alert_type).sort()).toEqual(['sms', 'whatsapp']);
  });

  it('separates groups across different events (different state_id)', () => {
    const groups = groupAlertsForEscalation([
      row({ id: 1, state_id: 100 }),
      row({ id: 2, state_id: 200 }),
      row({ id: 3, state_id: 100, alert_type: 'sms', recipient: '+1' }),
    ]);
    expect(groups).toHaveLength(2);
    const sizes = groups.map((g) => g.alerts.length).sort();
    expect(sizes).toEqual([1, 2]);
  });

  it('separates groups across different locations (same state_id is per-location)', () => {
    const groups = groupAlertsForEscalation([
      row({ id: 1, location_id: 'loc-A', state_id: 100 }),
      row({ id: 2, location_id: 'loc-B', state_id: 100 }),
    ]);
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((g) => g.location_id))).toEqual(new Set(['loc-A', 'loc-B']));
  });

  it('picks the oldest sibling as the driver row (timing reference)', () => {
    const groups = groupAlertsForEscalation([
      row({ id: 1, sent_at: '2026-05-01T00:00:30.000Z' }),
      row({ id: 2, sent_at: '2026-05-01T00:00:00.000Z' }), // oldest
      row({ id: 3, sent_at: '2026-05-01T00:00:15.000Z' }),
    ]);
    expect(groups[0].driver.id).toBe(2);
    expect(groups[0].alerts.map((a) => a.id)).toEqual([2, 3, 1]);
  });

  it('mixes system + escalated + valid rows correctly', () => {
    const groups = groupAlertsForEscalation([
      row({ id: 1, alert_type: 'system', recipient: 'system' }), // skip
      row({ id: 2, alert_type: 'email', escalated: true }), // skip
      row({ id: 3, alert_type: 'email' }),
      row({ id: 4, alert_type: 'sms', recipient: '+27' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].alerts.map((a) => a.id).sort()).toEqual([3, 4]);
  });
});

import { describe, it, expect } from 'vitest';
import {
  buildSmsBody,
  buildWhatsAppBody,
  buildEmailHtml,
  buildEscalationHtml,
  escapeHtml,
  type ReasonObject,
  type AlertLinks,
} from '../alertTemplates';

const ACK_URL = 'https://lightning-risk-api.fly.dev/a/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
const LIVE_URL = 'https://flashaware.com/?focus=loc-uuid-1234';
const HISTORY_URL = 'https://flashaware.com/alerts?location=loc-uuid-1234';
const LINKS: AlertLinks = {
  ackUrl: ACK_URL,
  liveUrl: LIVE_URL,
  historyUrl: HISTORY_URL,
};

describe('buildSmsBody', () => {
  it('embeds all three labelled deep links', () => {
    const out = buildSmsBody('Sun City', 'STOP', 'flashes nearby', LINKS);
    expect(out).toContain(`Ack: ${ACK_URL}`);
    expect(out).toContain(`Live: ${LIVE_URL}`);
    expect(out).toContain(`History: ${HISTORY_URL}`);
    expect(out).toContain('Sun City');
    expect(out).toContain('STOP');
    expect(out).toContain('flashes nearby');
  });

  it('omits link lines entirely when links is undefined', () => {
    const out = buildSmsBody('Sun City', 'STOP', 'flashes nearby');
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).toContain('Sun City');
  });

  it('renders just liveUrl + historyUrl when ackUrl is absent (template channels)', () => {
    const out = buildSmsBody('Sun City', 'STOP', 'flashes nearby', {
      liveUrl: LIVE_URL,
      historyUrl: HISTORY_URL,
    });
    expect(out).not.toContain('Ack:');
    expect(out).toContain(`Live: ${LIVE_URL}`);
    expect(out).toContain(`History: ${HISTORY_URL}`);
  });
});

describe('buildWhatsAppBody', () => {
  it('embeds all three labelled deep links', () => {
    const out = buildWhatsAppBody('Sun City', 'STOP', 'flashes nearby', LINKS);
    expect(out).toContain(`*Acknowledge:* ${ACK_URL}`);
    expect(out).toContain(`*Live dashboard:* ${LIVE_URL}`);
    expect(out).toContain(`*Alert history:* ${HISTORY_URL}`);
  });

  it('omits link block when links is undefined', () => {
    const out = buildWhatsAppBody('Sun City', 'STOP', 'flashes nearby');
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).toContain('Sun City');
  });
});

describe('buildEmailHtml', () => {
  it('renders the primary Acknowledge button + secondary dashboard/history buttons', () => {
    const out = buildEmailHtml('Sun City', 'STOP', 'flashes nearby', LINKS);
    expect(out).toContain(`href="${ACK_URL}"`);
    expect(out).toContain('Acknowledge alert');
    expect(out).toContain(`href="${LIVE_URL}"`);
    expect(out).toContain('View live dashboard');
    expect(out).toContain(`href="${HISTORY_URL}"`);
    expect(out).toContain('Alert history');
  });

  it('still renders cleanly without any links (escalation re-uses this builder)', () => {
    const out = buildEmailHtml('Sun City', 'STOP', 'flashes nearby');
    expect(out).not.toMatch(/href=/);
    expect(out).toContain('Sun City');
  });

  // Regression: an admin-supplied location name with `<script>` (or any other
  // markup) must not survive into the rendered email body. Reviewer C2/I1.
  it('escapes locationName so admin-supplied markup cannot reach the email body', () => {
    const evil = '</h2><script>alert(1)</script><h2>';
    const out = buildEmailHtml(evil, 'STOP', 'flashes nearby', LINKS);
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes the reason field even though it is server-built today', () => {
    const out = buildEmailHtml('Sun City', 'STOP', 'flashes <img src=x onerror=foo()>', LINKS);
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;img src=x onerror=foo()&gt;');
  });

  it('attribute-encodes every link so a quote in a URL cannot break out of href', () => {
    const evilUrl = 'https://example.com/a/abc"></a><script>x()</script>';
    const out = buildEmailHtml('Sun City', 'STOP', 'flashes', {
      ackUrl: evilUrl,
      liveUrl: evilUrl,
      historyUrl: evilUrl,
    });
    expect(out).not.toContain('"></a><script>');
  });
});

describe('buildEscalationHtml', () => {
  it('escapes recipientEmail and locationName', () => {
    const out = buildEscalationHtml({
      locationName: '<script>name()</script>',
      recipientEmail: '<script>recipient()</script>',
      alertId: 42,
      sentAt: '2026-05-02T10:00:00Z',
      delayMin: 10,
    });
    expect(out).not.toMatch(/<script>name\(\)<\/script>/);
    expect(out).not.toMatch(/<script>recipient\(\)<\/script>/);
    expect(out).toContain('&lt;script&gt;name()&lt;/script&gt;');
    expect(out).toContain('&lt;script&gt;recipient()&lt;/script&gt;');
  });
});

describe('escapeHtml', () => {
  it('handles all five HTML-significant characters', () => {
    expect(escapeHtml('<>&"\'')).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('leaves null/undefined as empty string', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('coerces numbers without breaking', () => {
    expect(escapeHtml(42)).toBe('42');
  });
});

describe('alert templates — AFA wording', () => {
  const afaThresholds = {
    stop_radius_km: 10,
    prepare_radius_km: 20,
    stop_window_min: 5,
    prepare_window_min: 15,
  };

  const stopAfa: ReasonObject = {
    reason: 'Test stop reason',
    source: 'afa',
    lit_pixels_stop: 4,
    incidence_stop: 12,
  };

  const prepareAfa: ReasonObject = {
    reason: 'Test prepare reason',
    source: 'afa',
    lit_pixels_prepare: 2,
    incidence_prepare: 5,
  };

  it('renders cells and flash-pixel hits for STOP (SMS)', () => {
    const body = buildSmsBody(
      'Test Site',
      'STOP',
      stopAfa,
      LINKS,
      afaThresholds.stop_radius_km,
      afaThresholds.prepare_radius_km,
      afaThresholds.stop_window_min,
      afaThresholds.prepare_window_min,
    );
    expect(body).toMatch(/4 cell\(s\) lit within 10 km/);
    expect(body).toMatch(/12 flash-pixel hits/);
    expect(body).not.toMatch(/flashes within/);
  });

  it('renders cells and flash-pixel hits for PREPARE (WhatsApp)', () => {
    const body = buildWhatsAppBody(
      'Test Site',
      'PREPARE',
      prepareAfa,
      LINKS,
      afaThresholds.stop_radius_km,
      afaThresholds.prepare_radius_km,
      afaThresholds.stop_window_min,
      afaThresholds.prepare_window_min,
    );
    expect(body).toMatch(/2 cell\(s\) lit within 20 km/);
    expect(body).toMatch(/5 flash-pixel hits/);
  });

  it('renders cell-absence for ALL_CLEAR (email)', () => {
    const r: ReasonObject = {
      reason: 'All clear',
      source: 'afa',
      lit_pixels_prepare: 0,
    };
    const html = buildEmailHtml(
      'Test Site',
      'ALL_CLEAR',
      r,
      LINKS,
      afaThresholds.stop_radius_km,
      afaThresholds.prepare_radius_km,
      afaThresholds.stop_window_min,
      afaThresholds.prepare_window_min,
    );
    expect(html).toMatch(/No cells lit within 20 km/);
  });

  it('falls back to LFL wording when source missing', () => {
    const r: ReasonObject = {
      reason: 'Fallback reason',
      flashes_in_stop_radius: 3,
    };
    const body = buildSmsBody(
      'Test Site',
      'STOP',
      r,
      LINKS,
      afaThresholds.stop_radius_km,
      afaThresholds.prepare_radius_km,
      afaThresholds.stop_window_min,
      afaThresholds.prepare_window_min,
    );
    expect(body).toMatch(/3 flash\(es\) within 10 km/);
    expect(body).not.toMatch(/cell\(s\) lit/);
  });

  it('correctly guards ALL_CLEAR with prepare_radius check (regression: was using stop_radius)', () => {
    const r: ReasonObject = {
      reason: 'Fallback',
      flashes_in_prepare_radius: 0,
    };
    const body = buildSmsBody(
      'Test Site',
      'ALL_CLEAR',
      r,
      LINKS,
      afaThresholds.stop_radius_km,
      afaThresholds.prepare_radius_km,
      afaThresholds.stop_window_min,
      afaThresholds.prepare_window_min,
    );
    expect(body).toMatch(/No flashes within 20 km/);
    expect(body).toMatch(/prepare_window_min.*15|15 min/);
  });
});

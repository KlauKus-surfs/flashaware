import { describe, it, expect } from 'vitest';
import {
  buildSmsBody,
  buildWhatsAppBody,
  buildEmailHtml,
  buildEscalationHtml,
  escapeHtml,
} from '../alertTemplates';

const URL = 'https://lightning-risk-api.fly.dev/a/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';

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

  it('omits ack-link section when ackUrl is undefined', () => {
    const out = buildWhatsAppBody('Sun City', 'STOP', 'flashes nearby');
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).toContain('Sun City');
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
    expect(out).not.toMatch(/href=/);
    expect(out).toContain('Sun City');
  });

  // Regression: an admin-supplied location name with `<script>` (or any other
  // markup) must not survive into the rendered email body. Reviewer C2/I1.
  it('escapes locationName so admin-supplied markup cannot reach the email body', () => {
    const evil = '</h2><script>alert(1)</script><h2>';
    const out = buildEmailHtml(evil, 'STOP', 'flashes nearby', URL);
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes the reason field even though it is server-built today', () => {
    const out = buildEmailHtml('Sun City', 'STOP', 'flashes <img src=x onerror=foo()>', URL);
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;img src=x onerror=foo()&gt;');
  });

  it('attribute-encodes the ack URL so a quote in the token cannot break out of href', () => {
    const evilUrl = 'https://example.com/a/abc"></a><script>x()</script>';
    const out = buildEmailHtml('Sun City', 'STOP', 'flashes', evilUrl);
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

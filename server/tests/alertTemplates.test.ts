import { describe, it, expect } from 'vitest';
import { buildSmsBody, buildWhatsAppBody, buildEmailHtml } from '../alertTemplates';

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
});

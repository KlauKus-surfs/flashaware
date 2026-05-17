/* eslint-disable @typescript-eslint/no-require-imports */
// One-off: submit v2 WhatsApp templates with a "View location status" CTA
// button that deep-links to the live dashboard. Runs inside the Fly container
// (via `fly ssh console`) so TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN never leave
// the secret store. Prints a JSON summary of {state, sid, approval_status}
// for each template so we know what to put in TWILIO_WA_TEMPLATE_*_V2 secrets.

const https = require('https');

const AUTH =
  'Basic ' +
  Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString(
    'base64',
  );

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const r = https.request(
      {
        method,
        hostname: 'content.twilio.com',
        path,
        headers: {
          Authorization: AUTH,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(chunks) });
          } catch {
            resolve({ status: res.statusCode, body: chunks });
          }
        });
      },
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// Sample variable values Meta reviewers see — short, plausible, no PII.
const SAMPLE_REASON = {
  STOP: '3 flash(es) within 10 km in last 5 min',
  HOLD: 'Flashes still active in PREPARE radius',
  PREPARE: '1 flash(es) within 20 km in last 15 min',
  ALL_CLEAR: 'No flashes within 20 km in last 30 min',
  DEGRADED: 'Data feed delayed >20 min — risk cannot be evaluated',
};

const TEMPLATES = [
  {
    state: 'STOP',
    friendlyName: 'flashaware_stop_v2',
    body: '🔴 *FlashAware STOP*\n\n*{{1}}*\n\n{{2}}\n\nHalt outdoor work and shelter immediately.',
  },
  {
    state: 'HOLD',
    friendlyName: 'flashaware_hold_v2',
    body: '🟠 *FlashAware HOLD*\n\n*{{1}}*\n\n{{2}}\n\nSTOP cleared but threat persists — remain sheltered.',
  },
  {
    state: 'PREPARE',
    friendlyName: 'flashaware_prepare_v2',
    body: '🟡 *FlashAware PREPARE*\n\n*{{1}}*\n\n{{2}}\n\nHeightened risk — ready personnel for shelter.',
  },
  {
    state: 'ALL_CLEAR',
    friendlyName: 'flashaware_all_clear_v2',
    body: '🟢 *FlashAware ALL CLEAR*\n\n*{{1}}*\n\n{{2}}\n\nSafe to resume operations.',
  },
  {
    state: 'DEGRADED',
    friendlyName: 'flashaware_degraded_v2',
    body: '⚠️ *FlashAware NO DATA FEED*\n\n*{{1}}*\n\n{{2}}\n\nRisk cannot be determined. Treat outdoor activity as unsafe.',
  },
];

(async () => {
  const results = [];
  for (const t of TEMPLATES) {
    const create = await req('POST', '/v1/Content', {
      friendly_name: t.friendlyName,
      language: 'en',
      variables: {
        1: 'Sun City Golf Course',
        2: SAMPLE_REASON[t.state],
        3: '00000000-0000-0000-0000-000000000123',
      },
      types: {
        'twilio/call-to-action': {
          body: t.body,
          actions: [
            {
              type: 'URL',
              title: 'View location status',
              url: 'https://flashaware.com/?focus={{3}}',
            },
          ],
        },
      },
    });
    if (create.status >= 400) {
      results.push({ state: t.state, error: 'create_failed', detail: create.body });
      continue;
    }
    const sid = create.body.sid;
    const approve = await req('POST', `/v1/Content/${sid}/ApprovalRequests/whatsapp`, {
      name: t.friendlyName,
      category: 'UTILITY',
    });
    results.push({
      state: t.state,
      friendly_name: t.friendlyName,
      sid,
      approval_status: approve.status >= 400 ? 'submit_failed' : approve.body.status || 'submitted',
      approval_detail: approve.status >= 400 ? approve.body : undefined,
    });
  }
  console.log(JSON.stringify(results, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

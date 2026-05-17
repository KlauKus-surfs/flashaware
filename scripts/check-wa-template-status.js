/* eslint-disable @typescript-eslint/no-require-imports */
// One-off: poll the WhatsApp approval status for the v2 templates submitted
// by submit-wa-templates.js. Same fly-ssh invocation pattern so the Twilio
// creds never leave the secret store. Prints a JSON summary.
//
// Pass the SIDs as a single space-separated arg, e.g.:
//   echo HX18...,HX5a...,HXb... | base64 -w0 | ...  (via fly machine exec)

const https = require('https');

const SIDS = (process.env.WA_SIDS || '').split(/[,\s]+/).filter(Boolean);
if (SIDS.length === 0) {
  console.error('Set WA_SIDS env var with comma-separated content SIDs (HX...).');
  process.exit(2);
}

const AUTH =
  'Basic ' +
  Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString(
    'base64',
  );

function get(path) {
  return new Promise((resolve, reject) => {
    https
      .request(
        { method: 'GET', hostname: 'content.twilio.com', path, headers: { Authorization: AUTH } },
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
      )
      .on('error', reject)
      .end();
  });
}

(async () => {
  const results = [];
  for (const sid of SIDS) {
    const r = await get(`/v1/Content/${sid}/ApprovalRequests`);
    if (r.status >= 400) {
      results.push({ sid, error: r.body });
      continue;
    }
    // The list endpoint returns whatsapp + any other channels; filter to wa.
    const wa = r.body.whatsapp || r.body.approval_requests?.find?.((x) => x.channel === 'whatsapp');
    results.push({
      sid,
      friendly_name: wa?.name || wa?.friendly_name,
      status: wa?.status,
      category: wa?.category,
      rejection_reason: wa?.rejection_reason,
    });
  }
  console.log(JSON.stringify(results, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

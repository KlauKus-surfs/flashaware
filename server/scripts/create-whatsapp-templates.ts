/**
 * One-time setup script: create FlashAware WhatsApp Content Templates in Twilio
 * and submit them for WhatsApp business-initiated approval.
 *
 * Usage:
 *   npx ts-node scripts/create-whatsapp-templates.ts
 *
 * Requires in .env (or environment):
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
 *
 * On success it prints the SID for each template — add them to Fly secrets:
 *   fly secrets set -a lightning-risk-api \
 *     TWILIO_WA_TEMPLATE_STOP=HXxxx \
 *     TWILIO_WA_TEMPLATE_PREPARE=HXxxx \
 *     TWILIO_WA_TEMPLATE_HOLD=HXxxx \
 *     TWILIO_WA_TEMPLATE_ALL_CLEAR=HXxxx \
 *     TWILIO_WA_TEMPLATE_DEGRADED=HXxxx
 */

import twilio from 'twilio';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

if (!ACCOUNT_SID || !AUTH_TOKEN) {
  console.error('❌  TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set in .env');
  process.exit(1);
}

interface TemplateDefinition {
  envKey: string;
  friendlyName: string;
  body: string;
  exampleLocation: string;
  exampleDetail: string;
}

const TEMPLATES: TemplateDefinition[] = [
  {
    envKey: 'TWILIO_WA_TEMPLATE_STOP',
    friendlyName: 'flashaware_stop_alert',
    body: '🔴 FlashAware Alert\n\nLocation: {{1}}\nStatus: STOP — Shelter Immediately\n\n{{2}}\n\nThis is an automated alert from FlashAware Lightning Risk Management.',
    exampleLocation: 'Sun City Golf Course',
    exampleDetail: 'All outdoor activities must cease immediately.',
  },
  {
    envKey: 'TWILIO_WA_TEMPLATE_PREPARE',
    friendlyName: 'flashaware_prepare_alert',
    body: '🟡 FlashAware Alert\n\nLocation: {{1}}\nStatus: PREPARE — Heightened Risk\n\n{{2}}\n\nThis is an automated alert from FlashAware Lightning Risk Management.',
    exampleLocation: 'Sun City Golf Course',
    exampleDetail: 'Lightning detected within 20 km. Prepare to stop outdoor activities.',
  },
  {
    envKey: 'TWILIO_WA_TEMPLATE_HOLD',
    friendlyName: 'flashaware_hold_alert',
    body: '🟠 FlashAware Alert\n\nLocation: {{1}}\nStatus: HOLD — Remain Sheltered\n\n{{2}}\n\nThis is an automated alert from FlashAware Lightning Risk Management.',
    exampleLocation: 'Sun City Golf Course',
    exampleDetail: 'Lightning still within stop radius. Continue sheltering.',
  },
  {
    envKey: 'TWILIO_WA_TEMPLATE_ALL_CLEAR',
    friendlyName: 'flashaware_allclear_alert',
    body: '🟢 FlashAware Alert\n\nLocation: {{1}}\nStatus: ALL CLEAR — Safe to Resume\n\n{{2}}\n\nThis is an automated alert from FlashAware Lightning Risk Management.',
    exampleLocation: 'Sun City Golf Course',
    exampleDetail: 'No lightning detected for 30 minutes. Activities may resume.',
  },
  {
    envKey: 'TWILIO_WA_TEMPLATE_DEGRADED',
    friendlyName: 'flashaware_degraded_alert',
    body: '⚠️ FlashAware Alert\n\nLocation: {{1}}\nStatus: NO DATA FEED — Risk Cannot Be Determined\n\n{{2}}\n\nThis is an automated alert from FlashAware Lightning Risk Management.',
    exampleLocation: 'Sun City Golf Course',
    exampleDetail: 'Lightning data feed is unavailable. Exercise caution.',
  },
];

const client = twilio(ACCOUNT_SID, AUTH_TOKEN);

async function createTemplate(def: TemplateDefinition): Promise<string> {
  console.log(`\n📝  Creating template: ${def.friendlyName}`);

  const result = await (client.content.v1.contents as any).create({
    friendly_name: def.friendlyName,
    language: 'en',
    variables: { '1': def.exampleLocation, '2': def.exampleDetail },
    types: { 'twilio/text': { body: def.body } },
  });

  const sid: string = result.sid;
  console.log(`   ✅  Created  SID: ${sid}`);
  return sid;
}

async function submitForApproval(sid: string, friendlyName: string): Promise<void> {
  console.log(`   📨  Submitting ${friendlyName} for WhatsApp approval...`);
  try {
    await (client as any).request({
      method: 'POST',
      uri: `https://content.twilio.com/v1/Content/${sid}/ApprovalRequests`,
      data: { whatsapp: { category: 'UTILITY', allow_category_change: true } },
    });
    console.log(`   ✅  Approval request submitted`);
  } catch (err) {
    console.warn(
      `   ⚠️   Approval submission failed (you can submit manually in the Twilio console): ${(err as Error).message}`,
    );
  }
}

async function main() {
  console.log('🚀  FlashAware — Creating WhatsApp Content Templates\n');

  const results: { envKey: string; sid: string }[] = [];

  for (const def of TEMPLATES) {
    try {
      const sid = await createTemplate(def);
      await submitForApproval(sid, def.friendlyName);
      results.push({ envKey: def.envKey, sid });
    } catch (err) {
      console.error(`   ❌  Failed to create ${def.friendlyName}: ${(err as Error).message}`);
    }
  }

  if (results.length === 0) {
    console.error('\n❌  No templates were created.');
    process.exit(1);
  }

  console.log('\n\n✅  Done. Add these to your Fly.io secrets:\n');
  console.log('fly secrets set -a lightning-risk-api \\');
  results.forEach(({ envKey, sid }, i) => {
    const isLast = i === results.length - 1;
    console.log(`  ${envKey}="${sid}"${isLast ? '' : ' \\'}`);
  });

  console.log('\nOr add them to your .env file:');
  results.forEach(({ envKey, sid }) => {
    console.log(`${envKey}=${sid}`);
  });

  console.log('\n⏳  WhatsApp approval may take up to 24 hours.');
  console.log(
    '   Monitor status at: https://console.twilio.com/us1/develop/sms/content-template-builder',
  );
}

main();

// slack-actions.js
// Handles interactive button clicks from Slack Block Kit
// Receives POST from Slack when user clicks a button in any channel

const crypto = require('crypto');
const { sendSlackMessage, updateSlackMessage } = require('./slack-notify');

function verifySlackSignature(body, timestamp, signature, secret) {
  if (!secret) return true;
  const sigBase = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac('sha256', secret).update(sigBase).digest('hex');
  return `v0=${hmac}` === signature;
}

async function readBin() {
  const KEY = process.env.JSONBIN_API_KEY;
  const BIN = process.env.JSONBIN_BIN_ID;
  if (!KEY || !BIN) return {};
  const res = await fetch(`https://api.jsonbin.io/v3/b/${BIN}/latest`, { headers: { 'X-Master-Key': KEY } });
  const data = await res.json();
  return data.record || {};
}

async function writeBin(record) {
  const KEY = process.env.JSONBIN_API_KEY;
  const BIN = process.env.JSONBIN_BIN_ID;
  if (!KEY || !BIN) return;
  await fetch(`https://api.jsonbin.io/v3/b/${BIN}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': KEY },
    body: JSON.stringify(record)
  });
}

function normalisePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}

async function sendQuoSMS(phone, message) {
  const KEY = process.env.QUO_API_KEY;
  const PNID = process.env.QUO_PHONE_NUMBER_ID;
  if (!KEY || !PNID) return false;
  const res = await fetch('https://api.openphone.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': KEY },
    body: JSON.stringify({ to: [phone], from: PNID, content: message })
  });
  return res.ok;
}

function today() {
  return new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const body = event.body || '';
  const timestamp = event.headers['x-slack-request-timestamp'] || event.headers['X-Slack-Request-Timestamp'] || '';
  const signature = event.headers['x-slack-signature'] || event.headers['X-Slack-Signature'] || '';
  const secret = process.env.SLACK_SIGNING_SECRET;

  if (secret && !verifySlackSignature(body, timestamp, signature, secret)) {
    return { statusCode: 401, body: 'Invalid signature' };
  }

  // Slack sends payload as URL-encoded form data
  const params = new URLSearchParams(body);
  const payloadStr = params.get('payload');
  if (!payloadStr) return { statusCode: 400, body: 'No payload' };

  let payload;
  try { payload = JSON.parse(payloadStr); } catch(e) {
    return { statusCode: 400, body: 'Bad payload JSON' };
  }

  const action = payload.actions?.[0];
  if (!action) return { statusCode: 200, body: '' };

  const actionId = action.action_id;
  const responseUrl = payload.response_url;
  let contactData = {};
  try { contactData = JSON.parse(action.value || '{}'); } catch(e) {}

  const { contactId, phone, name } = contactData;
  const normalPhone = normalisePhone(phone);

  console.log('Slack action:', actionId, 'for', name, phone);

  // Read CRM data
  const record = await readBin();
  const sequences = record.sequences || {};
  const seq = normalPhone ? sequences[normalPhone] : null;

  let responseText = '';
  const actor = payload.user?.name || 'William';

  // ── HANDLE EACH BUTTON ────────────────────────────────────────────────────

  if (actionId === 'called_send_sequence') {
    // Log call touch in JSONbin
    if (!record.touches) record.touches = [];
    record.touches.push({
      touch: {
        id: `call-${Date.now()}`,
        date: today(),
        timestamp: new Date().toISOString(),
        channel: 'Call',
        direction: 'Outbound',
        by: actor,
        outcome: 'No response',
        note: `Pre-sequence call made via Slack action`,
        contactPhone: normalPhone
      }
    });

    // Release sequence — fire message 1 now
    if (seq) {
      const message = seq.pendingMessage || seq.messages?.[0];
      if (message && normalPhone) {
        const sent = await sendQuoSMS(normalPhone, message);
        if (sent) {
          seq.active = true;
          seq.lastSentAt = Date.now();
          seq.step = 1;
          seq.nextSendAt = Date.now() + 3 * 86400000;
          seq.pendingMessage = null;
          if (!seq.touches) seq.touches = [];
          seq.touches.push({ step: 1, sentAt: new Date().toISOString(), message, status: 'sent' });
          record.sequences = sequences;
        }
      }
    }

    await writeBin(record);
    responseText = `✅ *${actor}* called ${name} — sequence started`;

    // Post to sequences channel
    await sendSlackMessage(
      process.env.SLACK_CHANNEL_SEQUENCES,
      [{ type: 'section', text: { type: 'mrkdwn', text: `📤 Sequence started for *${name}* after pre-call by ${actor}` } }],
      `Sequence started for ${name}`
    );

  } else if (actionId === 'no_answer_send_sequence') {
    // Log attempted call
    if (!record.touches) record.touches = [];
    record.touches.push({
      touch: {
        id: `call-${Date.now()}`,
        date: today(),
        timestamp: new Date().toISOString(),
        channel: 'Call',
        direction: 'Outbound',
        by: actor,
        outcome: 'No response',
        note: `Pre-sequence call — no answer. Sequence released.`,
        contactPhone: normalPhone
      }
    });

    // Release sequence anyway
    if (seq) {
      const message = seq.pendingMessage || seq.messages?.[0];
      if (message && normalPhone) {
        const sent = await sendQuoSMS(normalPhone, message);
        if (sent) {
          seq.active = true;
          seq.lastSentAt = Date.now();
          seq.step = 1;
          seq.nextSendAt = Date.now() + 3 * 86400000;
          seq.pendingMessage = null;
          if (!seq.touches) seq.touches = [];
          seq.touches.push({ step: 1, sentAt: new Date().toISOString(), message, status: 'sent' });
          record.sequences = sequences;
        }
      }
    }

    await writeBin(record);
    responseText = `📵 *${actor}* tried calling ${name} — no answer — sequence released`;

  } else if (actionId === 'not_interested') {
    // Stop sequence, mark dead
    if (seq) {
      seq.active = false;
      seq.pausedReason = 'not_interested_pre_call';
      seq.pausedAt = new Date().toISOString();
      record.sequences = sequences;
    }

    await writeBin(record);
    responseText = `❌ *${actor}* marked ${name} as not interested — sequence cancelled`;

  } else if (actionId === 'called_back') {
    // Log callback touch
    if (!record.touches) record.touches = [];
    record.touches.push({
      touch: {
        id: `cb-${Date.now()}`,
        date: today(),
        timestamp: new Date().toISOString(),
        channel: 'Call',
        direction: 'Outbound',
        by: actor,
        outcome: 'Answered — not interested',
        note: `Called back hot lead via Slack action`,
        contactPhone: normalPhone
      }
    });
    await writeBin(record);
    responseText = `✅ *${actor}* called back ${name}`;

  } else if (actionId === 'no_answer_ai') {
    responseText = `📵 *${actor}* tried calling ${name} — no answer — AI handling conversation`;
  }

  // Update the original Slack message to show completed state
  if (responseUrl && responseText) {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        replace_original: true,
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: responseText }
          }
        ],
        text: responseText
      })
    });
  }

  return { statusCode: 200, body: '' };
};

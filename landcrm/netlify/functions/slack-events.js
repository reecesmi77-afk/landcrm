// slack-events.js
// Handles Slack Event Subscriptions
// Required: responds to URL verification challenge
// Also handles: message events (future use)

const crypto = require('crypto');

function verifySlackSignature(body, timestamp, signature, secret) {
  if (!secret) return true;
  const sigBase = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac('sha256', secret).update(sigBase).digest('hex');
  const expected = `v0=${hmac}`;
  return expected === signature;
}

exports.handler = async (event) => {
  const body = event.body || '';

  // Verify Slack signature
  const timestamp = event.headers['x-slack-request-timestamp'] || event.headers['X-Slack-Request-Timestamp'] || '';
  const signature = event.headers['x-slack-signature'] || event.headers['X-Slack-Signature'] || '';
  const secret = process.env.SLACK_SIGNING_SECRET;

  if (secret && !verifySlackSignature(body, timestamp, signature, secret)) {
    return { statusCode: 401, body: 'Invalid signature' };
  }

  let payload;
  try { payload = JSON.parse(body); } catch(e) {
    return { statusCode: 400, body: 'Bad JSON' };
  }

  // ── URL Verification Challenge (Slack sends this when you first set up Event Subscriptions)
  if (payload.type === 'url_verification') {
    console.log('Slack URL verification challenge received');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge: payload.challenge })
    };
  }

  // ── Event callback
  if (payload.type === 'event_callback') {
    const ev = payload.event;
    console.log('Slack event:', ev?.type, ev?.subtype);
    // Future: handle message events, reactions, etc.
    // For now just acknowledge
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};

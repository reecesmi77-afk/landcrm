// quo-webhook.js — Quo v3 payload + JSONbin storage
const crypto = require('crypto');

function verifySignature(body, signature, secret) {
  if (!secret || !signature) return true;
  const hmac = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return hmac === signature;
}

function normalisePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  if (digits.length > 7) return '+' + digits;
  return null;
}

function getOutcome(eventType, direction, duration) {
  if (eventType === 'message.received') return 'Replied';
  if (eventType === 'message.delivered') return 'No response';
  if (eventType === 'call.completed') return (!duration || duration < 10) ? 'No response' : direction === 'Inbound' ? 'Replied' : 'Answered — not interested';
  if (eventType === 'call.summary.completed') return 'Answered — not interested';
  return 'No response';
}

function buildNote(eventType, text, duration, summary) {
  if (eventType === 'message.received') return text ? `Inbound SMS: "${text.slice(0,150)}"` : 'Inbound SMS';
  if (eventType === 'message.delivered') return text ? `Outbound SMS: "${text.slice(0,150)}"` : 'Outbound SMS delivered';
  if (eventType === 'call.completed') { const d = duration ? `${Math.floor(duration/60)}m ${duration%60}s` : '?'; return `Call (${d})${summary ? ' — '+summary.slice(0,200) : ''}`; }
  if (eventType === 'call.summary.completed') return summary ? `AI summary: ${summary.slice(0,300)}` : 'Call summary';
  return eventType;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const secret = process.env.QUO_WEBHOOK_SECRET;
  const sig = event.headers['x-openphone-signature'] || event.headers['x-quo-signature'] || '';
  if (!verifySignature(event.body, sig, secret)) return { statusCode: 401, body: 'Unauthorized' };

  let payload;
  try { payload = JSON.parse(event.body); } catch (e) { return { statusCode: 400, body: 'Bad JSON' }; }

  // Quo v3: { type, data: { object: {...} } }
  const eventType = payload.type;
  const obj = payload.data?.object || payload.data || {};

  console.log('Quo event:', eventType, JSON.stringify(obj).slice(0,300));

  let contactPhone = null, messageText = null, direction = 'Outbound', duration = null, summary = null;

  if (eventType === 'message.received') {
    direction = 'Inbound';
    contactPhone = normalisePhone(obj.from);
    messageText = obj.text || obj.content || '';
    // Trigger AI SMS responder for inbound messages
    if (contactPhone && messageText) {
      try {
        const aiUrl = (process.env.URL || 'https://dealflow-crm.netlify.app') + '/.netlify/functions/ai-sms-responder';
        fetch(aiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: contactPhone, message: messageText })
        }).then(r => r.json()).then(d => {
          console.log('AI responder result:', JSON.stringify(d).slice(0, 200));
        }).catch(e => {
          console.error('AI responder error:', e.message);
        });
      } catch (e) {
        console.error('AI trigger error:', e.message);
      }
    }
  } else if (eventType === 'message.delivered') {
    direction = 'Outbound';
    contactPhone = normalisePhone(Array.isArray(obj.to) ? obj.to[0] : obj.to);
    messageText = obj.text || obj.content || '';
  } else if (eventType === 'call.completed' || eventType === 'call.summary.completed') {
    direction = obj.direction === 'incoming' ? 'Inbound' : 'Outbound';
    contactPhone = direction === 'Inbound'
      ? normalisePhone(obj.from)
      : normalisePhone(Array.isArray(obj.to) ? obj.to[0] : obj.to);
    duration = obj.duration;
    summary = obj.summary || null;
  }

  if (!contactPhone) {
    console.log('No external phone. from:', obj.from, 'to:', obj.to);
    return { statusCode: 200, body: JSON.stringify({ ok: true, msg: 'no contact phone' }) };
  }

  const touch = {
    id: obj.id || `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    quoEventType: eventType,
    date: new Date().toISOString().slice(0,10),
    timestamp: new Date().toISOString(),
    channel: eventType.startsWith('message') ? 'SMS' : 'Call',
    direction, by: 'AI',
    outcome: getOutcome(eventType, direction, duration),
    note: buildNote(eventType, messageText, duration, summary),
    contactPhone,
  };

  const needsHandoff = eventType === 'message.received' || (eventType === 'call.completed' && direction === 'Inbound');

  const KEY = process.env.JSONBIN_API_KEY;
  const BIN = process.env.JSONBIN_BIN_ID;

  if (!KEY || !BIN) {
    console.log('JSONbin not configured');
    return { statusCode: 200, body: JSON.stringify({ ok: true, touch, needsHandoff, stored: false }) };
  }

  try {
    const readRes = await fetch(`https://api.jsonbin.io/v3/b/${BIN}/latest`, { headers: { 'X-Master-Key': KEY } });
    const readData = await readRes.json();
    const current = readData.record || { touches: [] };
    current.touches = (current.touches || []);
    current.touches.push({ touch, needsHandoff });
    if (current.touches.length > 200) current.touches = current.touches.slice(-200);
    await fetch(`https://api.jsonbin.io/v3/b/${BIN}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': KEY },
      body: JSON.stringify(current)
    });
    console.log(`Stored for ${contactPhone}: ${eventType}`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, stored: true, contactPhone, event: eventType }) };
  } catch (err) {
    console.error('JSONbin error:', err.message);
    return { statusCode: 200, body: JSON.stringify({ ok: true, touch, needsHandoff, stored: false, error: err.message }) };
  }
};

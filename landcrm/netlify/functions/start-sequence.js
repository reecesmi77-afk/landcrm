// start-sequence.js
// Called when a contact is added/saved with source = "Lead Gen Agency"
// Sends immediate first touch and stores sequence state in JSONbin

function normalisePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}

function isBizHours() {
  const now = new Date();
  const ct = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const hour = ct.getHours();
  const day = ct.getDay(); // 0=Sun, 6=Sat
  return day >= 1 && day <= 5 && hour >= 9 && hour < 18;
}

function nextBizTime() {
  const now = new Date();
  const ct = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const day = ct.getDay();
  const hour = ct.getHours();

  // If before 8am today, send at 8am today
  if (hour < 9 && day >= 1 && day <= 5) {
    ct.setHours(9, 0, 0, 0);
    return ct.getTime();
  }

  // If after 6pm or weekend, find next business day at 9am
  ct.setDate(ct.getDate() + 1);
  while (ct.getDay() === 0 || ct.getDay() === 6) {
    ct.setDate(ct.getDate() + 1);
  }
  ct.setHours(9, 0, 0, 0);
  return ct.getTime();
}

async function sendQuoSMS(toPhone, message) {
  const QUO_KEY = process.env.QUO_API_KEY;
  const QUO_PNID = process.env.QUO_PHONE_NUMBER_ID;
  if (!QUO_KEY || !QUO_PNID) {
    console.log('Quo not configured. Would send:', message);
    return false;
  }
  const res = await fetch('https://api.openphone.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': QUO_KEY },
    body: JSON.stringify({ to: [toPhone], from: QUO_PNID, content: message })
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('Quo SMS error:', res.status, err.slice(0, 200));
    return false;
  }
  console.log('SMS sent to', toPhone, ':', message.slice(0, 80));
  return true;
}

function buildFirstText(contact) {
  const county = contact.county || 'your area';
  const acreage = contact.acreage ? `${contact.acreage}-acre ` : '';
  const state = contact.state || '';
  const location = state ? `${county}, ${state}` : county;

  // Vary openers — rotate based on timestamp to avoid repetition
  const openers = [
    `Saw you have some ${acreage}land in ${county} — did you ever think about selling?`,
    `Quick question about your ${acreage}land in ${location} — is that something you'd consider selling?`,
    `Noticed you own ${acreage}land in ${county} — have you thought about what it might be worth?`,
    `Had your ${acreage}land in ${county} on our radar — ever thought about selling?`,
    `We buy land in ${county} and noticed yours — worth a quick chat?`,
  ];

  const idx = Math.floor(Date.now() / 10000) % openers.length;
  return openers[idx];
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  let body;
  try { body = JSON.parse(event.body); } catch(e) { return { statusCode: 400, body: 'Bad JSON' }; }

  const { contact, immediate } = body;
  if (!contact || !contact.phone) {
    return { statusCode: 400, body: JSON.stringify({ error: 'contact and phone required' }) };
  }

  const phone = normalisePhone(contact.phone);
  if (!phone) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid phone number' }) };
  }

  const KEY = process.env.JSONBIN_API_KEY;
  const BIN = process.env.JSONBIN_BIN_ID;

  if (!KEY || !BIN) {
    return { statusCode: 500, body: JSON.stringify({ error: 'JSONbin not configured' }) };
  }

  // Read current bin
  const readRes = await fetch(`https://api.jsonbin.io/v3/b/${BIN}/latest`, {
    headers: { 'X-Master-Key': KEY }
  });
  const readData = await readRes.json();
  const record = readData.record || {};

  // Check if this contact already has an active sequence
  const sequences = record.sequences || {};
  if (sequences[phone] && sequences[phone].active) {
    console.log('Sequence already active for:', phone);
    return { statusCode: 200, body: JSON.stringify({ ok: true, msg: 'sequence already active' }) };
  }

  // Check if they've already replied (conversation exists)
  const conversations = record.conversations || {};
  if (conversations[phone] && conversations[phone].messages && conversations[phone].messages.length > 0) {
    console.log('Conversation already started for:', phone);
    return { statusCode: 200, body: JSON.stringify({ ok: true, msg: 'conversation already active' }) };
  }

  const firstText = buildFirstText(contact);
  let sent = false;

  // Send immediately if within business hours, otherwise queue
  if (isBizHours()) {
    sent = await sendQuoSMS(phone, firstText);
  } else {
    console.log('Outside business hours — queuing for next biz morning');
  }

  // Store sequence state
  sequences[phone] = {
    active: true,
    contactName: contact.name,
    county: contact.county,
    state: contact.state,
    acreage: contact.acreage,
    phone,
    startedAt: new Date().toISOString(),
    step: 1,
    lastSentAt: sent ? Date.now() : null,
    nextSendAt: sent ? null : nextBizTime(),
    pendingMessage: sent ? null : firstText,
    touches: sent ? [{
      step: 1, type: 'text', sentAt: new Date().toISOString(),
      message: firstText, status: 'sent'
    }] : [{
      step: 1, type: 'text', scheduledFor: new Date(nextBizTime()).toISOString(),
      message: firstText, status: 'queued'
    }]
  };

  record.sequences = sequences;

  // Write back
  await fetch(`https://api.jsonbin.io/v3/b/${BIN}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': KEY },
    body: JSON.stringify(record)
  });

  console.log(`Sequence started for ${contact.name} (${phone}) — step 1 ${sent ? 'sent' : 'queued'}`);

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      phone,
      step: 1,
      sent,
      message: firstText,
      scheduledFor: sent ? null : new Date(nextBizTime()).toISOString()
    })
  };
};

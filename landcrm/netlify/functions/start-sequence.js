// start-sequence.js
// Fires when a Lead Gen contact is added
// Sends Message 1 immediately (or queues) and stores full sequence in JSONbin

const { sendSlackMessage, buildActionListCard } = require('./slack-notify');

function normalisePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}

function isBizHours() {
  const ct = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const h = ct.getHours(), d = ct.getDay();
  return d >= 1 && d <= 5 && h >= 9 && h < 18;
}

function nextBizTimestamp() {
  const ct = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const h = ct.getHours(), d = ct.getDay();
  if (h < 9 && d >= 1 && d <= 5) { ct.setHours(9, 0, 0, 0); return ct.getTime(); }
  ct.setDate(ct.getDate() + 1);
  while (ct.getDay() === 0 || ct.getDay() === 6) ct.setDate(ct.getDate() + 1);
  ct.setHours(9, 15, 0, 0); // 9:15am — not exactly on the hour
  return ct.getTime();
}

function spin(variants) {
  const opts = variants.split('|');
  return opts[Math.floor(Math.random() * opts.length)];
}

// Calculate days since lead was received
function daysSinceReceived(leadReceived) {
  if (!leadReceived) return 0;
  return Math.floor((Date.now() - new Date(leadReceived).getTime()) / 86400000);
}

// Time-aware opener based on how long ago lead was received
function getOpener(contact) {
  const days = daysSinceReceived(contact.leadReceived);
  const first = contact.name ? contact.name.split(' ')[0] : null;
  const county = contact.county || 'your area';
  const co = contact.leadGenCompany || 'our team';
  const greeting = first ? `Hi ${first}` : 'Hi';

  if (days <= 1) {
    return `${greeting}, someone from ${co} reached out to you earlier today about your land in ${county}. That was us.`;
  } else if (days <= 3) {
    return `${greeting}, earlier this week ${co} reached out about your land in ${county}.`;
  } else if (days <= 7) {
    return `${greeting}, you may have heard from ${co} recently about your land in ${county}.`;
  } else {
    return `${greeting}, you may remember getting a message a little while back about your land in ${county}.`;
  }
}

// Build all 5 sequence messages + alt + re-engage
function buildSequenceMessages(contact) {
  const first = contact.name ? contact.name.split(' ')[0] : null;
  const county = contact.county || null;
  const acres = contact.acreage || null;
  const opener = getOpener(contact);
  const opt = ' Reply STOP to opt out.';

  const msgs = [
    // Step 1 — warm intro
    opener + ` I\'m William with Coldwater Property Group — the one who can ${spin('close this|get you a number|make this happen')}. Still ${spin('open to|willing to consider|interested in')} a ${spin('quick chat|brief call|conversation')}?` + opt,

    // Step 2 — value prop
    `${first || 'Hey'}, just ${spin('following up|circling back|checking in')} on my last message about your ${spin('land|acreage|parcel')}${county ? ` in ${county}` : ''}. We ${spin('close fast|move quickly|make it simple')} — ${spin('all cash, no fees|we cover all closing costs|no agent commissions needed')}. Worth a ${spin('quick call|5 minutes|brief chat')}?` + opt,

    // Step 3 — social proof / process
    `Hi ${first || 'there'}, William again from Coldwater Property Group. We ${spin('close in as little as|can wrap this up in|have buyers ready in')} 2-3 weeks and handle all the ${spin('paperwork|details|closing costs')}. If you\'re ${spin('thinking about|open to|considering')} ${spin('parting with|doing something with|moving')} that ${spin('land|acreage|parcel')}${county ? ` in ${county}` : ''}, let\'s talk.` + opt,

    // Step 4 — direct, no fluff
    `${first || 'Hey'}, I won\'t keep ${spin('reaching out|following up|messaging')} forever. If the timing\'s ever right to ${spin('discuss|talk about|explore')} your ${acres ? `${acres}-acre ` : ''}${spin('land|parcel|acreage')}${county ? ` in ${county}` : ''}, I\'m just a text away. — William, Coldwater Property Group.` + opt,

    // Step 5 — soft breakup
    `Last message from me, ${first || 'friend'}. If you ever want a fast, ${spin('fair|simple|hassle-free')} way to ${spin('part with|do something with|move on from')} that ${spin('land|property|acreage')}${county ? ` in ${county}` : ''}, reach out anytime. No pressure — take care. — William, Coldwater.` + opt,
  ];

  // Alt message — missing name or county
  const alt = `Hi — you may have recently heard from us about some ${spin('vacant|raw|undeveloped')} land you own. I\'m William with Coldwater Property Group. We ${spin('close fast|move quickly|work with any situation')} — ${spin('all cash, no fees|we cover all costs|no agent needed')}. ${spin('Open to a quick chat?|Want to discuss?|Still interested?')}` + opt;

  // 30-day re-engage
  const reEngage = `Hi ${first || 'there'}, I know I reached out about a month ago regarding your ${spin('land|acreage|parcel')}${county ? ` in ${county}` : ''}. Still have strong interest if the timing is ever right. No pressure — just wanted to stay on your radar. — William, Coldwater Property Group.` + opt;

  return { msgs, alt, reEngage };
}

async function sendQuoSMS(phone, message) {
  const KEY = process.env.QUO_API_KEY;
  const PNID = process.env.QUO_PHONE_NUMBER_ID;
  if (!KEY || !PNID) { console.log('[DRY RUN] Would send to', phone, ':', message.slice(0, 80)); return false; }
  const res = await fetch('https://api.openphone.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': KEY },
    body: JSON.stringify({ to: [phone], from: PNID, content: message })
  });
  if (!res.ok) { console.error('Quo error:', res.status, (await res.text()).slice(0, 200)); return false; }
  return true;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  let body;
  try { body = JSON.parse(event.body); } catch(e) { return { statusCode: 400, body: 'Bad JSON' }; }

  const { contact } = body;
  if (!contact || !contact.phone) return { statusCode: 400, body: JSON.stringify({ error: 'contact.phone required' }) };

  const phone = normalisePhone(contact.phone);
  if (!phone) return { statusCode: 400, body: JSON.stringify({ error: 'invalid phone' }) };

  const KEY = process.env.JSONBIN_API_KEY;
  const BIN = process.env.JSONBIN_BIN_ID;
  if (!KEY || !BIN) return { statusCode: 500, body: JSON.stringify({ error: 'JSONbin not configured' }) };

  // Read bin
  const readRes = await fetch(`https://api.jsonbin.io/v3/b/${BIN}/latest`, { headers: { 'X-Master-Key': KEY } });
  const readData = await readRes.json();
  const record = readData.record || {};
  const sequences = record.sequences || {};
  const conversations = record.conversations || {};

  // Don't start if already active or already replied
  if (sequences[phone]?.active) return { statusCode: 200, body: JSON.stringify({ ok: true, msg: 'already active' }) };
  if (conversations[phone]?.messages?.length > 0) return { statusCode: 200, body: JSON.stringify({ ok: true, msg: 'conversation exists' }) };

  const { msgs, alt, reEngage } = buildSequenceMessages(contact);
  const hasData = contact.name && contact.county;
  const message = hasData ? msgs[0] : alt;

  const inBizHours = isBizHours();
  const sent = inBizHours ? await sendQuoSMS(phone, message) : false;
  const scheduledFor = inBizHours ? null : new Date(nextBizTimestamp()).toISOString();

  // Store full sequence state
  sequences[phone] = {
    active: true,
    paused: false,
    contactId: contact.id || null,
    contactName: contact.name || null,
    phone,
    county: contact.county || null,
    state: contact.state || null,
    acreage: contact.acreage || null,
    leadGenCompany: contact.leadGenCompany || null,
    leadReceived: contact.leadReceived || new Date().toISOString(),
    startedAt: new Date().toISOString(),
    step: 1,
    totalSteps: msgs.length,
    lastSentAt: sent ? Date.now() : null,
    nextSendAt: sent ? (Date.now() + 3 * 86400000) : nextBizTimestamp(), // 3 days after step 1
    pendingMessage: sent ? null : message,
    messages: msgs,
    altMessage: alt,
    reEngageMessage: reEngage,
    touches: [{
      step: 1,
      sentAt: sent ? new Date().toISOString() : null,
      scheduledFor: scheduledFor,
      message,
      status: sent ? 'sent' : 'queued'
    }]
  };

  record.sequences = sequences;

  await fetch(`https://api.jsonbin.io/v3/b/${BIN}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': KEY },
    body: JSON.stringify(record)
  });

  console.log(`Sequence started for ${contact.name} (${phone}) step 1 ${sent ? 'sent' : `queued for ${scheduledFor}`}`);

  // POST TO SLACK #action-list — call before texting card
  const ACTION_CH = process.env.SLACK_CHANNEL_ACTION;
  if (ACTION_CH) {
    try {
      const autoFireAt = Date.now() + (4 * 60 * 60 * 1000); // 4hr window
      const blocks = buildActionListCard(contact, autoFireAt);
      const slackTs = await sendSlackMessage(ACTION_CH, blocks, `📞 Call before texting: ${contact.name || phone}`);
      if (slackTs && sequences[phone]) {
        sequences[phone].slackActionTs = slackTs;
        sequences[phone].callWindowEndsAt = autoFireAt;
        record.sequences = sequences;
        await fetch(`https://api.jsonbin.io/v3/b/${BIN}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-Master-Key': KEY },
          body: JSON.stringify(record)
        });
      }
    } catch(slackErr) { console.error('Slack error:', slackErr.message); }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, phone, step: 1, sent, scheduledFor, message })
  };
};

// Note: Slack notification is injected by the module require above
// The buildActionListCard and sendSlackMessage are available via slack-notify

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
  ct.setHours(9, 15, 0, 0);
  return ct.getTime();
}

function spin(variants) {
  const opts = variants.split('|');
  return opts[Math.floor(Math.random() * opts.length)];
}

function daysSinceReceived(leadReceived) {
  if (!leadReceived) return 0;
  return Math.floor((Date.now() - new Date(leadReceived).getTime()) / 86400000);
}

function getOpener(contact) {
  const days = daysSinceReceived(contact.leadReceived);
  const first = contact.name ? contact.name.split(' ')[0] : null;
  const county = contact.county ? contact.county + ' County' : 'your area';
  const co = contact.leadGenCompany || 'our team';
  const greeting = first ? `Hi ${first}` : 'Hi';

  if (days <= 1) {
    return `${greeting}, someone from ${co} reached out to you earlier today about your land in ${county} — that was us.`;
  } else if (days <= 3) {
    return `${greeting}, earlier this week ${co} reached out about your land in ${county} —`;
  } else if (days <= 7) {
    return `${greeting}, you may have heard from ${co} recently about your land in ${county} —`;
  } else {
    return `${greeting}, you may remember getting a message a little while back about your land in ${county} —`;
  }
}

function buildSequenceMessages(contact) {
  const first = contact.name ? contact.name.split(' ')[0] : null;
  const county = contact.county ? contact.county + ' County' : null;
  const acres = contact.acreage || null;
  const opener = getOpener(contact);
  const opt = ' Reply STOP to opt out.';

  const msgs = [
    // Step 1 — warm intro, assumptive, no name drop, no sales language
    opener + ` we ${spin('work with landowners|help landowners|partner with owners')} in that area and would love to ${spin('connect|chat|talk')}. Do you have a few minutes for a quick call?` + opt,

    // Step 2 — follow up, value focused
    `${first || 'Hey'}, just ${spin('following up|circling back|checking in')} on our message about your ${spin('land|acreage|parcel')}${county ? ` in ${county}` : ''}. We ${spin('close fast and cover all costs|handle everything with no fees|keep it simple — no agent needed')}. Do you have a few minutes to ${spin('connect|chat|talk')}?` + opt,

    // Step 3 — process focused
    `${first || 'Hi'}, Coldwater Property Group here. We ${spin('close in as little as|can wrap things up in|typically move in')} 2-3 weeks and handle all the ${spin('paperwork|details|closing')} — no ${spin('fees|commissions|costs')} to you. If you are ${spin('open to|thinking about|considering')} ${spin('parting with|doing something with|moving on from')} that ${spin('land|acreage|parcel')}${county ? ` in ${county}` : ''}, we would love to talk.` + opt,

    // Step 4 — direct, low pressure
    `${first || 'Hey'}, we will not ${spin('keep reaching out|follow up|message you')} much longer. If the timing is ever right on your ${acres ? `${acres}-acre ` : ''}${spin('land|parcel|acreage')}${county ? ` in ${county}` : ''}, we are just a text away. — Coldwater Property Group` + opt,

    // Step 5 — soft breakup
    `Last message from us${first ? `, ${first}` : ''}. If you ever want a ${spin('fast|simple|hassle-free')} way to ${spin('part with|do something with|move on from')} that ${spin('land|acreage|parcel')}${county ? ` in ${county}` : ''}, reach out anytime. No pressure — take care. — Coldwater Property Group` + opt,
  ];

  const alt = `Hi — you may have recently heard from us about some ${spin('vacant|raw|undeveloped')} land you own. We are Coldwater Property Group and we ${spin('work with landowners|help owners|partner with sellers')} across the region. We ${spin('close fast and cover all costs|keep it simple with no fees|handle everything start to finish')}. Do you have a few minutes to connect?` + opt;

  const reEngage = `${first ? `Hi ${first}` : 'Hi'}, we reached out about a month ago regarding your ${spin('land|acreage|parcel')}${county ? ` in ${county}` : ''}. Still have strong interest if the timing has changed. No pressure — just wanted to stay on your radar. — Coldwater Property Group` + opt;

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

  const readRes = await fetch(`https://api.jsonbin.io/v3/b/${BIN}/latest`, { headers: { 'X-Master-Key': KEY } });
  const readData = await readRes.json();
  const record = readData.record || {};
  const sequences = record.sequences || {};
  const conversations = record.conversations || {};

  if (sequences[phone]?.active) return { statusCode: 200, body: JSON.stringify({ ok: true, msg: 'already active' }) };
  if (conversations[phone]?.messages?.length > 0) return { statusCode: 200, body: JSON.stringify({ ok: true, msg: 'conversation exists' }) };

  const { msgs, alt, reEngage } = buildSequenceMessages(contact);
  const hasData = contact.name && contact.county;
  const message = hasData ? msgs[0] : alt;

  const inBizHours = isBizHours();
  const sent = inBizHours ? await sendQuoSMS(phone, message) : false;
  const scheduledFor = inBizHours ? null : new Date(nextBizTimestamp()).toISOString();

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
    nextSendAt: sent ? (Date.now() + 3 * 86400000) : nextBizTimestamp(),
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

  const ACTION_CH = process.env.SLACK_CHANNEL_ACTION;
  if (ACTION_CH) {
    try {
      const autoFireAt = Date.now() + (4 * 60 * 60 * 1000);
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

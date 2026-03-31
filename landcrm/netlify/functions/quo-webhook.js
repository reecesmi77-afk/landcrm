// quo-webhook.js — Quo webhook + AI SMS qualification engine (merged)
// Receives Quo events, stores touches, and runs AI conversation for inbound SMS

const crypto = require('crypto');

// ── HELPERS ──────────────────────────────────────────────────────────────────

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

// ── JSONBIN ───────────────────────────────────────────────────────────────────

async function readBin(KEY, BIN) {
  const res = await fetch(`https://api.jsonbin.io/v3/b/${BIN}/latest`, {
    headers: { 'X-Master-Key': KEY }
  });
  const data = await res.json();
  return data.record || { touches: [], conversations: {} };
}

async function writeBin(record, KEY, BIN) {
  await fetch(`https://api.jsonbin.io/v3/b/${BIN}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': KEY },
    body: JSON.stringify(record)
  });
}

// ── AI SMS QUALIFICATION ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are texting on behalf of William with Coldwater Property Group, a land buying company in TN, AR, OK, TX, and MO.

PERSONA: You are William's assistant. You are real, warm, and direct. Never say you are AI or a bot. If asked, say you help William manage his messages.

YOUR GOAL: Get the seller comfortable and booked for a call with William. Collect qualifying info naturally along the way.

COLLECT these 6 things in this order:
1. Confirm they own the property (owner_confirmed)
2. County and state (county)
3. Acreage (acreage)
4. Whether they are sole owner on title (sole_owner)
5. Whether taxes are current (taxes_current)
6. Best time for William to call (callback_time)

IF CRM DATA IS PROVIDED: Use it. Skip questions you already know. Just confirm: "I show you have X acres in Y County — does that sound right?"

OBJECTION HANDLING — use these exact approaches:

"What's your offer?" / "How much will you pay?"
→ "William pulls comps on your specific parcel and gives a real number on the call — usually same day. What county is the property in?"

"How did you get my number?" / "Who are you?"
→ "County records are public — William reaches out to landowners in areas he buys. I'm his assistant helping manage messages. Are you the owner of the property?"

"I'm not interested"
→ "No problem at all — sorry to bother you. If anything changes down the road, feel free to reach out. Have a great day! — Coldwater Property Group" then output [OPT_OUT]

"I already have a realtor" / "It's listed"
→ "Totally understand! We actually work with listed properties too and can close faster than most buyers. Would it be worth a quick 10-min call with William?"

"What's Coldwater Property Group?"
→ "We buy vacant land for cash in TN, AR, OK, TX and MO — no fees, no agents, fast close. William works directly with landowners."

"I need to think about it" / "Not right now"
→ "Of course — no rush at all. Can I just grab your county and acreage so William has it on file when you're ready?"

"Is this a scam?" / "Are you legitimate?"
→ "Totally fair question! We're a legit land buying company based in Tennessee. You can look us up — Coldwater Property Group. Are you the owner of the land?"

"The price needs to be X" / Seller names a price
→ "I'll pass that along to William — he'll look at the comps and see what he can do. What county is the property in so he can pull the right data?"

"I have back taxes" / "There are liens"
→ "William works with those situations all the time — it doesn't necessarily stop a deal. Can you tell me what county the property is in?"

"There are multiple owners" / "I need to talk to my family"
→ "No problem — William can work with multiple owners. When do you think you'd know if everyone is on board? I'll make sure he follows up then."

"How fast can you close?"
→ "Typically 2-4 weeks once both parties sign — William handles all the paperwork and covers closing costs. What county is your land in?"

RULES:
- One message per response — never send two separate texts
- Under 160 characters when possible
- Casual and warm, never corporate or salesy
- Never use: offer, cash, buy, purchase, sell, investor, deal in the FIRST message to a new lead
- Once all 6 data points collected, say: "Perfect — I'll get William all set for your call at [their time]. He'll reach out then. Thanks!" then output [QUALIFIED] on new line with JSON
- If they say STOP, UNSUBSCRIBE, QUIT, END, REMOVE, or NOT INTERESTED: respond politely then output [OPT_OUT]

QUALIFIED format:
[QUALIFIED]
{"owner_confirmed":true,"county":"Shelby, TN","acreage":"3","sole_owner":true,"taxes_current":true,"callback_time":"Thursday 2pm"}`;

async function getConversation(phone, record) {
  const convos = record.conversations || {};
  return convos[phone] || { messages: [], qualified: false, optOut: false, leadData: {} };
}

async function callClaude(messages) {
  const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;
  if (!CLAUDE_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: messages.slice(-20)
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API ${res.status}: ${err.slice(0,200)}`);
  }
  const data = await res.json();
  return data.content[0].text;
}

async function sendQuoSMS(toPhone, message) {
  const QUO_KEY = process.env.QUO_API_KEY;
  const QUO_PNID = process.env.QUO_PHONE_NUMBER_ID;
  if (!QUO_KEY || !QUO_PNID) {
    console.log('Quo not configured. Would send:', message);
    return;
  }
  const res = await fetch('https://api.openphone.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': QUO_KEY },
    body: JSON.stringify({ to: [toPhone], from: QUO_PNID, content: message })
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('Quo SMS error:', res.status, err.slice(0,200));
  } else {
    console.log('SMS sent to', toPhone, ':', message.slice(0,80));
  }
}

async function runAIConversation(phone, message, KEY, BIN) {
  console.log('AI conversation for:', phone, '| message:', message.slice(0,50));

  const record = await readBin(KEY, BIN);
  const convo = await getConversation(phone, record);

  if (convo.qualified) { console.log('Already qualified'); return; }
  if (convo.optOut) { console.log('Opted out'); return; }

  // Rate limit: minimum 30 seconds between AI responses to same number
  const now = Date.now();
  const lastReply = convo.lastReplyAt || 0;
  const secondsSinceLast = (now - lastReply) / 1000;
  if (secondsSinceLast < 30 && convo.messages.length > 0) {
    console.log('Rate limited:', phone, '- only', Math.round(secondsSinceLast), 'seconds since last reply');
    return;
  }
  convo.lastReplyAt = now;

  // Look up contact in CRM data by phone number
  const crmContacts = record.crmContacts || [];
  const crmContact = crmContacts.find(c => {
    const cp = c.phone ? c.phone.replace(/\D/g,'') : '';
    const pp = phone.replace(/\D/g,'');
    return cp && pp && (cp === pp || cp === pp.slice(-10) || pp === cp.slice(-10));
  });

  // Build user message with CRM context if available
  let userMessage = message;
  if (crmContact && convo.messages.length === 0) {
    const crmInfo = `

[CRM DATA for this seller: Name: ${crmContact.name||'unknown'}, County: ${crmContact.county||'unknown'}, State: ${crmContact.state||'unknown'}, Acreage: ${crmContact.acreage||'unknown'}, Source: ${crmContact.source||'unknown'}. Use this to confirm details rather than asking from scratch.]`;
    userMessage = message + crmInfo;
    console.log('CRM data found for:', crmContact.name);
  }

  convo.messages.push({ role: 'user', content: userMessage });

  let aiResponse;
  try {
    aiResponse = await callClaude(convo.messages);
    console.log('Claude response:', aiResponse.slice(0,150));
  } catch (e) {
    console.error('Claude error:', e.message);
    aiResponse = "Thanks for your message! William will follow up with you shortly. — Coldwater Property Group";
  }

  const isQualified = aiResponse.includes('[QUALIFIED]');
  const isOptOut = aiResponse.includes('[OPT_OUT]');

  let smsMessage = aiResponse.split('[QUALIFIED]')[0].split('[OPT_OUT]')[0].trim();
  let leadData = {};

  if (isQualified) {
    try {
      const jsonMatch = aiResponse.match(/\[QUALIFIED\]\s*(\{[\s\S]*\})/);
      if (jsonMatch) leadData = JSON.parse(jsonMatch[1]);
    } catch(e) { console.error('Lead JSON parse error:', e.message); }
    convo.qualified = true;
    convo.leadData = leadData;
    console.log('LEAD QUALIFIED:', JSON.stringify(leadData));

    // Store qualified lead
    if (!record.qualifiedLeads) record.qualifiedLeads = [];
    record.qualifiedLeads.push({
      phone, qualifiedAt: new Date().toISOString(),
      leadData, status: 'pending_call'
    });

    // Store as touch for CRM sync
    if (!record.touches) record.touches = [];
    record.touches.push({
      touch: {
        id: `qual-${Date.now()}`,
        date: new Date().toISOString().slice(0,10),
        timestamp: new Date().toISOString(),
        channel: 'SMS', direction: 'Inbound', by: 'AI',
        outcome: 'Qualified',
        note: `AI QUALIFIED: ${leadData.county||'?'} | ${leadData.acreage||'?'} ac | Taxes: ${leadData.taxes_current?'current':'unknown'} | Call: ${leadData.callback_time||'?'}`,
        contactPhone: phone, qualified: true, leadData
      },
      needsHandoff: true
    });
  }

  if (isOptOut) {
    convo.optOut = true;
    console.log('Lead opted out:', phone);
  }

  convo.messages.push({ role: 'assistant', content: smsMessage });

  // Save conversation back
  if (!record.conversations) record.conversations = {};
  record.conversations[phone] = convo;

  // Keep conversations for last 500 contacts
  const keys = Object.keys(record.conversations);
  if (keys.length > 500) {
    keys.slice(0, keys.length - 500).forEach(k => delete record.conversations[k]);
  }

  await writeBin(record, KEY, BIN);

  if (smsMessage) {
    await sendQuoSMS(phone, smsMessage);
  }
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const secret = process.env.QUO_WEBHOOK_SECRET;
  const sig = event.headers['x-openphone-signature'] || event.headers['x-quo-signature'] || '';
  if (!verifySignature(event.body, sig, secret)) return { statusCode: 401, body: 'Unauthorized' };

  let payload;
  try { payload = JSON.parse(event.body); } catch (e) { return { statusCode: 400, body: 'Bad JSON' }; }

  const eventType = payload.type;
  const obj = payload.data?.object || payload.data || {};

  console.log('Quo event:', eventType, JSON.stringify(obj).slice(0,200));

  // Deduplicate — ignore if we've already processed this message ID
  const messageId = obj.id;
  if (messageId && eventType === 'message.received') {
    const KEY2 = process.env.JSONBIN_API_KEY;
    const BIN2 = process.env.JSONBIN_BIN_ID;
    if (KEY2 && BIN2) {
      try {
        const rec = await readBin(KEY2, BIN2);
        const processed = rec.processedIds || [];
        if (processed.includes(messageId)) {
          console.log('Duplicate message ignored:', messageId);
          return { statusCode: 200, body: JSON.stringify({ ok: true, msg: 'duplicate' }) };
        }
        rec.processedIds = [...processed, messageId].slice(-500);
        await writeBin(rec, KEY2, BIN2);
      } catch(e) { console.error('Dedup error:', e.message); }
    }
  }

  let contactPhone = null, messageText = null, direction = 'Outbound', duration = null, summary = null;

  if (eventType === 'message.received') {
    direction = 'Inbound';
    contactPhone = normalisePhone(obj.from);
    messageText = obj.body || obj.text || obj.content || '';
  } else if (eventType === 'message.delivered') {
    direction = 'Outbound';
    contactPhone = normalisePhone(Array.isArray(obj.to) ? obj.to[0] : obj.to);
    messageText = obj.body || obj.text || obj.content || '';
  } else if (eventType === 'call.completed' || eventType === 'call.summary.completed') {
    direction = obj.direction === 'incoming' ? 'Inbound' : 'Outbound';
    contactPhone = direction === 'Inbound'
      ? normalisePhone(obj.from)
      : normalisePhone(Array.isArray(obj.to) ? obj.to[0] : obj.to);
    duration = obj.duration;
    summary = obj.summary || null;
  }

  if (!contactPhone) {
    console.log('No contact phone found');
    return { statusCode: 200, body: JSON.stringify({ ok: true, msg: 'no contact phone' }) };
  }

  const KEY = process.env.JSONBIN_API_KEY;
  const BIN = process.env.JSONBIN_BIN_ID;

  // Store touch in JSONbin
  if (KEY && BIN) {
    try {
      const record = await readBin(KEY, BIN);
      if (!record.touches) record.touches = [];
      record.touches.push({
        touch: {
          id: obj.id || `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
          quoEventType: eventType,
          date: new Date().toISOString().slice(0,10),
          timestamp: new Date().toISOString(),
          channel: eventType.startsWith('message') ? 'SMS' : 'Call',
          direction, by: 'AI',
          outcome: getOutcome(eventType, direction, duration),
          note: buildNote(eventType, messageText, duration, summary),
          contactPhone,
        },
        needsHandoff: eventType === 'message.received'
      });
      if (record.touches.length > 200) record.touches = record.touches.slice(-200);

      // Run AI conversation for inbound SMS (inline, no HTTP call)
      if (eventType === 'message.received' && messageText && KEY && BIN) {
        console.log('=== STARTING AI CONVERSATION ===');
        console.log('Phone:', contactPhone, 'Message:', messageText.slice(0,50));
        console.log('ANTHROPIC_API_KEY set:', !!process.env.ANTHROPIC_API_KEY);
        console.log('QUO_API_KEY set:', !!process.env.QUO_API_KEY);
        console.log('QUO_PHONE_NUMBER_ID set:', !!process.env.QUO_PHONE_NUMBER_ID);
        await runAIConversation(contactPhone, messageText, KEY, BIN);
        console.log('=== AI CONVERSATION COMPLETE ===');
      } else {
        console.log('Not running AI. eventType:', eventType, 'hasMessage:', !!messageText, 'hasKey:', !!KEY);
        await writeBin(record, KEY, BIN);
      }

      console.log('Processed', eventType, 'for', contactPhone);
    } catch (err) {
      console.error('Processing error:', err.message);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, event: eventType, phone: contactPhone }) };
};

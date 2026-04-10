// quo-webhook.js
const { sendSlackMessage, buildHotLeadCard } = require('./slack-notify');
// Quo webhook + AI SMS qualification engine (merged)
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

const SYSTEM_PROMPT = `You are an SMS assistant for Coldwater Property Group, a land buying company operating in TN, AR, OK, TX, and MO.

PERSONA: You represent the Coldwater Property Group team. Use "we" and "our." Never use a person's name. Never say you are AI or a bot. If asked, say you help manage messages for the team.

PRIMARY GOAL: Get the seller to agree to a quick phone call. That is the ONLY goal of every text. Do not qualify over text unless they refuse a call.

SECONDARY GOAL: If they decline a call but want to continue over text, collect these 6 things naturally:
1. Confirm they own the property (owner_confirmed)
2. County and state (county)
3. Acreage (acreage)
4. Whether they are sole owner on title (sole_owner)
5. Whether taxes are current (taxes_current)
6. Best time for a call (callback_time)

IF CRM DATA IS PROVIDED: Use it. Reference what you already know naturally. Skip questions you already have answers to.

IF LEAD GEN TRANSCRIPT IS PROVIDED: This is the conversation a partner company already had with this seller before we got involved. They were texted from a different number. Read it carefully — understand where the conversation left off, what the seller said, and what they want. Your first message must:
1. Briefly re-introduce as a different team member following up ("someone from our team reached out recently — this is us following up from a different number")
2. Reference the prior conversation naturally without quoting it verbatim
3. Pick up where it left off — if they asked about price, acknowledge that; if they expressed interest, build on it
4. Move toward booking a call

NEVER pretend the prior conversation didn't happen. NEVER start from scratch if a transcript exists.

CALL AGREEMENT DETECTION — when the seller agrees to a call, output [CALL_REQUESTED] on a new line.
Trigger words that mean YES to a call: "yes", "sure", "ok", "okay", "call me", "go ahead", "sounds good", "free now", "available", "call anytime", "call today", "you can call", "give me a call", "yeah", "yep", "fine", "alright"

CONVERSATION FLOW:

Step 1 — First message (curiosity opener, no sales language):
Vary your openers. Never start with "Hey [Name]". Examples:
- "Saw you have some land in [County] — did you ever think about selling?"
- "Quick question about your property in [County] — is that something you'd ever consider selling?"
- "Noticed you own land out in [County] — have you ever thought about what it might be worth?"

Step 2 — They show interest / respond:
Immediately pivot to a call:
- "Great — do you have 5 minutes for a quick call? We can go over everything then."
- "Awesome — easiest thing would be a quick call. Do you have a few minutes today?"
- "Perfect — would you be open to a quick call? Easier to talk through it."

Step 3 — They agree to a call:
Confirm and output the trigger:
- "Perfect — we'll give you a ring shortly. What's the best number to reach you?"
Then output [CALL_REQUESTED] on a new line.

Step 4 — They want to do it over text instead:
Respect that and collect the 6 data points one at a time, naturally.
Once all 6 collected, output [QUALIFIED] on a new line followed by JSON.

OBJECTION HANDLING:

"What's your offer?" / "How much?"
→ "That's what the call is for — we pull comps specific to your parcel and give a real number. Do you have 5 minutes to chat?"

"Who are you?" / "How did you get my number?"
→ "County records are public — we reach out to landowners in areas we buy. Are you open to a quick call to learn more?"

"Not interested"
→ "No problem at all — sorry to bother you. If anything changes, feel free to reach out. Have a great day." then output [OPT_OUT]

"I already have a realtor" / "It's listed"
→ "Totally fine — we work with listed properties too and can close faster than most. Worth a 5-minute call?"

"Is this a scam?" / "Are you legit?"
→ "Completely fair — we're Coldwater Property Group, a land buying company based in TN. Happy to answer any questions on a quick call."

"I need to think about it"
→ "Of course — no pressure. When would be a better time to connect?"

"Back taxes" / "There are liens"
→ "We work with that all the time — doesn't necessarily stop a deal. Worth a quick call to see what's possible?"

"Multiple owners" / "Need to talk to family"
→ "Totally understand — we work with multiple owners. When do you think you'd know if everyone's on the same page?"

"How fast can you close?"
→ "Typically 2-4 weeks once both sides agree — we handle all the paperwork. Want to jump on a quick call to go over it?"

Seller names a price:
→ "Good to know — we'll look at the comps and see what we can do. Do you have 5 minutes for a call so we can discuss it properly?"

LANGUAGE RULES — NEVER use these words (carrier spam triggers):
Initial texts: offer, cash, buy, purchase, sell, selling, investor, deal, interested, mortgage, loan, insurance, debt, lend, property (use "land" instead), looking
All texts: FREE, URGENT, ACT NOW, GUARANTEED, all-caps words, excessive emojis, "click here", "limited time"

FORMATTING RULES:
- One message per response — never send two texts
- Under 160 characters when possible
- Casual and warm — like a real person, not a script
- No exclamation points in first message
- No abbreviations that look unprofessional

OPT-OUT: If they say STOP, UNSUBSCRIBE, QUIT, END, REMOVE, NOT INTERESTED, LEAVE ME ALONE, STOP TEXTING, DO NOT CONTACT, TAKE ME OFF, REMOVE ME, GO AWAY, or any profanity or hostile language:
→ "No problem — we'll remove you right away. Sorry to bother you." then output [OPT_OUT]

QUALIFIED format (only if doing text qualification):
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

  // ── HARD STOP: Dead stage CRM check ─────────────────────────────────────
  const crmContacts2 = record.crmContacts || [];
  const crmContact2 = crmContacts2.find(c => {
    const cp = c.phone ? c.phone.replace(/\D/g,'') : '';
    const pp = phone.replace(/\D/g,'');
    return cp && pp && (cp === pp || cp === pp.slice(-10) || pp === cp.slice(-10));
  });
  const DEAD_STAGES_WH = ['Dead', 'Not Motivated Yet'];
  if (crmContact2 && DEAD_STAGES_WH.includes(crmContact2.stage)) {
    convo.optOut = true;
    convo.optOutReason = `CRM stage: ${crmContact2.stage}`;
    record.conversations[phone] = convo;
    await writeBin(record, KEY, BIN);
    console.log('BLOCKED — CRM stage is', crmContact2.stage, 'for', phone);
    return;
  }

  // ── HARD STOP: Profanity detection ───────────────────────────────────────
  const PROFANITY = ['fuck','shit','bitch','asshole','bastard','damn you','screw you','go to hell','leave me alone','stop texting','stop calling','never contact','do not contact','dont contact','harassment','sue you','lawyer','police','report you'];
  const msgLower = message.toLowerCase();
  const hasProfanity = PROFANITY.some(w => msgLower.includes(w));
  if (hasProfanity) {
    convo.optOut = true;
    convo.optOutReason = 'profanity / hostile message';
    convo.messages.push({ role: 'user', content: message });
    record.conversations[phone] = convo;
    await writeBin(record, KEY, BIN);
    console.log('PROFANITY DETECTED — sequence killed, no response sent:', phone);
    return;
  }

  // Rate limit: minimum 30 seconds between AI responses to same number
  const now = Date.now();
  const lastReply = convo.lastReplyAt || 0;
  const secondsSinceLast = (now - lastReply) / 1000;
  if (secondsSinceLast < 30 && convo.messages.length > 0) {
    console.log('Rate limited:', phone, '- only', Math.round(secondsSinceLast), 'seconds since last reply');
    return;
  }
  convo.lastReplyAt = now;

  // Business hours check: 9am-6pm Central only (compliant with Launch Control standard)
  const ctNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const ctHour = ctNow.getHours();
  const ctDay = ctNow.getDay();
  const isWeekend = ctDay === 0 || ctDay === 6;
  const inHours = ctHour >= 9 && ctHour < 18;
  if (!inHours || isWeekend) {
    console.log('Outside business hours (9am-6pm CT Mon-Fri) — not responding to:', phone);
    // Store message for context but don't reply
    convo.messages.push({ role: 'user', content: message });
    if (!record.conversations) record.conversations = {};
    record.conversations[phone] = convo;
    await writeBin(record, KEY, BIN);
    return;
  }

  // Look up contact in CRM data by phone number
  const crmContacts = record.crmContacts || [];
  const crmContact = crmContacts.find(c => {
    const cp = c.phone ? c.phone.replace(/\D/g,'') : '';
    const pp = phone.replace(/\D/g,'');
    return cp && pp && (cp === pp || cp === pp.slice(-10) || pp === cp.slice(-10));
  });

  // Build user message with CRM context + transcript if available
  let userMessage = message;
  if (crmContact && convo.messages.length === 0) {
    // Check for stored transcript
    const transcripts = record.transcripts || {};
    const normPhone = phone.replace(/\D/g,'');
    const transcript = transcripts[normPhone] || transcripts[phone] || null;

    let crmInfo = `\n\n[CRM DATA for this seller: Name: ${crmContact.name||'unknown'}, County: ${crmContact.county||'unknown'}, State: ${crmContact.state||'unknown'}, Acreage: ${crmContact.acreage||'unknown'} acres, Source: ${crmContact.source||'unknown'}.`;

    if (transcript) {
      crmInfo += `\n\nLEAD GEN TRANSCRIPT (conversation a partner company already had with this seller before us — they were texted from a different number):\n${transcript}\n\nThis seller is now texting YOUR number for the first time. Re-introduce briefly as a follow-up from a different number, pick up where the prior conversation left off, and move toward booking a call.]`;
      console.log('Transcript found for:', crmContact.name);
    } else {
      crmInfo += ' Use this to confirm details rather than asking from scratch.]';
    }

    userMessage = message + crmInfo;
    console.log('CRM data injected for:', crmContact.name);
  }

  convo.messages.push({ role: 'user', content: userMessage });

  let aiResponse;
  try {
    aiResponse = await callClaude(convo.messages);
    console.log('Claude response:', aiResponse.slice(0,150));
  } catch (e) {
    console.error('Claude error:', e.message);
    aiResponse = "Thanks for reaching out to Coldwater Property Group! Our team will follow up with you shortly.";
  }

  const isQualified = aiResponse.includes('[QUALIFIED]');
  const isOptOut = aiResponse.includes('[OPT_OUT]');
  const isCallRequested = aiResponse.includes('[CALL_REQUESTED]');

  let smsMessage = aiResponse.split('[QUALIFIED]')[0].split('[OPT_OUT]')[0].split('[CALL_REQUESTED]')[0].trim();
  let leadData = {};

  if (isQualified) {
    try {
      const jsonMatch = aiResponse.match(/\[QUALIFIED\]\s*(\{[\s\S]*\})/);
      if (jsonMatch) leadData = JSON.parse(jsonMatch[1]);
    } catch(e) { console.error('Lead JSON parse error:', e.message); }
    convo.qualified = true;
    convo.leadData = leadData;
    console.log('LEAD QUALIFIED:', JSON.stringify(leadData));

    // Fire immediate alert for call request
    if (isCallRequested) {
      const crmContact = record.crmContacts ? record.crmContacts.find(c => {
        const cp = c.phone ? c.phone.replace(/\D/g,'') : '';
        const pp = phone.replace(/\D/g,'');
        return cp && pp && (cp === pp || cp === pp.slice(-10) || pp === cp.slice(-10));
      }) : null;
      const contactName = crmContact ? crmContact.name : 'Unknown';
      const contactCounty = crmContact ? (crmContact.county || 'unknown county') : 'unknown county';
      const contactAcreage = crmContact ? (crmContact.acreage || '?') : '?';
      const alertMsg = `CALL REQUESTED: ${contactName} | ${phone} | ${contactAcreage} acres | ${contactCounty} | They said YES to a call — dial now`;
      console.log('ALERT:', alertMsg);
      // Send alert SMS to William's personal number
      const WILLIAM_PHONE = process.env.WILLIAM_PHONE;
      if (WILLIAM_PHONE) {
        await sendQuoSMS(WILLIAM_PHONE, alertMsg);
        console.log('Alert sent to William at', WILLIAM_PHONE);
      }
      // POST HOT LEAD TO SLACK
      const HOT_CH = process.env.SLACK_CHANNEL_HOT;
      if (HOT_CH) {
        try {
          const crmC = crmContact || { name: null, phone: phone, temp: 'warm' };
          const hotBlocks = buildHotLeadCard(crmC, message, false);
          const hotTs = await sendSlackMessage(HOT_CH, hotBlocks, `🔥 Seller replied — call now: ${crmC.name || phone}`);
          // Store ts for 30-min escalation
          if (hotTs) {
            if (!record.hotLeadAlerts) record.hotLeadAlerts = {};
            record.hotLeadAlerts[phone] = {
              ts: hotTs,
              channel: HOT_CH,
              alertedAt: Date.now(),
              escalateAt: Date.now() + (30 * 60 * 1000),
              escalated: false,
              name: crmC.name || phone,
              message: message ? message.slice(0, 200) : ''
            };
          }
        } catch(slackErr) { console.error('Slack hot lead error:', slackErr.message); }
      }

      if (!record.callRequests) record.callRequests = [];
      record.callRequests.push({
        phone, contactName, contactCounty, contactAcreage,
        requestedAt: new Date().toISOString(), status: 'pending'
      });
    }

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

      // Pause active sequence when seller replies
      if (eventType === 'message.received' && contactPhone) {
        const sequences = record.sequences || {};
        if (sequences[contactPhone] && sequences[contactPhone].active) {
          sequences[contactPhone].active = false;
          sequences[contactPhone].paused = true;
          sequences[contactPhone].pausedReason = 'replied';
          sequences[contactPhone].pausedAt = new Date().toISOString();
          record.sequences = sequences;
          console.log('Sequence paused for:', contactPhone, '— seller replied');
        }
      }

      // ── Pre-flight profanity / hostile check ───────────────────────────────
      const PROFANITY_WH = ['fuck','shit','bitch','asshole','bastard','damn you','screw you','go to hell','leave me alone','stop texting','stop calling','never contact','do not contact','dont contact','harassment','sue you','lawyer','police','report you'];
      const msgLowerWH = (messageText || '').toLowerCase();
      const isProfane = eventType === 'message.received' && PROFANITY_WH.some(w => msgLowerWH.includes(w));
      if (isProfane) {
        // Mark opted out immediately before AI even runs
        if (!record.conversations) record.conversations = {};
        if (!record.conversations[contactPhone]) record.conversations[contactPhone] = { messages: [], qualified: false, optOut: false, leadData: {} };
        record.conversations[contactPhone].optOut = true;
        record.conversations[contactPhone].optOutReason = 'profanity / hostile message';
        // Pause any active sequence
        if (record.sequences && record.sequences[contactPhone]) {
          record.sequences[contactPhone].active = false;
          record.sequences[contactPhone].paused = true;
          record.sequences[contactPhone].pausedReason = 'profanity / hostile';
        }
        await writeBin(record, KEY, BIN);
        console.log('PROFANITY PRE-FLIGHT — opted out before AI:', contactPhone);
      }

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

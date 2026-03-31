// ai-sms-responder.js
// Coldwater Property Group — AI SMS Qualification Engine
// Triggered by quo-webhook when inbound SMS received
// Uses Claude API to conduct qualifying conversation
// Sends response back via Quo API
// Flags lead as QUALIFIED in JSONbin when all 6 data points collected

const QUALIFY_FIELDS = ['owner_confirmed','county','acreage','sole_owner','taxes_current','callback_time'];

const SYSTEM_PROMPT = `You are an SMS assistant for Coldwater Property Group, a land buying company that purchases vacant land in Tennessee, Arkansas, Oklahoma, Texas, and Missouri. Your role is to qualify land sellers via text message conversation.

PERSONA: You are William's assistant. You are warm, helpful, and conversational. You are NOT a bot — never say you are a bot or AI. If asked, say you're helping William manage his messages.

GOAL: Collect these 6 pieces of information through natural conversation:
1. Confirm they are the owner of the property (owner_confirmed)
2. County and state the property is in (county)
3. Approximate acreage (acreage)
4. Whether they are the sole owner or if others are on the title (sole_owner)
5. Whether property taxes are current (taxes_current)
6. Best time for William to call them back (callback_time)

RULES:
- Keep every message under 160 characters when possible — this is SMS
- Ask ONE question at a time — never stack multiple questions
- Be conversational and casual, not robotic
- If they seem hesitant, be reassuring: we're not pressuring anyone
- Never mention price or make offers — William handles that on the call
- If they ask about price, say: "William will pull comps and give you a real number on the call — usually same day"
- If they ask how you got their number, say: "County records are public — William reaches out to landowners in areas he buys"
- If they say STOP, UNSUBSCRIBE, QUIT, END, or NOT INTERESTED: respond politely, end warmly, then output [OPT_OUT] on a new line
- Once you have confirmed all 6 data points: send a warm closing message, then output [QUALIFIED] followed by a JSON summary on the next line

QUALIFIED format (output exactly like this when done):
[QUALIFIED]
{"owner_confirmed":true,"county":"Shelby, TN","acreage":"12.5","sole_owner":true,"taxes_current":true,"callback_time":"tomorrow afternoon"}

IMPORTANT: Only output [QUALIFIED] or [OPT_OUT] once you are certain you have all required info. Never output these tags mid-conversation.`;

function normalisePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  if (digits.length > 7) return '+' + digits;
  return null;
}

async function getConversation(phone, KEY, BIN) {
  try {
    const res = await fetch(`https://api.jsonbin.io/v3/b/${BIN}/latest`, {
      headers: { 'X-Master-Key': KEY }
    });
    const data = await res.json();
    const record = data.record || {};
    const convos = record.conversations || {};
    return convos[phone] || { messages: [], qualified: false, optOut: false, leadData: {} };
  } catch (e) {
    console.error('getConversation error:', e.message);
    return { messages: [], qualified: false, optOut: false, leadData: {} };
  }
}

async function saveConversation(phone, convo, KEY, BIN) {
  try {
    const readRes = await fetch(`https://api.jsonbin.io/v3/b/${BIN}/latest`, {
      headers: { 'X-Master-Key': KEY }
    });
    const readData = await readRes.json();
    const record = readData.record || {};
    if (!record.conversations) record.conversations = {};
    record.conversations[phone] = convo;
    // Keep conversations for last 500 contacts
    const keys = Object.keys(record.conversations);
    if (keys.length > 500) {
      const oldest = keys.slice(0, keys.length - 500);
      oldest.forEach(k => delete record.conversations[k]);
    }
    await fetch(`https://api.jsonbin.io/v3/b/${BIN}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': KEY },
      body: JSON.stringify(record)
    });
  } catch (e) {
    console.error('saveConversation error:', e.message);
  }
}

async function callClaude(messages) {
  const CLAUDE_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!CLAUDE_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: messages
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.content[0].text;
}

async function sendSMS(toPhone, message, QUO_API_KEY, QUO_PHONE_NUMBER_ID) {
  if (!QUO_API_KEY || !QUO_PHONE_NUMBER_ID) {
    console.log('Quo not configured — would send:', message);
    return;
  }
  const res = await fetch('https://api.openphone.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': QUO_API_KEY
    },
    body: JSON.stringify({
      to: [toPhone],
      from: QUO_PHONE_NUMBER_ID,
      content: message
    })
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('Quo SMS send error:', res.status, err);
  } else {
    console.log('SMS sent to', toPhone);
  }
}

async function flagQualifiedLead(phone, leadData, convo, KEY, BIN) {
  try {
    const readRes = await fetch(`https://api.jsonbin.io/v3/b/${BIN}/latest`, {
      headers: { 'X-Master-Key': KEY }
    });
    const readData = await readRes.json();
    const record = readData.record || {};
    if (!record.qualifiedLeads) record.qualifiedLeads = [];
    record.qualifiedLeads.push({
      phone,
      qualifiedAt: new Date().toISOString(),
      leadData,
      conversationLength: convo.messages.length,
      status: 'pending_call'
    });
    // Also store as a touch so REI Razor sync picks it up
    if (!record.touches) record.touches = [];
    record.touches.push({
      touch: {
        id: `qual-${Date.now()}`,
        quoEventType: 'lead.qualified',
        date: new Date().toISOString().slice(0, 10),
        timestamp: new Date().toISOString(),
        channel: 'SMS',
        direction: 'Inbound',
        by: 'AI',
        outcome: 'Qualified',
        note: `AI QUALIFIED: ${leadData.county || '?'} | ${leadData.acreage || '?'} ac | Owner: ${leadData.sole_owner ? 'sole' : 'multiple'} | Taxes: ${leadData.taxes_current ? 'current' : 'unknown'} | Call: ${leadData.callback_time || '?'}`,
        contactPhone: phone,
        qualified: true,
        leadData
      },
      needsHandoff: true
    });
    await fetch(`https://api.jsonbin.io/v3/b/${BIN}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': KEY },
      body: JSON.stringify(record)
    });
    console.log('Lead flagged as qualified:', phone);
  } catch (e) {
    console.error('flagQualifiedLead error:', e.message);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: 'Bad JSON' };
  }

  const { phone, message } = body;
  if (!phone || !message) {
    return { statusCode: 400, body: 'Missing phone or message' };
  }

  const KEY = process.env.JSONBIN_API_KEY;
  const BIN = process.env.JSONBIN_BIN_ID;
  const QUO_API_KEY = process.env.QUO_API_KEY;
  const QUO_PHONE_NUMBER_ID = process.env.QUO_PHONE_NUMBER_ID;

  const normPhone = normalisePhone(phone);
  if (!normPhone) {
    return { statusCode: 400, body: 'Invalid phone number' };
  }

  // Load existing conversation
  const convo = await getConversation(normPhone, KEY, BIN);

  // If already qualified or opted out, don't respond
  if (convo.qualified) {
    console.log('Already qualified:', normPhone);
    return { statusCode: 200, body: JSON.stringify({ ok: true, status: 'already_qualified' }) };
  }
  if (convo.optOut) {
    console.log('Opted out:', normPhone);
    return { statusCode: 200, body: JSON.stringify({ ok: true, status: 'opted_out' }) };
  }

  // Add seller's message to history
  convo.messages.push({ role: 'user', content: message });

  // Build message history for Claude (last 20 messages to stay within limits)
  const recentMessages = convo.messages.slice(-20);

  let aiResponse;
  try {
    aiResponse = await callClaude(recentMessages);
  } catch (e) {
    console.error('Claude error:', e.message);
    // Fallback message if Claude fails
    aiResponse = "Hey, thanks for your message! William will follow up with you shortly. — Coldwater Property Group";
  }

  console.log('Claude response:', aiResponse.slice(0, 200));

  // Check for qualification or opt-out tags
  const isQualified = aiResponse.includes('[QUALIFIED]');
  const isOptOut = aiResponse.includes('[OPT_OUT]');

  // Extract the SMS message (everything before the tag)
  let smsMessage = aiResponse;
  let leadData = {};

  if (isQualified) {
    smsMessage = aiResponse.split('[QUALIFIED]')[0].trim();
    try {
      const jsonMatch = aiResponse.match(/\[QUALIFIED\]\s*(\{[\s\S]*\})/);
      if (jsonMatch) {
        leadData = JSON.parse(jsonMatch[1]);
      }
    } catch (e) {
      console.error('Failed to parse lead JSON:', e.message);
    }
    convo.qualified = true;
    convo.leadData = leadData;
    await flagQualifiedLead(normPhone, leadData, convo, KEY, BIN);
  }

  if (isOptOut) {
    smsMessage = aiResponse.split('[OPT_OUT]')[0].trim();
    convo.optOut = true;
  }

  // Add AI response to history
  convo.messages.push({ role: 'assistant', content: smsMessage });

  // Save updated conversation
  await saveConversation(normPhone, convo, KEY, BIN);

  // Send SMS via Quo
  if (smsMessage) {
    await sendSMS(normPhone, smsMessage, QUO_API_KEY, QUO_PHONE_NUMBER_ID);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      phone: normPhone,
      qualified: isQualified,
      optOut: isOptOut,
      messageSent: smsMessage.slice(0, 100),
      leadData: isQualified ? leadData : undefined
    })
  };
};

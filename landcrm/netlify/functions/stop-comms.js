// stop-comms.js
// Immediately stops all outbound comms for a contact
// Marks opted-out in conversations + deactivates sequence in JSONbin
// Called by the "Stop Comms" button in the contact card

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const KEY = process.env.JSONBIN_API_KEY;
  const BIN = process.env.JSONBIN_BIN_ID;
  if (!KEY || !BIN) return { statusCode: 500, body: JSON.stringify({ error: 'JSONbin not configured' }) };

  let body;
  try { body = JSON.parse(event.body); } catch(e) { return { statusCode: 400, body: 'Bad JSON' }; }

  const { phone, name } = body;
  if (!phone) return { statusCode: 400, body: JSON.stringify({ error: 'phone required' }) };

  // Normalize to multiple formats to catch all variants
  const digits = phone.replace(/\D/g, '');
  const e164 = '+' + (digits.length === 10 ? '1' + digits : digits);
  const tenDigit = digits.slice(-10);
  const phonesToStop = [e164, digits, tenDigit, '+1' + tenDigit];

  try {
    const readRes = await fetch(`https://api.jsonbin.io/v3/b/${BIN}/latest`, {
      headers: { 'X-Master-Key': KEY }
    });
    const readData = await readRes.json();
    const record = readData.record || {};

    if (!record.conversations) record.conversations = {};
    if (!record.sequences) record.sequences = {};

    const actions = [];

    phonesToStop.forEach(p => {
      // Mark opted-out in conversations
      if (!record.conversations[p]) record.conversations[p] = { messages: [] };
      record.conversations[p].optOut = true;
      record.conversations[p].optOutReason = name ? `Manual stop — ${name} marked Dead in CRM` : 'Manual stop via Stop Comms button';
      record.conversations[p].optOutAt = new Date().toISOString();
      actions.push(`${p} opted-out in conversations`);

      // Deactivate sequence if active
      if (record.sequences[p]) {
        record.sequences[p].active = false;
        record.sequences[p].paused = true;
        record.sequences[p].stoppedAt = new Date().toISOString();
        record.sequences[p].stoppedReason = 'Dead — Stop Comms button clicked';
        actions.push(`${p} sequence deactivated`);
      }
    });

    // Write back to JSONbin
    await fetch(`https://api.jsonbin.io/v3/b/${BIN}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': KEY },
      body: JSON.stringify(record)
    });

    console.log('Stop comms executed for', name || phone, ':', actions.join(', '));
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, actions })
    };

  } catch(err) {
    console.error('Stop comms error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

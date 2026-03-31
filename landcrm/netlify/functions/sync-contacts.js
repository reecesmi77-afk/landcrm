// sync-contacts.js
// Called by REI Razor when contacts are saved
// Stores contact list in JSONbin so AI can look up sellers by phone

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const KEY = process.env.JSONBIN_API_KEY;
  const BIN = process.env.JSONBIN_BIN_ID;
  if (!KEY || !BIN) return { statusCode: 200, body: JSON.stringify({ ok: false, msg: 'JSONbin not configured' }) };

  let body;
  try { body = JSON.parse(event.body); } catch(e) { return { statusCode: 400, body: 'Bad JSON' }; }

  const contacts = (body.contacts || []).map(c => ({
    id: c.id,
    name: c.name,
    phone: c.phone,
    county: c.county,
    state: c.state,
    acreage: c.acreage,
    apn: c.apn,
    source: c.source,
    stage: c.stage,
    motivation: c.motivation,
  }));

  try {
    const readRes = await fetch(`https://api.jsonbin.io/v3/b/${BIN}/latest`, {
      headers: { 'X-Master-Key': KEY }
    });
    const readData = await readRes.json();
    const record = readData.record || {};
    record.crmContacts = contacts;

    await fetch(`https://api.jsonbin.io/v3/b/${BIN}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': KEY },
      body: JSON.stringify(record)
    });

    console.log('Synced', contacts.length, 'contacts to JSONbin');
    return { statusCode: 200, body: JSON.stringify({ ok: true, synced: contacts.length }) };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

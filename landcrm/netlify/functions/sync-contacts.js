// sync-contacts.js
// Syncs CRM contacts AND lead gen transcripts to JSONbin for Claude to reference

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const KEY = process.env.JSONBIN_API_KEY;
  const BIN = process.env.JSONBIN_BIN_ID;
  if (!KEY || !BIN) return { statusCode: 500, body: JSON.stringify({ error: 'JSONbin not configured' }) };

  let body;
  try { body = JSON.parse(event.body); } catch(e) { return { statusCode: 400, body: 'Bad JSON' }; }

  const { contacts, transcripts } = body;

  // Read current bin
  const readRes = await fetch(`https://api.jsonbin.io/v3/b/${BIN}/latest`, {
    headers: { 'X-Master-Key': KEY }
  });
  const readData = await readRes.json();
  const record = readData.record || {};

  // Update CRM contacts
  if (contacts && Array.isArray(contacts)) {
    record.crmContacts = contacts.map(function(c) {
      return {
        id: c.id,
        name: c.name,
        phone: c.phone,
        county: c.county,
        state: c.state,
        acreage: c.acreage,
        source: c.source,
        stage: c.stage,
        temp: c.temp,
        motivation: c.motivation,
        leadReceived: c.leadReceived,
        leadGenCompany: c.leadGenCompany
      };
    });
    console.log('Synced', contacts.length, 'contacts to JSONbin');
  }

  // Store transcripts keyed by normalized phone number
  if (transcripts && Array.isArray(transcripts) && transcripts.length > 0) {
    if (!record.transcripts) record.transcripts = {};
    transcripts.forEach(function(t) {
      if (!t.phone || !t.transcript) return;
      var normPhone = t.phone.replace(/\D/g, '');
      if (normPhone.length === 10) normPhone = '+1' + normPhone;
      else if (normPhone.length === 11 && normPhone[0] === '1') normPhone = '+' + normPhone;
      record.transcripts[normPhone] = t.transcript;
      console.log('Stored transcript for', t.name, normPhone);
    });
  }

  // Write back
  await fetch(`https://api.jsonbin.io/v3/b/${BIN}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': KEY },
    body: JSON.stringify(record)
  });

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      contacts: (record.crmContacts || []).length,
      transcripts: Object.keys(record.transcripts || {}).length
    })
  };
};

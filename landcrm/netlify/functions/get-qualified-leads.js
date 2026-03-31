// get-qualified-leads.js
// Returns all qualified leads from JSONbin for REI Razor to display
// Called by the CRM to show AI-qualified leads in handoff queue

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const KEY = process.env.JSONBIN_API_KEY;
  const BIN = process.env.JSONBIN_BIN_ID;

  if (!KEY || !BIN) {
    return { statusCode: 200, body: JSON.stringify({ qualifiedLeads: [] }) };
  }

  try {
    const res = await fetch(`https://api.jsonbin.io/v3/b/${BIN}/latest`, {
      headers: { 'X-Master-Key': KEY }
    });
    const data = await res.json();
    const record = data.record || {};
    const qualifiedLeads = record.qualifiedLeads || [];
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qualifiedLeads })
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message })
    };
  }
};

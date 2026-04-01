// get-qualified-leads.js
// Returns qualified leads AND conversation history from JSONbin
// Used by CRM for AI Handoff Queue and Pre-Call Brief generation

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const KEY = process.env.JSONBIN_API_KEY;
  const BIN = process.env.JSONBIN_BIN_ID;

  if (!KEY || !BIN) {
    return { statusCode: 200, body: JSON.stringify({ qualifiedLeads: [], conversations: {} }) };
  }

  try {
    const res = await fetch(`https://api.jsonbin.io/v3/b/${BIN}/latest`, {
      headers: { 'X-Master-Key': KEY }
    });
    const data = await res.json();
    const record = data.record || {};

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        qualifiedLeads: record.qualifiedLeads || [],
        conversations: record.conversations || {},
        callRequests: record.callRequests || [],
        sequences: record.sequences || {}
      })
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message, qualifiedLeads: [], conversations: {} })
    };
  }
};

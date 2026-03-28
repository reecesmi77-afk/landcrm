// get-touches.js — reads from JSONbin and returns pending touches
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: 'Method not allowed' };

  const KEY = process.env.JSONBIN_API_KEY;
  const BIN = process.env.JSONBIN_BIN_ID;

  if (!KEY || !BIN) {
    return { statusCode: 200, headers, body: JSON.stringify({ touches: [], count: 0, error: 'JSONbin not configured' }) };
  }

  try {
    // Read current touches
    const readRes = await fetch(`https://api.jsonbin.io/v3/b/${BIN}/latest`, {
      headers: { 'X-Master-Key': KEY }
    });
    const readData = await readRes.json();
    const current = readData.record || { touches: [] };
    const touches = current.touches || [];

    // Clear the bin after reading
    if (touches.length > 0) {
      await fetch(`https://api.jsonbin.io/v3/b/${BIN}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Master-Key': KEY },
        body: JSON.stringify({ touches: [] })
      });
    }

    return { statusCode: 200, headers, body: JSON.stringify({ touches, count: touches.length }) };
  } catch (err) {
    console.error('get-touches error:', err.message);
    return { statusCode: 200, headers, body: JSON.stringify({ touches: [], count: 0, error: err.message }) };
  }
};

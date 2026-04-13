// dd-analysis.js — proxies DD analysis requests to Claude API with retry
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method not allowed' };

  const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;
  if (!CLAUDE_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { prompt } = body;
  if (!prompt) return { statusCode: 400, headers, body: JSON.stringify({ error: 'prompt required' }) };

  const callClaude = async () => {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || `Claude API ${resp.status}`);
    return data.content && data.content[0] ? data.content[0].text : 'No response received.';
  };

  try {
    const text = await callClaude();
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, text }) };
  } catch (err) {
    console.error('First attempt failed:', err.message);
    // Retry once on overload
    if (err.message.includes('529') || err.message.toLowerCase().includes('overload')) {
      console.log('Overloaded — retrying in 4 seconds...');
      await new Promise(r => setTimeout(r, 4000));
      try {
        const text = await callClaude();
        console.log('Retry succeeded');
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, text }) };
      } catch (err2) {
        console.error('Retry failed:', err2.message);
        return { statusCode: 200, headers, body: JSON.stringify({ error: 'Claude is busy right now — please try again in a moment.' }) };
      }
    }
    return { statusCode: 200, headers, body: JSON.stringify({ error: err.message }) };
  }
};

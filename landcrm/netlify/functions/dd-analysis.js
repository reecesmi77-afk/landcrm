// dd-analysis.js — proxies DD analysis requests to Claude API with 3-attempt retry
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
    if (!resp.ok) {
      const msg = data.error?.message || `Claude API ${resp.status}`;
      const err = new Error(msg);
      err.status = resp.status;
      throw err;
    }
    return data.content && data.content[0] ? data.content[0].text : 'No response received.';
  };

  const delays = [0, 6000, 12000]; // immediate, 6s, 12s
  let lastError = null;

  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) {
      console.log(`Attempt ${i+1} — waiting ${delays[i]/1000}s before retry...`);
      await new Promise(r => setTimeout(r, delays[i]));
    }
    try {
      const text = await callClaude();
      console.log(`Succeeded on attempt ${i+1}`);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, text }) };
    } catch (err) {
      lastError = err;
      const isOverload = err.status === 529 || err.message.toLowerCase().includes('overload');
      console.error(`Attempt ${i+1} failed:`, err.message);
      if (!isOverload) break; // don't retry non-overload errors
    }
  }

  console.error('All attempts failed:', lastError?.message);
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ error: 'Claude is busy right now — please try again in a few minutes.' })
  };
};

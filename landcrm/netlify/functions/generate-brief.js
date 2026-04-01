// generate-brief.js
// Generates a Pre-Call Seller Brief using Claude API
// Called from the CRM frontend — proxies the Anthropic API securely

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;
  if (!CLAUDE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Bad JSON' }) };
  }

  const { contact, conversationHistory } = body;
  if (!contact) {
    return { statusCode: 400, body: JSON.stringify({ error: 'contact required' }) };
  }

  const convoText = (conversationHistory || []).length
    ? conversationHistory.map(m => `${m.role === 'user' ? 'SELLER' : 'AI'}: ${m.content}`).join('\n')
    : 'No SMS conversation on record yet.';

  const crmContext = `
Contact: ${contact.name || 'unknown'}
Phone: ${contact.phone || 'unknown'}
County: ${contact.county || 'unknown'}, ${contact.state || ''}
Acreage: ${contact.acreage || 'unknown'} acres
APN: ${contact.apn || 'unknown'}
Source: ${contact.source || 'unknown'}
Stage: ${contact.stage || 'unknown'}
Temperature: ${contact.temp || 'cold'}
Motivation notes: ${contact.motivation || 'none recorded'}
Asking price: ${contact.askingPrice ? '$' + contact.askingPrice : 'unknown'}
Tags: ${(contact.tags || []).join(', ') || 'none'}
Notes: ${(contact.notes || []).map(n => n.text).join(' | ') || 'none'}
`.trim();

  const prompt = `You are preparing a Pre-Call Seller Brief for a land investor about to call a seller.

CRM DATA:
${crmContext}

SMS CONVERSATION HISTORY:
${convoText}

Generate a structured Pre-Call Seller Brief with exactly these 5 sections. Be specific, concise, and actionable. Use only information that is actually available — do not fabricate details. If something is unknown, say so clearly.

Return ONLY a valid JSON object with these exact keys, no other text, no markdown:
{
  "propertySnapshot": "2-3 sentence summary of the property facts",
  "motivationSummary": "What do we know about why they might sell? What is their situation?",
  "priceExpectations": "What price expectations have been expressed or implied? How does this compare to likely market value for this acreage and county?",
  "riskFlags": ["flag 1", "flag 2"],
  "talkingPoints": ["point 1", "point 2", "point 3"]
}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!res.ok) {
      const err = await res.text();
      return { statusCode: 500, body: JSON.stringify({ error: `Claude API ${res.status}: ${err.slice(0, 200)}` }) };
    }

    const data = await res.json();
    const raw = data.content[0].text.trim().replace(/```json|```/g, '').trim();
    const brief = JSON.parse(raw);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, brief })
    };

  } catch(e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message })
    };
  }
};

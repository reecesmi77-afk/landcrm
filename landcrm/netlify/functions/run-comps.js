// run-comps.js
// AI-powered land comp analysis using Claude
// Phase 1: Uses Claude's training knowledge + CRM history
// Phase 2 (future): Add REAPI key for live comp data

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

  const { county, state, acreage, askingPrice, apn, recentDeals, similarLeads, notes, motivation } = body;

  const prompt = `You are an expert land comp analyst for a land investing company (Coldwater Property Group) that buys vacant land in TN, AR, OK, TX, and MO.

SUBJECT PROPERTY:
- County: ${county}
- State: ${state}
- Acreage: ${acreage || 'unknown'} acres
- Seller's asking price: ${askingPrice ? '$' + askingPrice : 'unknown'}
- APN: ${apn || 'not provided'}
- Notes: ${notes || 'none'}
- Motivation: ${motivation || 'unknown'}

CRM HISTORY — Recent closed deals by this investor:
${recentDeals}

CRM HISTORY — Similar active leads in this county:
${similarLeads}

TASK:
Analyze the land market for ${county}, ${state} and provide a comp analysis for ${acreage || 'this'} acres of vacant land.

Use your knowledge of:
1. County-level land market conditions in ${state}
2. Typical rural/vacant land pricing in this region
3. Factors that affect land value in this specific county (proximity to cities, timber value, farmland quality, development potential)
4. The investor's CRM history provided above
5. Wholesale/investor pricing (typically 40-65% of retail market value for motivated sellers)

Return ONLY a valid JSON object with no markdown or preamble:
{
  "offerRangeLow": "$X,XXX",
  "offerRangeHigh": "$X,XXX",
  "medianPricePerAcre": "$X,XXX",
  "confidence": "High|Medium|Low",
  "confidenceReason": "brief reason why confidence is high/medium/low",
  "marketSummary": "2-3 sentences on land market conditions in this specific county and state — prices, demand, trends, what buyers are paying",
  "comps": [
    {
      "description": "Brief comp description (e.g. '15-acre rural parcel, Smith County TX')",
      "acreage": "15",
      "pricePerAcre": "$1,200",
      "source": "County records / Market knowledge / CRM history"
    }
  ],
  "dataLimitation": "Note any limitations in this analysis — e.g. thin market, rural county with few comps, etc. Leave empty string if not needed.",
  "negotiationNotes": "2-3 specific tactics for this deal — when to push, when to hold, what the seller's asking price tells you, how much room there is"
}

Important: The offer range should reflect WHOLESALE investor pricing (what Coldwater would offer to buy at, leaving room for their profit margin). Not retail value. If acreage is unknown, base analysis on typical parcels in this county.`;

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
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!res.ok) {
      const err = await res.text();
      return { statusCode: 500, body: JSON.stringify({ error: `Claude API ${res.status}: ${err.slice(0, 200)}` }) };
    }

    const data = await res.json();
    const raw = data.content[0].text.trim().replace(/```json|```/g, '').trim();
    const analysis = JSON.parse(raw);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, analysis })
    };

  } catch(e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: e.message })
    };
  }
};

// skip-trace.js
// PropertyAPI.co skip trace — 2 credits per lookup
// Pass APN + FIPS, or street address. Optionally include owner name for better match.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const API_KEY = process.env.PROPERTY_API_KEY;
  if (!API_KEY) return { statusCode: 500, body: JSON.stringify({ error: 'PROPERTY_API_KEY not configured' }) };

  let body;
  try { body = JSON.parse(event.body); } catch(e) { return { statusCode: 400, body: 'Bad JSON' }; }

  const { apn, fips, county, state, address, city, zip, ownerFirst, ownerLast } = body;

  if (!apn && !address) {
    return { statusCode: 400, body: JSON.stringify({ error: 'apn or address required' }) };
  }

  const BASE = 'https://propertyapi.co/api/v1';
  const headers = { 'X-Api-Key': API_KEY, 'Content-Type': 'application/json' };

  try {
    // Build lookup object
    const lookup = { uid: apn || address };

    // Add name if available (improves match accuracy)
    if (ownerFirst || ownerLast) {
      lookup.name = {};
      if (ownerFirst) lookup.name.first = ownerFirst;
      if (ownerLast) lookup.name.last = ownerLast;
    }

    // Prefer APN lookup, fall back to address
    if (apn) {
      lookup.apn = {
        apn,
        fips: fips ? parseInt(fips) : undefined,
        county: county || undefined,
        state: state || undefined
      };
    } else {
      lookup.address = {
        street: address,
        city: city || undefined,
        state: state || undefined,
        zip: zip || undefined
      };
    }

    const res = await fetch(`${BASE}/skip-trace`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ lookups: [lookup] })
    });

    const data = await res.json();
    console.log('Skip trace status:', data.status, 'credits used:', data.credits_used);

    if (data.status !== 'ok' || !data.data || data.data.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: false, error: data.error || 'No results', creditsRemaining: data.credits_remaining })
      };
    }

    const r = data.data[0];

    // Parse into clean format
    const parsed = {
      nameFirst:    r.name_first || null,
      nameMiddle:   r.name_middle || null,
      nameLast:     r.name_last || null,
      deceased:     r.deceased || false,

      email1: r.email_1 || null,
      email2: r.email_2 || null,

      phone1: r.phone_1_number ? {
        number:           r.phone_1_number,
        type:             r.phone_1_type || null,
        carrier:          r.phone_1_carrier || null,
        reachable:        r.phone_1_reachable || false,
        score:            r.phone_1_score || null,
        dnc:              r.phone_1_dnc || false,
        lastReported:     r.phone_1_last_reported_date || null
      } : null,

      phone2: r.phone_2_number ? {
        number:           r.phone_2_number,
        type:             r.phone_2_type || null,
        score:            r.phone_2_score || null
      } : null,

      creditsUsed:      data.credits_used,
      creditsRemaining: data.credits_remaining
    };

    console.log('Skip trace result:', parsed.nameFirst, parsed.nameLast, '- Phone 1:', parsed.phone1?.number, 'Reachable:', parsed.phone1?.reachable);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, data: parsed, creditsUsed: data.credits_used, creditsRemaining: data.credits_remaining })
    };

  } catch(err) {
    console.error('Skip trace error:', err.message);
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: false, error: err.message })
    };
  }
};

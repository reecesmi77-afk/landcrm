// netlify/functions/crm-knowledge.js
// Read-only GET endpoint for knowledge base — CORS-enabled for claude.ai

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  'https://claude.ai',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }

  // Auth
  const bridgeKey   = process.env.BRIDGE_KEY || '';
  const incomingKey = (event.queryStringParameters || {}).key || '';
  if (!bridgeKey || incomingKey !== bridgeKey) {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'Unauthorized' }) };
  }

  const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'Supabase env vars not set' }) };
  }

  const params   = event.queryStringParameters || {};
  const action   = params.action   || '';
  const category = params.category || '';

  const sbHeaders = {
    'apikey':        SERVICE_KEY,
    'Authorization': 'Bearer ' + SERVICE_KEY,
    'Content-Type':  'application/json',
  };

  function ok(data) {
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true, data }) };
  }

  function fail(err, status) {
    return { statusCode: status || 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: err }) };
  }

  try {
    let r, text;

    switch (action) {

      // ── GET ALL KNOWLEDGE ENTRIES ─────────────────────────────────────────
      case 'get_knowledge':
        r = await fetch(SUPABASE_URL + '/rest/v1/knowledge?select=*&order=created_at.desc', { headers: sbHeaders });
        text = await r.text();
        if (!r.ok) return fail('Supabase error: ' + text, r.status);
        return ok(JSON.parse(text));

      // ── GET BY CATEGORY ───────────────────────────────────────────────────
      case 'get_by_category':
        if (!category) return fail('category param is required', 400);
        r = await fetch(
          SUPABASE_URL + '/rest/v1/knowledge?category=eq.' + encodeURIComponent(category) + '&select=*&order=created_at.desc',
          { headers: sbHeaders }
        );
        text = await r.text();
        if (!r.ok) return fail('Supabase error: ' + text, r.status);
        return ok(JSON.parse(text));

      default:
        return fail('Unknown action: ' + (action || '(none)') + '. Valid: get_knowledge, get_by_category', 400);
    }

  } catch (e) {
    console.error('[crm-knowledge] exception:', e.message);
    return fail(e.message, 500);
  }
};

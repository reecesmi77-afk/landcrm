// netlify/functions/crm-query.js
// Read-only GET endpoint for querying CRM data from Supabase

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }

  // Auth — require ?key=BRIDGE_KEY query param
  const bridgeKey   = process.env.BRIDGE_KEY || '';
  const incomingKey = (event.queryStringParameters || {}).key || '';
  if (!bridgeKey || incomingKey !== bridgeKey) {
    return { statusCode: 401, body: JSON.stringify({ success: false, error: 'Unauthorized' }) };
  }

  const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ success: false, error: 'Supabase env vars not set' }) };
  }

  const params  = event.queryStringParameters || {};
  const action  = params.action || '';

  const headers = {
    'apikey':        SERVICE_KEY,
    'Authorization': 'Bearer ' + SERVICE_KEY,
    'Content-Type':  'application/json',
  };

  function respond(data) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, data }),
    };
  }

  function respondError(err, status) {
    return {
      statusCode: status || 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: err }),
    };
  }

  try {
    let r, text, data;

    switch (action) {

      // ── GET ALL PROPERTIES ──────────────────────────────────────────────────
      case 'get_properties':
        r = await fetch(SUPABASE_URL + '/rest/v1/properties?select=*&order=created_at.desc', { headers });
        text = await r.text();
        if (!r.ok) return respondError('Supabase error: ' + text, r.status);
        return respond(JSON.parse(text));

      // ── GET SINGLE PROPERTY ─────────────────────────────────────────────────
      case 'get_property':
        if (!params.id) return respondError('id query param is required', 400);
        r = await fetch(
          SUPABASE_URL + '/rest/v1/properties?id=eq.' + encodeURIComponent(params.id) + '&select=*',
          { headers }
        );
        text = await r.text();
        if (!r.ok) return respondError('Supabase error: ' + text, r.status);
        data = JSON.parse(text);
        return respond(Array.isArray(data) ? data[0] || null : data);

      // ── GET ACTIVITY LOG FOR A PROPERTY ────────────────────────────────────
      case 'get_activity_log':
        if (!params.property_id) return respondError('property_id query param is required', 400);
        r = await fetch(
          SUPABASE_URL + '/rest/v1/activity_log?property_id=eq.' + encodeURIComponent(params.property_id) + '&select=*&order=created_at.desc',
          { headers }
        );
        text = await r.text();
        if (!r.ok) return respondError('Supabase error: ' + text, r.status);
        return respond(JSON.parse(text));

      default:
        return respondError('Unknown action: ' + (action || '(none)') + '. Valid actions: get_properties, get_property, get_activity_log', 400);
    }

  } catch (e) {
    console.error('[crm-query] exception:', e.message);
    return respondError(e.message, 500);
  }
};

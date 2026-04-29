// netlify/functions/crm-bridge.js
// Secure Supabase API bridge using service role key (server-side only)

exports.handler = async (event) => {
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }

  // Security check — require x-bridge-key header matching BRIDGE_KEY env var
  const bridgeKey = process.env.BRIDGE_KEY || '';
  const incomingKey = event.headers['x-bridge-key'] || event.headers['X-Bridge-Key'] || '';
  if (!bridgeKey || incomingKey !== bridgeKey) {
    return { statusCode: 401, body: JSON.stringify({ success: false, error: 'Unauthorized' }) };
  }

  const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ success: false, error: 'Supabase env vars not set' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Invalid JSON body' }) };
  }

  const { action, payload = {} } = body;

  const headers = {
    'apikey':        SERVICE_KEY,
    'Authorization': 'Bearer ' + SERVICE_KEY,
    'Content-Type':  'application/json',
  };

  function respond(data, status) {
    return {
      statusCode: status || 200,
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
        if (!payload.id) return respondError('payload.id is required', 400);
        r = await fetch(SUPABASE_URL + '/rest/v1/properties?id=eq.' + encodeURIComponent(payload.id) + '&select=*', { headers });
        text = await r.text();
        if (!r.ok) return respondError('Supabase error: ' + text, r.status);
        data = JSON.parse(text);
        return respond(Array.isArray(data) ? data[0] || null : data);

      // ── UPSERT PROPERTY ─────────────────────────────────────────────────────
      case 'update_property':
        if (!payload.id) return respondError('payload.id is required', 400);
        r = await fetch(SUPABASE_URL + '/rest/v1/properties?on_conflict=id', {
          method:  'POST',
          headers: Object.assign({}, headers, { 'Prefer': 'resolution=merge-duplicates,return=representation' }),
          body:    JSON.stringify(payload),
        });
        text = await r.text();
        if (!r.ok) return respondError('Supabase error: ' + text, r.status);
        data = JSON.parse(text);
        return respond(Array.isArray(data) ? data[0] || null : data);

      // ── INSERT PROPERTY ─────────────────────────────────────────────────────
      case 'insert_property':
        r = await fetch(SUPABASE_URL + '/rest/v1/properties', {
          method:  'POST',
          headers: Object.assign({}, headers, { 'Prefer': 'return=representation' }),
          body:    JSON.stringify(payload),
        });
        text = await r.text();
        if (!r.ok) return respondError('Supabase error: ' + text, r.status);
        data = JSON.parse(text);
        return respond(Array.isArray(data) ? data[0] || null : data);

      // ── GET ACTIVITY LOG FOR A PROPERTY ────────────────────────────────────
      case 'get_activity_log':
        if (!payload.property_id) return respondError('payload.property_id is required', 400);
        r = await fetch(
          SUPABASE_URL + '/rest/v1/activity_log?property_id=eq.' + encodeURIComponent(payload.property_id) + '&select=*&order=created_at.desc',
          { headers }
        );
        text = await r.text();
        if (!r.ok) return respondError('Supabase error: ' + text, r.status);
        return respond(JSON.parse(text));

      // ── INSERT ACTIVITY LOG ENTRY ───────────────────────────────────────────
      case 'insert_activity':
        if (!payload.property_id) return respondError('payload.property_id is required', 400);
        if (!payload.entry)       return respondError('payload.entry is required', 400);
        r = await fetch(SUPABASE_URL + '/rest/v1/activity_log', {
          method:  'POST',
          headers: Object.assign({}, headers, { 'Prefer': 'return=representation' }),
          body:    JSON.stringify({ property_id: payload.property_id, entry: payload.entry }),
        });
        text = await r.text();
        if (!r.ok) return respondError('Supabase error: ' + text, r.status);
        data = JSON.parse(text);
        return respond(Array.isArray(data) ? data[0] || null : data);

      default:
        return respondError('Unknown action: ' + action, 400);
    }

  } catch (e) {
    console.error('[crm-bridge] exception:', e.message);
    return respondError(e.message, 500);
  }
};

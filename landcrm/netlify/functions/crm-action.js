// netlify/functions/crm-action.js
// Identical to crm-update.js but with Access-Control-Allow-Origin: https://claude.ai
// so Claude's browser-based fetch can reach it directly

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
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

  const params = event.queryStringParameters || {};
  const action = params.action || '';
  const id     = params.id     || '';
  const field  = params.field  || '';
  const value  = params.value  || '';
  const entry  = params.entry  || '';

  const sbHeaders = {
    'apikey':        SERVICE_KEY,
    'Authorization': 'Bearer ' + SERVICE_KEY,
    'Content-Type':  'application/json',
  };

  function ok(data) {
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true, data: data || null }) };
  }

  function fail(err, status) {
    return { statusCode: status || 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: err }) };
  }

  async function sbPatch(table, matchField, matchValue, patch) {
    const url = SUPABASE_URL + '/rest/v1/' + table + '?' + matchField + '=eq.' + encodeURIComponent(matchValue);
    const r = await fetch(url, {
      method:  'PATCH',
      headers: Object.assign({}, sbHeaders, { 'Prefer': 'return=representation' }),
      body:    JSON.stringify(patch),
    });
    const text = await r.text();
    if (!r.ok) throw new Error('Supabase PATCH failed (' + r.status + '): ' + text);
    const data = JSON.parse(text);
    return Array.isArray(data) ? data[0] || null : data;
  }

  async function sbInsert(table, row) {
    const r = await fetch(SUPABASE_URL + '/rest/v1/' + table, {
      method:  'POST',
      headers: Object.assign({}, sbHeaders, { 'Prefer': 'return=representation' }),
      body:    JSON.stringify(row),
    });
    const text = await r.text();
    if (!r.ok) throw new Error('Supabase INSERT failed (' + r.status + '): ' + text);
    const data = JSON.parse(text);
    return Array.isArray(data) ? data[0] || null : data;
  }

  async function sbGetOne(table, idValue) {
    const r = await fetch(SUPABASE_URL + '/rest/v1/' + table + '?id=eq.' + encodeURIComponent(idValue) + '&select=*', {
      headers: sbHeaders,
    });
    const text = await r.text();
    if (!r.ok) throw new Error('Supabase GET failed (' + r.status + '): ' + text);
    const data = JSON.parse(text);
    return Array.isArray(data) ? data[0] || null : data;
  }

  try {
    switch (action) {

      // ── UPDATE A SINGLE FIELD ─────────────────────────────────────────────
      case 'update_field': {
        if (!id)    return fail('id param is required', 400);
        if (!field) return fail('field param is required', 400);
        const patch = {};
        patch[field] = value || null;
        const row = await sbPatch('properties', 'id', id, patch);
        return ok(row);
      }

      // ── UPDATE STATUS ─────────────────────────────────────────────────────
      case 'update_status': {
        if (!id)    return fail('id param is required', 400);
        if (!value) return fail('value param is required', 400);
        const row = await sbPatch('properties', 'id', id, { status: value });
        return ok(row);
      }

      // ── APPEND TO SELLER NOTES ────────────────────────────────────────────
      case 'add_note': {
        if (!id)    return fail('id param is required', 400);
        if (!value) return fail('value param is required (note text)', 400);
        const existing = await sbGetOne('properties', id);
        if (!existing) return fail('Property not found: ' + id, 404);
        const timestamp = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
        const prevNotes = existing.seller_notes || '';
        const newNotes  = prevNotes
          ? prevNotes + '\n\n[' + timestamp + '] ' + value
          : '[' + timestamp + '] ' + value;
        const row = await sbPatch('properties', 'id', id, { seller_notes: newNotes });
        return ok(row);
      }

      // ── INSERT ACTIVITY LOG ENTRY ─────────────────────────────────────────
      case 'insert_activity': {
        if (!id)    return fail('id param is required (property id)', 400);
        if (!entry) return fail('entry param is required', 400);
        const row = await sbInsert('activity_log', { property_id: id, entry });
        return ok(row);
      }

      // ── INSERT NEW PROPERTY ───────────────────────────────────────────────
      case 'insert_property': {
        const dataParam = params.data || '';
        if (!dataParam) return fail('data param is required (JSON string)', 400);
        let propertyData;
        try { propertyData = JSON.parse(dataParam); }
        catch (e) { return fail('data param is not valid JSON: ' + e.message, 400); }
        const row = await sbInsert('properties', propertyData);
        return ok(row);
      }

      // ── INSERT KNOWLEDGE ENTRY ────────────────────────────────────────────
      case 'insert_knowledge': {
        const title    = params.title    || '';
        const category = params.category || '';
        if (!title) return fail('title param is required', 400);
        if (!value) return fail('value param is required (content)', 400);
        const row = await sbInsert('knowledge', { category: category || null, title, content: value });
        return ok(row);
      }

      default:
        return fail('Unknown action: ' + (action || '(none)') + '. Valid: update_field, update_status, add_note, insert_activity, insert_property, insert_knowledge', 400);
    }

  } catch (e) {
    console.error('[crm-action] exception:', e.message);
    return fail(e.message, 500);
  }
};

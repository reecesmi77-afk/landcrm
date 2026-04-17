// push-contact.js — search-before-create + direct PATCH via quoContactId
const QUO_BASE = 'https://api.openphone.com/v1';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method not allowed' };

  const apiKey = process.env.QUO_API_KEY;
  if (!apiKey) return { statusCode: 500, headers, body: JSON.stringify({ error: 'QUO_API_KEY not set' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { name, phone, notes, county, state, acreage, email, contactId, quoContactId } = body;
  if (!name || !phone) return { statusCode: 400, headers, body: JSON.stringify({ error: 'name and phone required' }) };

  // Normalise to E.164 — strip everything non-digit
  const digits = String(phone).replace(/\D/g, '');
  let e164;
  if (digits.length === 10) e164 = `+1${digits}`;
  else if (digits.length === 11 && digits[0] === '1') e164 = `+${digits}`;
  else e164 = `+${digits}`;

  // Name parsing — split on FIRST space only
  const trimmedName = name.trim();
  const spaceIdx = trimmedName.indexOf(' ');
  const firstName = spaceIdx > 0 ? trimmedName.slice(0, spaceIdx) : trimmedName;
  const lastName = spaceIdx > 0 ? trimmedName.slice(spaceIdx + 1) : '';

  // Build company field from county + state | notes
  const details = [];
  if (county && state) details.push(`${county}, ${state}`);
  if (acreage) details.push(`${acreage} acres`);
  if (notes) details.push(notes.slice(0, 80));
  const company = details.join(' | ') || '';

  const quoHeaders = {
    'Authorization': apiKey,
    'Content-Type': 'application/json',
  };

  const contactFields = {
    defaultFields: {
      firstName,
      lastName,
      ...(company ? { company } : {}),
      ...(email ? { emails: [{ name: 'email', value: email }] } : {}),
    }
  };

  console.log(`push-contact: "${firstName} ${lastName}" → ${e164}${quoContactId ? ` (quoId: ${quoContactId})` : ''}`);

  try {
    // ── Fast path: if caller already knows the OpenPhone contact ID, PATCH directly ──
    if (quoContactId) {
      const patchRes = await fetch(`${QUO_BASE}/contacts/${quoContactId}`, {
        method: 'PATCH',
        headers: quoHeaders,
        body: JSON.stringify(contactFields),
      });
      const patchData = await patchRes.json();
      if (patchData?.data?.id) {
        console.log('Direct PATCH succeeded:', quoContactId);
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, action: 'updated', id: quoContactId, name: `${firstName} ${lastName}` }) };
      }
      // Contact no longer exists in OpenPhone — fall through to search/create
      console.log(`Direct PATCH failed for ${quoContactId} — falling back to search`);
    }

    // ── Search for existing contact by phone number ──
    const searchRes = await fetch(
      `${QUO_BASE}/contacts?phoneNumber=${encodeURIComponent(e164)}&maxResults=1`,
      { headers: quoHeaders }
    );
    const searchData = await searchRes.json();
    console.log('Search result:', JSON.stringify(searchData?.data?.length), 'contacts found');

    // Verify the returned contact actually owns this phone number
    const toDigits = s => String(s || '').replace(/\D/g, '');
    const e164Digits = toDigits(e164);
    const candidate = searchData?.data?.[0];
    const phoneMatch = candidate?.defaultFields?.phoneNumbers?.some(
      p => toDigits(p.value) === e164Digits
    );
    const existing = phoneMatch ? candidate : null;

    if (!existing && candidate) {
      console.log(`Search returned contact ${candidate.id} but phone numbers do not match ${e164} — creating new`);
    }

    if (existing) {
      // Update existing — confirmed phone number match
      const patchRes = await fetch(`${QUO_BASE}/contacts/${existing.id}`, {
        method: 'PATCH',
        headers: quoHeaders,
        body: JSON.stringify(contactFields),
      });
      const patchData = await patchRes.json();
      console.log('Updated contact:', existing.id, JSON.stringify(patchData).slice(0, 200));
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, action: 'updated', id: existing.id, name: `${firstName} ${lastName}` }) };

    } else {
      // Create new — include phoneNumbers in defaultFields
      const createBody = {
        defaultFields: {
          firstName,
          lastName,
          ...(company ? { company } : {}),
          phoneNumbers: [{ name: 'mobile', value: e164 }],
          ...(email ? { emails: [{ name: 'email', value: email }] } : {}),
        },
        source: 'public-api',
        ...(contactId ? { externalId: String(contactId) } : {}),
      };

      console.log('Creating:', JSON.stringify(createBody));
      const createRes = await fetch(`${QUO_BASE}/contacts`, {
        method: 'POST',
        headers: quoHeaders,
        body: JSON.stringify(createBody),
      });
      const createData = await createRes.json();
      console.log('Create result:', JSON.stringify(createData).slice(0, 300));

      if (createData?.data?.id) {
        return { statusCode: 201, headers, body: JSON.stringify({ ok: true, action: 'created', id: createData.data.id, name: `${firstName} ${lastName}` }) };
      } else {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: false, quoError: createData, sentBody: createBody }) };
      }
    }

  } catch (err) {
    console.error('push-contact error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

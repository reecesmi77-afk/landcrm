// push-contact.js — fixed name parsing + phone matching
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

  const { name, phone, notes, county, state, acreage, email, contactId } = body;
  if (!name || !phone) return { statusCode: 400, headers, body: JSON.stringify({ error: 'name and phone required' }) };

  // Normalise to E.164 — strip everything non-digit
  const digits = String(phone).replace(/\D/g, '');
  let e164;
  if (digits.length === 10) e164 = `+1${digits}`;
  else if (digits.length === 11 && digits[0] === '1') e164 = `+${digits}`;
  else e164 = `+${digits}`;

  // Fix name parsing — only split on FIRST space to get first/last
  // "Test Lead" → firstName: "Test", lastName: "Lead"
  // "William" → firstName: "William", lastName: ""
  // "Mary Jane Watson" → firstName: "Mary", lastName: "Jane Watson"
  const trimmedName = name.trim();
  const spaceIdx = trimmedName.indexOf(' ');
  const firstName = spaceIdx > 0 ? trimmedName.slice(0, spaceIdx) : trimmedName;
  const lastName = spaceIdx > 0 ? trimmedName.slice(spaceIdx + 1) : '';

  // Build company/notes field
  const details = [];
  if (county && state) details.push(`${county}, ${state}`);
  if (acreage) details.push(`${acreage} acres`);
  if (notes) details.push(notes.slice(0, 80));
  const company = details.join(' | ') || '';

  const quoHeaders = {
    'Authorization': apiKey,
    'Content-Type': 'application/json',
  };

  console.log(`push-contact: "${firstName} ${lastName}" → ${e164}`);

  try {
    // Search for existing contact by phone number
    const searchRes = await fetch(
      `${QUO_BASE}/contacts?phoneNumber=${encodeURIComponent(e164)}&maxResults=1`,
      { headers: quoHeaders }
    );
    const searchData = await searchRes.json();
    console.log('Search result:', JSON.stringify(searchData?.data?.length), 'contacts found');

    // Verify the returned contact actually owns this phone number — the OpenPhone
    // search API can return a stale/unrelated contact when no real match exists.
    // Normalise both sides to digits-only for comparison.
    const toDigits = s => String(s || '').replace(/\D/g, '');
    const e164Digits = toDigits(e164);
    const candidate = searchData?.data?.[0];
    const phoneMatch = candidate?.defaultFields?.phoneNumbers?.some(
      p => toDigits(p.value) === e164Digits
    );
    const existing = phoneMatch ? candidate : null;

    if (!existing && candidate) {
      console.log(`Search returned contact ${candidate.id} but its phone numbers do not match ${e164} — will create new contact instead`);
    }

    const contactFields = {
      defaultFields: {
        firstName,
        lastName,
        ...(company ? { company } : {}),
        ...(email ? { emails: [{ name: 'email', value: email }] } : {}),
      }
    };

    if (existing) {
      // Update existing — confirmed phone number match
      const patchRes = await fetch(`${QUO_BASE}/contacts/${existing.id}`, {
        method: 'PATCH',
        headers: quoHeaders,
        body: JSON.stringify(contactFields)
      });
      const patchData = await patchRes.json();
      console.log('Updated contact:', existing.id, JSON.stringify(patchData).slice(0, 200));
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, action: 'updated', id: existing.id, name: `${firstName} ${lastName}` }) };

    } else {
      // Create new — must include phoneNumbers in defaultFields
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
        body: JSON.stringify(createBody)
      });
      const createData = await createRes.json();
      console.log('Create result:', JSON.stringify(createData).slice(0, 300));

      if (createData?.data?.id) {
        return { statusCode: 201, headers, body: JSON.stringify({ ok: true, action: 'created', id: createData.data.id, name: `${firstName} ${lastName}` }) };
      } else {
        // Return full error so we can debug
        return { statusCode: 200, headers, body: JSON.stringify({ ok: false, quoError: createData, sentBody: createBody }) };
      }
    }

  } catch (err) {
    console.error('push-contact error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

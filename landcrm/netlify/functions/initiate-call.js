// initiate-call.js
// Initiates an outbound call via Quo (OpenPhone) API
// Called from the Pre-Call Brief "Call now" button

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const QUO_KEY = process.env.QUO_API_KEY;
  const QUO_PNID = process.env.QUO_PHONE_NUMBER_ID;

  if (!QUO_KEY || !QUO_PNID) {
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: false, error: 'Quo not configured' })
    };
  }

  let body;
  try { body = JSON.parse(event.body); } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Bad JSON' }) };
  }

  const { to, name } = body;
  if (!to) {
    return { statusCode: 400, body: JSON.stringify({ error: 'to phone required' }) };
  }

  try {
    // OpenPhone API — initiate outbound call
    const res = await fetch('https://api.openphone.com/v1/calls', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': QUO_KEY
      },
      body: JSON.stringify({
        to: to,
        from: QUO_PNID
      })
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('Quo call error:', res.status, JSON.stringify(data));
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: false,
          error: data.message || `Quo API error ${res.status}`
        })
      };
    }

    console.log('Call initiated to', to, name, '— call ID:', data.id);
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, callId: data.id })
    };

  } catch(e) {
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: false, error: e.message })
    };
  }
};

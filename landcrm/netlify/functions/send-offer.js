// netlify/functions/send-offer.js
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const payload = JSON.parse(event.body);

    const response = await fetch('https://api.signwell.com/v1/document_templates/documents/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': process.env.SIGNWELL_API_KEY,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: data.error || data.message || 'SignWell error', detail: data }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, id: data.id, data }),
    };

  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message }),
    };
  }
};

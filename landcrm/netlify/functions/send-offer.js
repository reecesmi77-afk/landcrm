// netlify/functions/send-offer.js
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const payload = JSON.parse(event.body);
    console.log('Sending to SignWell:', JSON.stringify(payload).slice(0, 300));

    // SignWell correct API endpoint
    const response = await fetch('https://app.signwell.com/api/v1/document_templates/documents/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': process.env.SIGNWELL_API_KEY,
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    console.log('SignWell status:', response.status);
    console.log('SignWell response:', text.slice(0, 500));

    let data;
    try { data = JSON.parse(text); } catch(e) { data = { raw: text }; }

    if (!response.ok) {
      return {
        statusCode: 200,
        body: JSON.stringify({ error: data.error || data.message || text, detail: data }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, id: data.id, data }),
    };

  } catch (e) {
    console.log('Exception:', e.message);
    return {
      statusCode: 200,
      body: JSON.stringify({ error: e.message }),
    };
  }
};

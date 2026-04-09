// netlify/functions/send-offer.js
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const body = JSON.parse(event.body);
    const { sellerName, sellerEmail, apn, acreage, county, state, purchasePrice, agreementDate, acceptanceDeadline } = body;

    // SignWell template document format - no pre-filled fields
    // Fields will be filled by the signer directly
    const payload = {
      test_mode: false,
      template_id: body.template_id,
      subject: body.subject,
      message: body.message,
      recipients: [
        {
          id: 'seller',
          name: sellerName,
          email: sellerEmail,
          placeholder_name: 'Seller',
        }
      ],
    };

    console.log('Sending to SignWell:', JSON.stringify(payload).slice(0, 500));

    const response = await fetch('https://www.signwell.com/api/v1/document_templates/documents/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': process.env.SIGNWELL_API_KEY,
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    console.log('Status:', response.status);
    console.log('Response:', text.slice(0, 500));

    let data;
    try { data = JSON.parse(text); } catch(e) { data = { raw: text }; }

    if (!response.ok) {
      return {
        statusCode: 200,
        body: JSON.stringify({ error: JSON.stringify(data.errors || data.error || data) }),
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

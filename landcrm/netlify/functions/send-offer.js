// netlify/functions/send-offer.js
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const body = JSON.parse(event.body);

    // SignWell API format for template fields:
    // fields is an array of objects with api_id and value
    // Each recipient gets their own fields array keyed by placeholder_name
    const { sellerName, sellerEmail, apn, acreage, county, state, purchasePrice, agreementDate, acceptanceDeadline } = body;

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
      fields: [
        { api_id: 'seller_name',          value: sellerName },
        { api_id: 'seller_name_top',      value: sellerName },
        { api_id: 'seller_email',         value: sellerEmail },
        { api_id: 'apn',                  value: apn || '' },
        { api_id: 'acreage',              value: acreage || '' },
        { api_id: 'county',               value: county || '' },
        { api_id: 'state',                value: state || '' },
        { api_id: 'purchase_price',       value: purchasePrice || '' },
        { api_id: 'agreement_date',       value: agreementDate || '' },
        { api_id: 'acceptance_deadline',  value: acceptanceDeadline || '' },
      ]
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

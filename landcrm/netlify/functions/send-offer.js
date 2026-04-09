// netlify/functions/send-offer.js
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const body = JSON.parse(event.body);
    const { sellerName, sellerEmail, apn, acreage, county, state, purchasePrice, agreementDate, acceptanceDeadline } = body;

    // If seller email is same as sender, use send_to_signing_order instead
    const senderEmail = 'wsmith@coldwaterpropertygroup.com';
    const recipients = [
      {
        id: 'seller',
        name: sellerName,
        email: sellerEmail,
        placeholder_name: 'Seller',
      }
    ];

    // Only add sender as recipient if different email
    if (sellerEmail.toLowerCase() !== senderEmail.toLowerCase()) {
      recipients.push({
        id: 'sender',
        name: 'William Smith',
        email: senderEmail,
        placeholder_name: 'Document Sender',
      });
    }

    const payload = {
      test_mode: false,
      template_id: body.template_id,
      subject: body.subject,
      message: body.message,
      recipients,
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

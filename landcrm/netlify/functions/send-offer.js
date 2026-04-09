// netlify/functions/send-offer.js
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const body = JSON.parse(event.body);
    const { sellerName, sellerEmail, sellerPhone, sellerAddress, sellerCityStateZip,
            apn, acreage, county, state, purchasePrice, agreementDate, acceptanceDeadline } = body;

    const senderEmail = 'coldwaterpropertygroup@gmail.com';

    const recipients = [
      {
        id: 'seller',
        name: sellerName,
        email: sellerEmail,
        placeholder_name: 'Seller',
      }
    ];

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
      apply_signing_order: true,
      exclude_placeholders: sellerEmail.toLowerCase() === senderEmail.toLowerCase() ? ['Document Sender'] : [],
      recipients,
      template_fields: [
        { api_id: 'seller_name',          value: sellerName           },
        { api_id: 'seller_name_top',      value: sellerName           },
        { api_id: 'seller_email',         value: sellerEmail          },
        { api_id: 'seller_phone',         value: sellerPhone || ''    },
        { api_id: 'seller_address',       value: sellerAddress || ''  },
        { api_id: 'seller_city_state_zip',value: sellerCityStateZip || '' },
        { api_id: 'apn',                  value: apn || ''            },
        { api_id: 'acreage',              value: acreage || ''        },
        { api_id: 'county',               value: county || ''         },
        { api_id: 'state',                value: state || ''          },
        { api_id: 'purchase_price',       value: purchasePrice || ''  },
        { api_id: 'agreement_date',       value: agreementDate || ''  },
        { api_id: 'acceptance_deadline',  value: acceptanceDeadline || '' },
      ],
    };

    console.log('Sending to SignWell:', JSON.stringify(payload).slice(0, 600));

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
    console.log('Response:', text.slice(0, 600));

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

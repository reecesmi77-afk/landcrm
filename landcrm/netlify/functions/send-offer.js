// netlify/functions/send-offer.js
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const body = JSON.parse(event.body);
    console.log('send-offer body:', JSON.stringify(body));
    const {
      sellerName, sellerEmail, sellerPhone, sellerAddress, sellerCityStateZip,
      seller2Name, seller2Email, seller2Phone, seller2Address, seller2CityStateZip,
      apn, acreage, county, state, purchasePrice, agreementDate, acceptanceDeadline,
      emdAmount, altClosingDate, additionalNotes
    } = body;

    const senderEmail = 'coldwaterpropertygroup@gmail.com';
    const effectiveSenderEmail = sellerEmail.toLowerCase() === senderEmail.toLowerCase()
      ? 'wsmith+cw@coldwaterpropertygroup.com'
      : senderEmail;

    const hasSeller2 = seller2Email && seller2Email.trim().length > 0;

    const recipients = [{ name: sellerName, email: sellerEmail }];
    if (hasSeller2) {
      recipients.push({ name: seller2Name || 'Co-Seller', email: seller2Email.trim() });
    }

    const templateFields = [
      { api_id: 'agreement_date',        value: agreementDate || '' },
      { api_id: 'acceptance_deadline',   value: acceptanceDeadline || '' },
      { api_id: 'seller_name_top',       value: sellerName || '' },
      { api_id: 'apn',                   value: apn || '' },
      { api_id: 'state',                 value: state || '' },
      { api_id: 'county',                value: county || '' },
      { api_id: 'acreage',               value: acreage || '' },
      { api_id: 'purchase_price',        value: purchasePrice || '' },
      { api_id: 'emd_amount',            value: emdAmount || '$200.00' },
      { api_id: 'alt_closing_date',      value: ' ' },
      { api_id: 'additional_notes',      value: body.legalDescription || body.additionalNotes || ' ' },
      { api_id: 'seller_name',           value: sellerName || '' },
      { api_id: 'seller_email',          value: sellerEmail || '' },
      { api_id: 'seller_phone',          value: sellerPhone || '' },
      { api_id: 'seller_address',        value: sellerAddress || '' },
      { api_id: 'seller_city_state_zip', value: sellerCityStateZip || '' },
    ];

    // Always include seller2 fields; send single space when empty so placeholders render blank
    templateFields.push(
      { api_id: 'seller2_name_top',       value: seller2Name        || ' ' },
      { api_id: 'seller2_name',           value: seller2Name        || ' ' },
      { api_id: 'seller2_phone',          value: seller2Phone       || ' ' },
      { api_id: 'seller2_email',          value: seller2Email       || ' ' },
      { api_id: 'seller2_address',        value: seller2Address     || ' ' },
      { api_id: 'seller2_city_state_zip', value: seller2CityStateZip || ' ' }
    );

    const payload = {
      test_mode: false,
      template_id: body.template_id,
      subject: body.subject,
      message: body.message,
      apply_signing_order: true,
      recipients,
      template_fields: templateFields,
    };

    console.log('Sending to SignWell:', JSON.stringify(payload).slice(0, 800));

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

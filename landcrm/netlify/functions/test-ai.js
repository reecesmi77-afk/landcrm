// TEMPORARY TEST FILE — delete after testing
// Visit: https://dealflow-crm.netlify.app/.netlify/functions/test-ai
// This directly calls the AI responder to verify it works

exports.handler = async (event) => {
  const testPhone = event.queryStringParameters?.phone || '+19015550000';
  const testMessage = event.queryStringParameters?.msg || 'Yes I own the land';

  console.log('Test: calling ai-sms-responder with', testPhone, testMessage);

  try {
    const url = 'https://dealflow-crm.netlify.app/.netlify/functions/ai-sms-responder';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: testPhone, message: testMessage })
    });

    const text = await res.text();
    console.log('AI responder status:', res.status);
    console.log('AI responder response:', text);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: res.status,
        response: text,
        tested: { phone: testPhone, message: testMessage }
      }, null, 2)
    };
  } catch (e) {
    console.error('Test error:', e.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message })
    };
  }
};

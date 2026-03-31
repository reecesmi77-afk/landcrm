// TEMPORARY HELPER — delete after use
// Fetches your Quo phone number IDs so you can find the PN... value

exports.handler = async (event) => {
  const QUO_API_KEY = process.env.QUO_API_KEY;

  if (!QUO_API_KEY) {
    return {
      statusCode: 200,
      body: 'QUO_API_KEY not set in Netlify environment variables'
    };
  }

  try {
    const res = await fetch('https://api.openphone.com/v1/phone-numbers', {
      headers: {
        'Authorization': QUO_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    const data = await res.json();

    // Format for easy reading
    const numbers = (data.data || []).map(n => ({
      id: n.id,
      number: n.number,
      name: n.name || 'unnamed'
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ numbers }, null, 2)
    };

  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message })
    };
  }
};

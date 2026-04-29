exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { url } = body;

  if (!url || !url.startsWith('https://dealflow-crm.netlify.app/.netlify/functions/crm-')) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden URL' }) };
  }

  const response = await fetch(url);
  const data = await response.text();

  return {
    statusCode: response.status,
    headers: { 'Content-Type': 'application/json' },
    body: data
  };
};

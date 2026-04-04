// gmail-auth-callback.js
// Handles OAuth callback from Google — exchanges code for tokens
// Stores refresh token in Netlify environment (manual step) or returns it to UI

exports.handler = async (event) => {
  const { code, error } = event.queryStringParameters || {};

  if (error) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: `<html><body style="font-family:sans-serif;padding:40px;background:#0d1117;color:#e6edf3">
        <h2 style="color:#f87171">Gmail auth failed</h2>
        <p>${error}</p>
        <a href="https://dealflow-crm.netlify.app" style="color:#0ea5e9">← Back to CRM</a>
      </body></html>`
    };
  }

  if (!code) {
    return { statusCode: 400, body: 'No auth code received' };
  }

  const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
  const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
  const REDIRECT_URI = process.env.GMAIL_REDIRECT_URI;

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });

    const tokens = await tokenRes.json();

    if (tokens.error) {
      throw new Error(tokens.error_description || tokens.error);
    }

    console.log('Gmail tokens received. Refresh token:', tokens.refresh_token ? 'YES' : 'NO');
    console.log('IMPORTANT: Add this refresh token to Netlify env as GMAIL_REFRESH_TOKEN:');
    console.log(tokens.refresh_token);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: `<html><body style="font-family:monospace;padding:40px;background:#0d1117;color:#e6edf3">
        <h2 style="color:#0ea5e9">✅ Gmail Connected!</h2>
        <p style="color:#9ab0c8;margin-bottom:20px">Copy the refresh token below and add it to Netlify as <strong style="color:#0ea5e9">GMAIL_REFRESH_TOKEN</strong></p>
        <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:20px">
          <div style="font-size:11px;color:#5a7a99;margin-bottom:8px">REFRESH TOKEN — copy this entire string:</div>
          <div style="word-break:break-all;color:#34d399;font-size:13px">${tokens.refresh_token || 'No refresh token — re-run auth with prompt=consent'}</div>
        </div>
        <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:20px">
          <div style="font-size:11px;color:#5a7a99;margin-bottom:8px">ACCESS TOKEN (expires in 1 hour — use refresh token instead):</div>
          <div style="word-break:break-all;color:#9ab0c8;font-size:11px">${tokens.access_token}</div>
        </div>
        <p style="color:#9ab0c8">After adding GMAIL_REFRESH_TOKEN to Netlify and redeploying, Gmail will work in REI Razor.</p>
        <a href="https://dealflow-crm.netlify.app" style="color:#0ea5e9;font-size:14px">← Back to CRM</a>
      </body></html>`
    };

  } catch(err) {
    console.error('Gmail auth error:', err.message);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: `<html><body style="font-family:sans-serif;padding:40px;background:#0d1117;color:#e6edf3">
        <h2 style="color:#f87171">Auth error</h2>
        <p>${err.message}</p>
        <a href="https://dealflow-crm.netlify.app" style="color:#0ea5e9">← Back to CRM</a>
      </body></html>`
    };
  }
};

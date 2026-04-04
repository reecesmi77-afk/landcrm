// gmail-auth.js
// Initiates Gmail OAuth flow — redirects user to Google consent screen

exports.handler = async (event) => {
  const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
  const REDIRECT_URI = process.env.GMAIL_REDIRECT_URI;

  if (!CLIENT_ID) return { statusCode: 500, body: 'GMAIL_CLIENT_ID not configured' };

  const scopes = [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/userinfo.email',
  ].join(' ');

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: scopes,
    access_type: 'offline',
    prompt: 'consent',
    login_hint: 'coldwaterpropertygroup@gmail.com',
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

  return {
    statusCode: 302,
    headers: { Location: authUrl },
    body: '',
  };
};

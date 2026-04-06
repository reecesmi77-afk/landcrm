// gmail-api.js — fixed date parsing and header extraction

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function getAccessToken() {
  const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
  const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
  const REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;
  if (!REFRESH_TOKEN) throw new Error('GMAIL_REFRESH_TOKEN not configured');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error_description || data.error);
  return data.access_token;
}

function decodeBase64(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function encodeBase64(str) {
  return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Get header value case-insensitively
function getHeader(headers, name) {
  const h = headers.find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

// Format date from Gmail's RFC 2822 format to a clean display string
function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const isThisYear = d.getFullYear() === now.getFullYear();
    if (isToday) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    if (isThisYear) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch(e) {
    return dateStr;
  }
}

function buildEmail({ to, subject, body, replyToMessageId, threadId }) {
  const from = 'coldwaterpropertygroup@gmail.com';
  let hdrs = `From: Coldwater Property Group <${from}>\r\nTo: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=UTF-8\r\n`;
  if (replyToMessageId) hdrs += `In-Reply-To: ${replyToMessageId}\r\nReferences: ${replyToMessageId}\r\n`;
  return encodeBase64(hdrs + '\r\n' + body);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  let body;
  try { body = JSON.parse(event.body); } catch(e) { return { statusCode: 400, body: 'Bad JSON' }; }
  const { action } = body;

  try {
    const token = await getAccessToken();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // ── LIST INBOX ────────────────────────────────────────────────────
    if (action === 'list') {
      const { query = 'in:inbox', maxResults = 25 } = body;
      const listRes = await fetch(`${GMAIL_BASE}/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`, { headers });
      const listData = await listRes.json();
      if (!listData.messages?.length) return { statusCode: 200, body: JSON.stringify({ ok: true, messages: [] }) };

      const messages = await Promise.all(
        listData.messages.map(async (m) => {
          const msgRes = await fetch(`${GMAIL_BASE}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`, { headers });
          const msg = await msgRes.json();
          const hdrs = msg.payload?.headers || [];
          const subject = getHeader(hdrs, 'Subject') || '(no subject)';
          const from = getHeader(hdrs, 'From') || '';
          const date = getHeader(hdrs, 'Date') || '';
          // Clean up from name
          const fromName = from.replace(/"([^"]+)".*/, '$1').replace(/<[^>]+>/, '').trim() || from.split('<')[0].trim() || from;
          return {
            id: msg.id,
            threadId: msg.threadId,
            from: fromName,
            fromFull: from,
            to: getHeader(hdrs, 'To') || '',
            subject,
            date: formatDate(date),
            dateRaw: date,
            snippet: msg.snippet || '',
            unread: (msg.labelIds || []).includes('UNREAD'),
          };
        })
      );
      return { statusCode: 200, body: JSON.stringify({ ok: true, messages }) };
    }

    // ── GET THREAD ────────────────────────────────────────────────────
    if (action === 'getThread') {
      const { threadId } = body;
      const threadRes = await fetch(`${GMAIL_BASE}/threads/${threadId}?format=full`, { headers });
      const thread = await threadRes.json();
      const messages = (thread.messages || []).map(msg => {
        const hdrs = msg.payload?.headers || [];
        let bodyText = '';
        const extractBody = (part) => {
          if (!part) return;
          if (part.mimeType === 'text/plain' && part.body?.data) bodyText = decodeBase64(part.body.data);
          else if (part.mimeType === 'text/html' && part.body?.data && !bodyText) {
            bodyText = decodeBase64(part.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          }
          if (part.parts) part.parts.forEach(extractBody);
        };
        extractBody(msg.payload);
        const from = getHeader(hdrs, 'From') || '';
        const fromName = from.replace(/"([^"]+)".*/, '$1').replace(/<[^>]+>/, '').trim() || from.split('<')[0].trim();
        const date = getHeader(hdrs, 'Date') || '';
        return {
          id: msg.id,
          threadId: msg.threadId,
          from: fromName,
          fromFull: from,
          to: getHeader(hdrs, 'To') || '',
          subject: getHeader(hdrs, 'Subject') || '',
          date: new Date(date).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
          body: bodyText,
          unread: (msg.labelIds || []).includes('UNREAD'),
        };
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true, messages }) };
    }

    // ── SEND EMAIL ────────────────────────────────────────────────────
    if (action === 'send') {
      const { to, subject, body: emailBody, replyToMessageId, threadId } = body;
      if (!to || !subject || !emailBody) return { statusCode: 400, body: JSON.stringify({ error: 'to, subject, body required' }) };
      const raw = buildEmail({ to, subject, body: emailBody, replyToMessageId });
      const payload = { raw };
      if (threadId) payload.threadId = threadId;
      const sendRes = await fetch(`${GMAIL_BASE}/messages/send`, { method: 'POST', headers, body: JSON.stringify(payload) });
      const sendData = await sendRes.json();
      if (sendData.error) throw new Error(sendData.error.message);
      return { statusCode: 200, body: JSON.stringify({ ok: true, messageId: sendData.id, threadId: sendData.threadId }) };
    }

    // ── MARK AS READ ──────────────────────────────────────────────────
    if (action === 'markRead') {
      const { messageId } = body;
      await fetch(`${GMAIL_BASE}/messages/${messageId}/modify`, {
        method: 'POST', headers, body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // ── MARK AS UNREAD ─────────────────────────────────────────────────
    if (action === 'markUnread') {
      const { messageId } = body;
      await fetch(`${GMAIL_BASE}/messages/${messageId}/modify`, {
        method: 'POST', headers, body: JSON.stringify({ addLabelIds: ['UNREAD'] }),
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // ── ARCHIVE ───────────────────────────────────────────────────────
    if (action === 'archive') {
      const { messageId } = body;
      await fetch(`${GMAIL_BASE}/messages/${messageId}/modify`, {
        method: 'POST', headers, body: JSON.stringify({ removeLabelIds: ['INBOX'] }),
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // ── TRASH ─────────────────────────────────────────────────────────
    if (action === 'trash') {
      const { messageId } = body;
      await fetch(`${GMAIL_BASE}/messages/${messageId}/trash`, { method: 'POST', headers });
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // ── SEARCH BY CONTACT EMAIL ───────────────────────────────────────
    if (action === 'searchContact') {
      const { email } = body;
      if (!email) return { statusCode: 400, body: JSON.stringify({ error: 'email required' }) };
      const q = `from:${email} OR to:${email}`;
      const listRes = await fetch(`${GMAIL_BASE}/messages?q=${encodeURIComponent(q)}&maxResults=10`, { headers });
      const listData = await listRes.json();
      if (!listData.messages?.length) return { statusCode: 200, body: JSON.stringify({ ok: true, messages: [] }) };
      const messages = await Promise.all(
        listData.messages.map(async (m) => {
          const msgRes = await fetch(`${GMAIL_BASE}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`, { headers });
          const msg = await msgRes.json();
          const hdrs = msg.payload?.headers || [];
          const date = getHeader(hdrs, 'Date') || '';
          return {
            id: msg.id,
            threadId: msg.threadId,
            from: getHeader(hdrs, 'From') || '',
            subject: getHeader(hdrs, 'Subject') || '(no subject)',
            date: formatDate(date),
            snippet: msg.snippet || '',
            unread: (msg.labelIds || []).includes('UNREAD'),
          };
        })
      );
      return { statusCode: 200, body: JSON.stringify({ ok: true, messages }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action: ' + action }) };

  } catch(err) {
    console.error('Gmail API error:', err.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

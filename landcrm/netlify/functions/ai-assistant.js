// ai-assistant.js
// REI Razor AI Assistant — answers questions and takes actions on CRM data

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;
  if (!CLAUDE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Bad JSON' }) };
  }

  const { message, history, crmContext } = body;
  if (!message) {
    return { statusCode: 400, body: JSON.stringify({ error: 'message required' }) };
  }

  const systemPrompt = `You are REI Razor AI — an intelligent assistant built into the REI Razor CRM for Coldwater Property Group, a land investing company in TN, AR, OK, TX, and MO.

You have full access to the user's live CRM data provided in each message. Use it to answer questions accurately and specifically.

WHAT YOU CAN DO:
1. Answer questions about leads, contacts, pipeline, activity, notes
2. Surface insights — who needs follow-up, who is hot, what's at risk
3. Navigate the CRM — explain where features are and how to use them
4. Take actions — respond with a structured ACTION block when the user wants to do something

TONE: Sharp, direct, helpful. Like a great EA who knows the business cold. No filler phrases. No "Great question!" Just answer.

ACTIONS — when the user asks you to DO something, include this at the END of your response:
[ACTION:{"type":"move_stage","contactId":"xxx","stage":"Qualified"}]
[ACTION:{"type":"log_touch","contactId":"xxx","channel":"Call","outcome":"Answered — not interested","note":"Called, left VM"}]
[ACTION:{"type":"add_note","contactId":"xxx","note":"Seller said taxes are behind by 2 years"}]
[ACTION:{"type":"open_contact","contactId":"xxx"}]
[ACTION:{"type":"run_comps","contactId":"xxx"}]
[ACTION:{"type":"run_brief","contactId":"xxx"}]

FINDING CONTACTS: Match by name (case-insensitive, partial match ok). If ambiguous, list the matches and ask which one.

CRM NAVIGATION GUIDE:
- Contacts/Leads: Sellers view in left sidebar
- Pipeline: Acquisitions or Dispositions boards
- Comps: Click "Run Comps" button on any contact card, or say "run comps on [name]"
- Pre-Call Brief: Click "Brief" button on contact card
- Due Diligence: Inside contact card → DD tab
- Call Script: Inside contact card → Call Script tab
- Offer Calculator: Tools → Offer Calculator, or "Offer Math" button on contact
- Settings: Bottom of left sidebar
- AI Qualified Leads: Dashboard → AI Handoff Queue

Today's date: ${new Date().toLocaleDateString('en-US', {weekday:'long', year:'numeric', month:'long', day:'numeric'})}`;

  // Build messages array
  const messages = [];

  // Add conversation history
  if (history && history.length > 0) {
    history.forEach(h => {
      messages.push({ role: h.role, content: h.content });
    });
  }

  // Add current message with CRM context
  const contextSummary = buildContextSummary(crmContext);
  messages.push({
    role: 'user',
    content: `${message}\n\n---\nLIVE CRM DATA:\n${contextSummary}`
  });

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        system: systemPrompt,
        messages
      })
    });

    if (!res.ok) {
      const err = await res.text();
      return { statusCode: 500, body: JSON.stringify({ error: `Claude API ${res.status}: ${err.slice(0,200)}` }) };
    }

    const data = await res.json();
    const reply = data.content[0].text;

    // Extract any ACTION blocks
    const actionMatches = [...reply.matchAll(/\[ACTION:(\{[^}]+\})\]/g)];
    const actions = actionMatches.map(m => {
      try { return JSON.parse(m[1]); } catch(e) { return null; }
    }).filter(Boolean);

    // Clean reply text (remove action blocks)
    const cleanReply = reply.replace(/\[ACTION:\{[^}]+\}\]/g, '').trim();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, reply: cleanReply, actions })
    };

  } catch(e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: e.message })
    };
  }
};

function buildContextSummary(ctx) {
  if (!ctx) return 'No CRM data provided.';

  const { contacts, stats, currentView } = ctx;
  if (!contacts || !contacts.length) return 'No contacts in CRM yet.';

  // Build a compact but information-rich summary
  const lines = [];

  lines.push(`CURRENT VIEW: ${currentView || 'Dashboard'}`);
  lines.push(`TOTAL CONTACTS: ${contacts.length}`);

  // Pipeline summary
  const byStage = {};
  const byTemp = { hot: [], warm: [], cold: [] };
  const needsAttention = [];
  const recentlyActive = [];
  const noTouches = [];

  contacts.forEach(c => {
    const stage = c.stage || 'New Lead';
    byStage[stage] = (byStage[stage] || 0) + 1;
    const temp = c.temp || 'cold';
    if (byTemp[temp]) byTemp[temp].push(c.name);
    const daysSince = c.lastContact
      ? Math.floor((Date.now() - new Date(c.lastContact).getTime()) / 86400000)
      : 999;
    if (daysSince > 7 && temp !== 'cold') needsAttention.push({ name: c.name, days: daysSince, stage, temp });
    if (daysSince <= 2) recentlyActive.push(c.name);
    if (!c.touches || c.touches.length === 0) noTouches.push(c.name);
  });

  lines.push(`\nPIPELINE STAGES: ${Object.entries(byStage).map(([s,n])=>`${s}(${n})`).join(', ')}`);
  lines.push(`HOT LEADS: ${byTemp.hot.join(', ') || 'none'}`);
  lines.push(`WARM LEADS: ${byTemp.warm.slice(0,5).join(', ') || 'none'}${byTemp.warm.length > 5 ? ` +${byTemp.warm.length-5} more` : ''}`);

  if (needsAttention.length) {
    lines.push(`\nNEEDS FOLLOW-UP (warm/hot, 7+ days no contact):`);
    needsAttention.slice(0,5).forEach(c => {
      lines.push(`  - ${c.name}: ${c.days} days since last contact, stage=${c.stage}, temp=${c.temp}`);
    });
  }

  if (noTouches.length) {
    lines.push(`\nNEVER CONTACTED: ${noTouches.slice(0,5).join(', ')}${noTouches.length > 5 ? ` +${noTouches.length-5} more` : ''}`);
  }

  // Full contact list (compact)
  lines.push(`\nALL CONTACTS:`);
  contacts.forEach(c => {
    const daysSince = c.lastContact
      ? Math.floor((Date.now() - new Date(c.lastContact).getTime()) / 86400000)
      : null;
    const touches = (c.touches || []).length;
    const lastNote = c.notes && c.notes.length ? c.notes[c.notes.length-1].text.slice(0,80) : '';
    const motivation = c.motivation ? c.motivation.slice(0,60) : '';
    lines.push(`  [${c.id}] ${c.name} | ${c.county||'?'}, ${c.state||'?'} | ${c.acreage||'?'}ac | stage=${c.stage||'New Lead'} | temp=${c.temp||'cold'} | touches=${touches} | lastContact=${daysSince!==null?daysSince+'d ago':'never'} | asking=${c.askingPrice?'$'+c.askingPrice:'?'} | source=${c.source||'?'}${motivation?' | motivation: '+motivation:''}${lastNote?' | lastNote: '+lastNote:''}`);
  });

  return lines.join('\n');
}

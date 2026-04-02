// slack-notify.js
// Shared Slack notification utility — called by other functions
// Sends formatted Block Kit messages to any channel

async function sendSlackMessage(channel, blocks, text) {
  const TOKEN = process.env.SLACK_BOT_TOKEN;
  if (!TOKEN) { console.log('[SLACK] No token — skipping:', text); return null; }

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ channel, blocks, text: text || 'REI Razor notification' })
  });

  const data = await res.json();
  if (!data.ok) console.error('[SLACK] Error:', data.error, '| channel:', channel);
  return data.ok ? data.ts : null; // returns message timestamp (used for updates)
}

async function updateSlackMessage(channel, ts, blocks, text) {
  const TOKEN = process.env.SLACK_BOT_TOKEN;
  if (!TOKEN || !ts) return;

  const res = await fetch('https://slack.com/api/chat.update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ channel, ts, blocks, text: text || 'Updated' })
  });
  const data = await res.json();
  if (!data.ok) console.error('[SLACK] Update error:', data.error);
}

// ── MESSAGE BUILDERS ──────────────────────────────────────────────────────────

function buildActionListCard(contact, sequenceFiresAt) {
  const name = contact.name || 'Unknown';
  const county = contact.county ? `${contact.county}, ${contact.state || ''}` : 'Location unknown';
  const acres = contact.acreage ? `${contact.acreage} acres` : 'acreage unknown';
  const asking = contact.askingPrice ? `$${parseInt(contact.askingPrice).toLocaleString()}` : 'no asking price';
  const temp = contact.temp || 'cold';
  const tempEmoji = temp === 'hot' ? '🔥' : temp === 'warm' ? '⚡' : '🧊';
  const leadCo = contact.leadGenCompany || 'Lead Gen Co.';
  const fireTime = sequenceFiresAt ? new Date(sequenceFiresAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' }) : 'soon';

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `📞 Call Before Texting — ${name}`, emoji: true }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Location:*\n${county}` },
        { type: 'mrkdwn', text: `*Acreage:*\n${acres}` },
        { type: 'mrkdwn', text: `*Asking:*\n${asking}` },
        { type: 'mrkdwn', text: `*Temp:*\n${tempEmoji} ${temp}` },
        { type: 'mrkdwn', text: `*Source:*\n${leadCo}` },
        { type: 'mrkdwn', text: `*Sequence fires:*\n⏱ ${fireTime} CT` },
      ]
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Called — Send Sequence', emoji: true },
          style: 'primary',
          action_id: 'called_send_sequence',
          value: JSON.stringify({ contactId: contact.id, phone: contact.phone, name })
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '📵 No Answer — Send Sequence', emoji: true },
          action_id: 'no_answer_send_sequence',
          value: JSON.stringify({ contactId: contact.id, phone: contact.phone, name })
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '❌ Not Interested', emoji: true },
          style: 'danger',
          action_id: 'not_interested',
          value: JSON.stringify({ contactId: contact.id, phone: contact.phone, name })
        }
      ]
    },
    { type: 'divider' }
  ];
}

function buildHotLeadCard(contact, message, isEscalation) {
  const name = contact ? (contact.name || 'Unknown seller') : 'Unknown seller';
  const county = contact ? (contact.county ? `${contact.county}, ${contact.state || ''}` : 'Location unknown') : 'unknown';
  const phone = contact ? (contact.phone || '') : '';
  const header = isEscalation
    ? `🚨 ESCALATION — ${name} still waiting (30 min)`
    : `🔥 SELLER REPLIED — Call Now`;

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: header, emoji: true }
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${name}* — ${county}\n*Their message:* "${message ? message.slice(0, 200) : '...'}"` }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Phone:*\n${phone}` },
        { type: 'mrkdwn', text: `*Temp:*\n${contact?.temp === 'hot' ? '🔥 hot' : contact?.temp === 'warm' ? '⚡ warm' : '🧊 cold'}` }
      ]
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Called Back', emoji: true },
          style: 'primary',
          action_id: 'called_back',
          value: JSON.stringify({ contactId: contact?.id, phone, name })
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '📵 No Answer — AI Handling', emoji: true },
          action_id: 'no_answer_ai',
          value: JSON.stringify({ contactId: contact?.id, phone, name })
        }
      ]
    },
    { type: 'divider' }
  ];
}

function buildSequenceUpdateCard(contact, step, totalSteps, message, status) {
  const name = contact?.name || 'Unknown';
  const statusEmoji = status === 'sent' ? '✅' : status === 'paused' ? '⏸' : status === 'complete' ? '🏁' : '📤';

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${statusEmoji} *${name}* — Sequence step ${step}/${totalSteps} ${status}\n_"${message ? message.slice(0, 120) : ''}..."_`
      }
    }
  ];
}

function buildDailySummaryCard(stats) {
  const { callsNeeded, hotLeads, activeSequences, newLeads, closedDeals, date } = stats;

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `☀️ Good morning — ${date}`, emoji: true }
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `Here's your Coldwater Property Group briefing for today:` }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*📞 Calls to make:*\n${callsNeeded} pre-sequence calls` },
        { type: 'mrkdwn', text: `*🔥 Hot leads:*\n${hotLeads} need follow-up` },
        { type: 'mrkdwn', text: `*📨 Active sequences:*\n${activeSequences} running` },
        { type: 'mrkdwn', text: `*🆕 New leads (24h):*\n${newLeads} added` },
      ]
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: callsNeeded > 0
          ? `*Your first task:* Open \`#action-list\` and work through your calls. Sequences won't fire until you call or the 4-hour window passes.`
          : `*All clear.* No pending calls — check \`#hot-leads\` for any replies needing attention.`
      }
    },
    { type: 'divider' }
  ];
}

module.exports = {
  sendSlackMessage,
  updateSlackMessage,
  buildActionListCard,
  buildHotLeadCard,
  buildSequenceUpdateCard,
  buildDailySummaryCard
};

// Also expose as handler for direct testing
exports.handler = async (event) => {
  return { statusCode: 200, body: JSON.stringify({ ok: true, msg: 'slack-notify utility loaded' }) };
};

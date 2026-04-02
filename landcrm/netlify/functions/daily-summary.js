// daily-summary.js
// Called daily at 8:45am CT by cron-job.org
// Posts morning briefing to #daily-summary

const { sendSlackMessage, buildDailySummaryCard } = require('./slack-notify');

exports.handler = async (event) => {
  // Auth check
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const KEY = process.env.JSONBIN_API_KEY;
  const BIN = process.env.JSONBIN_BIN_ID;
  const CHANNEL = process.env.SLACK_CHANNEL_SUMMARY;

  if (!CHANNEL) return { statusCode: 500, body: 'SLACK_CHANNEL_SUMMARY not set' };

  // Read CRM data
  let record = {};
  if (KEY && BIN) {
    try {
      const res = await fetch(`https://api.jsonbin.io/v3/b/${BIN}/latest`, { headers: { 'X-Master-Key': KEY } });
      const data = await res.json();
      record = data.record || {};
    } catch(e) { console.error('JSONbin read error:', e.message); }
  }

  const sequences = record.sequences || {};
  const conversations = record.conversations || {};
  const crmContacts = record.crmContacts || [];

  // Calculate stats
  const now = Date.now();
  const oneDayAgo = now - 86400000;

  // Active sequences
  const activeSequences = Object.values(sequences).filter(s => s.active).length;

  // Pending pre-call tasks (sequences waiting for call, not yet released)
  const callsNeeded = Object.values(sequences).filter(s =>
    s.active && s.step === 1 && !s.lastSentAt && s.pendingMessage
  ).length;

  // Hot leads — replied in last 24h and not yet handled
  const hotLeads = Object.entries(conversations).filter(([phone, convo]) => {
    const lastMsg = convo.messages?.[convo.messages.length - 1];
    if (!lastMsg) return false;
    const msgTime = new Date(lastMsg.timestamp || 0).getTime();
    return lastMsg.role === 'user' && msgTime > oneDayAgo;
  }).length;

  // New leads added in last 24h
  const newLeads = crmContacts.filter(c => {
    const created = new Date(c.created || 0).getTime();
    return created > oneDayAgo;
  }).length;

  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    timeZone: 'America/Chicago'
  });

  const blocks = buildDailySummaryCard({ callsNeeded, hotLeads, activeSequences, newLeads, date });

  const ts = await sendSlackMessage(CHANNEL, blocks, `Morning briefing — ${date}`);

  console.log('Daily summary sent:', { callsNeeded, hotLeads, activeSequences, newLeads });

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, ts, callsNeeded, hotLeads, activeSequences, newLeads })
  };
};

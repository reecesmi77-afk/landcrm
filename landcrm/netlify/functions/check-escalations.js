// check-escalations.js
// Called every 10 minutes by cron-job.org
// Checks for hot leads not called back within 30 minutes
// Posts escalation alert to #hot-leads

const { sendSlackMessage, buildHotLeadCard } = require('./slack-notify');

exports.handler = async (event) => {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const KEY = process.env.JSONBIN_API_KEY;
  const BIN = process.env.JSONBIN_BIN_ID;
  if (!KEY || !BIN) return { statusCode: 500, body: 'JSONbin not configured' };

  const res = await fetch(`https://api.jsonbin.io/v3/b/${BIN}/latest`, { headers: { 'X-Master-Key': KEY } });
  const data = await res.json();
  const record = data.record || {};

  const hotAlerts = record.hotLeadAlerts || {};
  const crmContacts = record.crmContacts || [];
  const now = Date.now();
  let escalated = 0;

  for (const phone of Object.keys(hotAlerts)) {
    const alert = hotAlerts[phone];
    if (!alert || alert.escalated) continue;
    if (now < alert.escalateAt) continue;

    // 30 minutes have passed — escalate
    const contact = crmContacts.find(c => {
      const cp = (c.phone || '').replace(/\D/g, '');
      const pp = phone.replace(/\D/g, '');
      return cp && pp && (cp === pp || cp === pp.slice(-10) || pp === cp.slice(-10));
    });

    const HOT_CH = process.env.SLACK_CHANNEL_HOT;
    if (HOT_CH) {
      const crmC = contact || { name: alert.name, phone, temp: 'warm' };
      const blocks = buildHotLeadCard(crmC, alert.message, true); // isEscalation = true
      await sendSlackMessage(HOT_CH, blocks, `🚨 ESCALATION — ${alert.name} still waiting`);
      escalated++;
    }

    // Mark escalated so we don't fire again
    hotAlerts[phone].escalated = true;
    hotAlerts[phone].escalatedAt = new Date().toISOString();
  }

  // Also release any sequences past their 4-hour call window
  const sequences = record.sequences || {};
  let autoReleased = 0;

  for (const phone of Object.keys(sequences)) {
    const seq = sequences[phone];
    if (!seq.active) continue;
    if (!seq.callWindowEndsAt) continue;
    if (seq.step > 1 || seq.lastSentAt) continue; // already sent step 1
    if (now < seq.callWindowEndsAt) continue;

    // 4-hour window passed — auto-fire sequence
    const message = seq.pendingMessage || seq.messages?.[0];
    if (!message) continue;

    const QUO_KEY = process.env.QUO_API_KEY;
    const QUO_PNID = process.env.QUO_PHONE_NUMBER_ID;
    if (!QUO_KEY || !QUO_PNID) continue;

    const smsRes = await fetch('https://api.openphone.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': QUO_KEY },
      body: JSON.stringify({ to: [phone], from: QUO_PNID, content: message })
    });

    if (smsRes.ok) {
      seq.lastSentAt = now;
      seq.step = 1;
      seq.nextSendAt = now + 3 * 86400000;
      seq.pendingMessage = null;
      seq.autoReleased = true;
      seq.autoReleasedAt = new Date().toISOString();
      if (!seq.touches) seq.touches = [];
      seq.touches.push({ step: 1, sentAt: new Date().toISOString(), message, status: 'auto-released' });
      autoReleased++;

      // Post to sequences channel
      const SEQ_CH = process.env.SLACK_CHANNEL_SEQUENCES;
      if (SEQ_CH) {
        await sendSlackMessage(SEQ_CH, [
          { type: 'section', text: { type: 'mrkdwn', text: `⏰ *Auto-released:* Sequence started for *${seq.contactName || phone}* — 4-hour call window expired` } }
        ], `Auto-released sequence: ${seq.contactName || phone}`);
      }
    }
  }

  record.hotLeadAlerts = hotAlerts;
  record.sequences = sequences;

  await fetch(`https://api.jsonbin.io/v3/b/${BIN}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': KEY },
    body: JSON.stringify(record)
  });

  console.log('Escalation check:', { escalated, autoReleased });

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, escalated, autoReleased })
  };
};

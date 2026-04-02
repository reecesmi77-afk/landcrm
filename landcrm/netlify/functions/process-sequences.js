// process-sequences.js
const { sendSlackMessage, buildSequenceUpdateCard } = require('./slack-notify');
// Called daily by cron-job.org
// Checks all active sequences, fires next message if due, pauses if replied

function normalisePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}

function isBizHours() {
  const ct = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const h = ct.getHours(), d = ct.getDay();
  return d >= 1 && d <= 5 && h >= 9 && h < 18;
}

function nextBizTimestamp(daysAhead = 3) {
  const ct = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  ct.setDate(ct.getDate() + daysAhead);
  while (ct.getDay() === 0 || ct.getDay() === 6) ct.setDate(ct.getDate() + 1);
  ct.setHours(9, 15, 0, 0);
  return ct.getTime();
}

// Days between steps — stagger naturally
const STEP_DELAYS = [
  3, // step 1 → 2: 3 days
  2, // step 2 → 3: 2 days
  2, // step 3 → 4: 2 days
  2, // step 4 → 5: 2 days
];

async function sendQuoSMS(phone, message) {
  const KEY = process.env.QUO_API_KEY;
  const PNID = process.env.QUO_PHONE_NUMBER_ID;
  if (!KEY || !PNID) { console.log('[DRY RUN]', phone, ':', message.slice(0, 60)); return false; }
  const res = await fetch('https://api.openphone.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': KEY },
    body: JSON.stringify({ to: [phone], from: PNID, content: message })
  });
  if (!res.ok) { console.error('Quo error:', res.status, (await res.text()).slice(0, 200)); return false; }
  return true;
}

async function notifyWilliam(message) {
  const WILLIAM = process.env.WILLIAM_PHONE;
  if (!WILLIAM) return;
  await sendQuoSMS(normalisePhone(WILLIAM), message);
}

exports.handler = async (event) => {
  // Accept GET (from cron) or POST (from manual trigger)
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  if (!isBizHours()) {
    console.log('Outside business hours — skipping sequence processing');
    return { statusCode: 200, body: JSON.stringify({ ok: true, msg: 'outside business hours', processed: 0 }) };
  }

  const KEY = process.env.JSONBIN_API_KEY;
  const BIN = process.env.JSONBIN_BIN_ID;
  if (!KEY || !BIN) return { statusCode: 500, body: JSON.stringify({ error: 'JSONbin not configured' }) };

  // Read bin
  const readRes = await fetch(`https://api.jsonbin.io/v3/b/${BIN}/latest`, { headers: { 'X-Master-Key': KEY } });
  const readData = await readRes.json();
  const record = readData.record || {};
  const sequences = record.sequences || {};
  const conversations = record.conversations || {};

  const now = Date.now();
  let processed = 0, sent = 0, paused = 0, completed = 0;
  const log = [];

  for (const phone of Object.keys(sequences)) {
    const seq = sequences[phone];

    // Skip if not active
    if (!seq.active) continue;

    // Check if they've replied — if so, pause sequence
    const convo = conversations[phone];
    if (convo?.messages?.some(m => m.direction === 'inbound')) {
      seq.active = false;
      seq.paused = true;
      seq.pausedReason = 'replied';
      seq.pausedAt = new Date().toISOString();
      log.push(`PAUSED ${seq.contactName || phone} — replied`);
      paused++;
      continue;
    }

    // Check if opted out
    if (convo?.optOut) {
      seq.active = false;
      seq.pausedReason = 'opted out';
      log.push(`STOPPED ${seq.contactName || phone} — opted out`);
      continue;
    }

    processed++;

    // Check if it's time to send next message
    if (seq.nextSendAt && now < seq.nextSendAt) {
      log.push(`WAITING ${seq.contactName || phone} — next send ${new Date(seq.nextSendAt).toLocaleDateString()}`);
      continue;
    }

    // Determine next step
    const currentStep = seq.step || 1;
    const messages = seq.messages || [];
    const nextStep = currentStep + 1;

    // Send pending message (queued from after-hours)
    let messageToSend = seq.pendingMessage;

    // Or build next sequence message
    if (!messageToSend) {
      if (nextStep > messages.length) {
        // Sequence complete — check if 30 days have passed for re-engage
        const lastTouch = seq.touches?.[seq.touches.length - 1];
        const daysSinceLast = lastTouch?.sentAt
          ? Math.floor((now - new Date(lastTouch.sentAt).getTime()) / 86400000)
          : 999;

        if (daysSinceLast >= 30 && seq.reEngageMessage && !seq.reEngageSent) {
          messageToSend = seq.reEngageMessage;
          seq.reEngageSent = true;
          seq.step = nextStep;
          log.push(`RE-ENGAGE ${seq.contactName || phone}`);
        } else if (seq.reEngageSent) {
          seq.active = false;
          seq.completedAt = new Date().toISOString();
          log.push(`COMPLETE ${seq.contactName || phone} — all messages sent`);

          // Alert in #action-list — sequence exhausted, needs human decision
          const ACTION_CH2 = process.env.SLACK_CHANNEL_ACTION;
          if (ACTION_CH2) {
            try {
              await sendSlackMessage(ACTION_CH2, [
                { type: 'header', text: { type: 'plain_text', text: `🏁 Sequence Complete — No Response`, emoji: true } },
                { type: 'section', text: { type: 'mrkdwn', text: `*${seq.contactName || phone}* — ${seq.county || ''}${seq.state ? ', ' + seq.state : ''}
All 5 messages sent with no reply. Decision needed:` } },
                { type: 'actions', elements: [
                  { type: 'button', text: { type: 'plain_text', text: '📞 Make Personal Call', emoji: true }, style: 'primary', action_id: 'called_back', value: JSON.stringify({ phone, name: seq.contactName }) },
                  { type: 'button', text: { type: 'plain_text', text: '💤 Move to Long Nurture', emoji: true }, action_id: 'no_answer_ai', value: JSON.stringify({ phone, name: seq.contactName }) },
                  { type: 'button', text: { type: 'plain_text', text: '❌ Mark Dead', emoji: true }, style: 'danger', action_id: 'not_interested', value: JSON.stringify({ phone, name: seq.contactName }) }
                ]}
              ], `Sequence complete — no response: ${seq.contactName || phone}`);
            } catch(e) { console.error('Slack complete error:', e.message); }
          }

          completed++;
          continue;
        } else {
          log.push(`WAITING ${seq.contactName || phone} — awaiting 30-day re-engage (${30 - daysSinceLast}d remaining)`);
          continue;
        }
      } else {
        messageToSend = messages[nextStep - 1]; // 0-indexed
        seq.step = nextStep;
      }
    }

    // Send it
    const ok = await sendQuoSMS(phone, messageToSend);

    if (ok) {
      sent++;
      seq.lastSentAt = now;
      seq.pendingMessage = null;

      // Calculate next send time based on step delays
      const delayDays = STEP_DELAYS[seq.step - 2] || 3;
      seq.nextSendAt = nextBizTimestamp(delayDays);

      if (!seq.touches) seq.touches = [];
      seq.touches.push({
        step: seq.step,
        sentAt: new Date().toISOString(),
        message: messageToSend,
        status: 'sent'
      });

      log.push(`SENT step ${seq.step} to ${seq.contactName || phone}`);

      // Post to #sequences
      const SEQ_CH = process.env.SLACK_CHANNEL_SEQUENCES;
      if (SEQ_CH) {
        try {
          const contact = { name: seq.contactName, county: seq.county, state: seq.state };
          const blocks = buildSequenceUpdateCard(contact, seq.step, seq.totalSteps || 5, messageToSend, 'sent');
          await sendSlackMessage(SEQ_CH, blocks, `Sequence step ${seq.step} sent to ${seq.contactName || phone}`);
        } catch(e) { console.error('Slack seq error:', e.message); }
      }

      // Alert William if this is the re-engage
      if (seq.reEngageSent && seq.step > (messages.length || 5)) {
        await notifyWilliam(`🔄 30-day re-engage sent to ${seq.contactName || phone}`);
      }
    } else {
      log.push(`FAILED to send to ${seq.contactName || phone}`);
    }
  }

  record.sequences = sequences;

  // Write back
  await fetch(`https://api.jsonbin.io/v3/b/${BIN}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': KEY },
    body: JSON.stringify(record)
  });

  const result = { ok: true, processed, sent, paused, completed, log };
  console.log('Sequence processing complete:', result);

  return {
    statusCode: 200,
    body: JSON.stringify(result)
  };
};

/**
 * messageSender.js
 *
 * Sends LinkedIn messages to contacts based on their campaign sequence.
 * Runs every 5 minutes. Respects campaign working hours.
 *
 * Three sequences (from campaign.settings.messages):
 *   new                  → trigger: invite_approved_at
 *   existing_no_history  → trigger: msg_sequence_started_at (set at enrichment)
 *   existing_with_history→ trigger: msg_sequence_started_at (set at enrichment)
 *
 * For each sequence, messages are sent in order:
 *   - Step 0: trigger_time + messages[0].delay
 *   - Step 1: msg_sent_at  + messages[1].delay
 *   - Step N: msg_sent_at  + messages[N].delay
 */

const db = require('./db');
const { sendMessage, startDirectMessage } = require('./unipile');

const INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
let timer = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function toMs(delay, unit) {
  const n = parseFloat(delay) || 1;
  switch (String(unit).toLowerCase()) {
    case 'hours': return n * 3600 * 1000;
    case 'weeks': return n * 7 * 24 * 3600 * 1000;
    default:      return n * 24 * 3600 * 1000; // days
  }
}

function substituteTokens(text, contact) {
  return String(text || '')
    .replace(/\{\{first_name\}\}/g, contact.first_name || '')
    .replace(/\{\{last_name\}\}/g,  contact.last_name  || '')
    .replace(/\{\{company\}\}/g,    contact.company    || '');
}

/**
 * Returns true if NOW is within the campaign's working hours.
 * hours = { '1': { on: true, from: '09:00', to: '18:00' }, ... }
 * Keys: 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat, 7=Sun
 */
function isWithinWorkingHours(hours) {
  if (!hours || typeof hours !== 'object') return true;
  const now    = new Date();
  const jsDay  = now.getDay();                       // 0=Sun
  const dayKey = String(jsDay === 0 ? 7 : jsDay);   // 1=Mon..7=Sun
  const d      = hours[dayKey];
  if (!d?.on) return false;
  const [fH, fM] = d.from.split(':').map(Number);
  const [tH, tM] = d.to.split(':').map(Number);
  const nowMins = now.getHours() * 60 + now.getMinutes();
  return nowMins >= fH * 60 + fM && nowMins < tH * 60 + tM;
}

// ── Core logic ────────────────────────────────────────────────────────────────

async function runOnce() {
  try {
    const { rows: campaigns } = await db.query(
      `SELECT id, account_id, settings FROM campaigns WHERE status = 'active'`
    );

    for (const camp of campaigns) {
      const settings = typeof camp.settings === 'string'
        ? JSON.parse(camp.settings) : (camp.settings || {});
      const hours    = settings.hours;
      const messages = settings.messages || {};

      // Skip if outside working hours
      if (!isWithinWorkingHours(hours)) continue;

      await processCampaign(camp, messages);
    }
  } catch (err) {
    console.error('[MsgSender] runOnce error:', err.message);
  }
}

async function processCampaign(camp, messages) {
  const SEQ = [
    { type: 'new',                  key: 'new' },
    { type: 'existing_no_history',  key: 'existing_no_history' },
    { type: 'existing_with_history',key: 'existing_with_history' },
  ];

  for (const { type, key } of SEQ) {
    const seqMsgs = messages[key];
    if (!Array.isArray(seqMsgs) || seqMsgs.length === 0) continue;

    // Find contacts in this sequence with remaining steps
    let contacts;
    if (type === 'new') {
      // Trigger is invite_approved_at
      const { rows } = await db.query(
        `SELECT * FROM contacts
         WHERE campaign_id = $1
           AND msg_sequence = 'new'
           AND invite_approved = true
           AND invite_approved_at IS NOT NULL
           AND msg_step < $2`,
        [camp.id, seqMsgs.length]
      );
      contacts = rows;
    } else {
      // Trigger is msg_sequence_started_at
      const { rows } = await db.query(
        `SELECT * FROM contacts
         WHERE campaign_id = $1
           AND msg_sequence = $2
           AND msg_sequence_started_at IS NOT NULL
           AND msg_step < $3`,
        [camp.id, type, seqMsgs.length]
      );
      contacts = rows;
    }

    for (const contact of contacts) {
      await tryProcessContact(contact, camp, seqMsgs, type);
    }
  }
}

async function tryProcessContact(contact, camp, seqMsgs, seqType) {
  const stepIndex = parseInt(contact.msg_step) || 0;
  const msg = seqMsgs[stepIndex];
  if (!msg) return;

  const delayMs = toMs(msg.delay, msg.unit);

  // Determine the reference time for this step's delay
  let triggerTime;
  if (stepIndex === 0) {
    triggerTime = seqType === 'new'
      ? contact.invite_approved_at
      : contact.msg_sequence_started_at;
  } else {
    triggerTime = contact.msg_sent_at;
  }

  if (!triggerTime) return;

  const sendAtMs = new Date(triggerTime).getTime() + delayMs;
  if (Date.now() < sendAtMs) return; // not time yet

  // Build the message text
  const text = substituteTokens(msg.text, contact);
  if (!text.trim()) return;

  try {
    let chatId = contact.chat_id;

    if (chatId) {
      // Use existing chat
      await sendMessage(camp.account_id, chatId, text);
    } else if (contact.provider_id) {
      // Start a new DM
      const result = await startDirectMessage(camp.account_id, contact.provider_id, text);
      // Save the chat_id for future steps
      chatId = result?.id || result?.chat_id || null;
      if (chatId) {
        await db.query('UPDATE contacts SET chat_id = $1 WHERE id = $2', [chatId, contact.id]);
      }
    } else {
      console.warn(`[MsgSender] contact ${contact.id} has no chat_id or provider_id — skipping`);
      return;
    }

    // Update contact: advance step, mark sent
    await db.query(
      `UPDATE contacts SET
         msg_sent     = true,
         msg_sent_at  = NOW(),
         msg_step     = msg_step + 1
       WHERE id = $1`,
      [contact.id]
    );

    console.log(
      `[MsgSender] Sent step ${stepIndex + 1}/${seqMsgs.length}` +
      ` → contact ${contact.id} (${contact.first_name} ${contact.last_name})` +
      ` · sequence: ${seqType}`
    );
  } catch (err) {
    console.error(`[MsgSender] Failed contact ${contact.id}: ${err.message}`);
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

function start() {
  console.log('[MsgSender] Starting — interval:', INTERVAL_MS / 60000, 'min');
  runOnce();
  timer = setInterval(runOnce, INTERVAL_MS);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, runOnce };

/**
 * messageSender.js
 *
 * Sends LinkedIn messages to contacts based on their campaign sequence.
 * Runs every 5 minutes. Respects campaign working hours.
 *
 * Three sequences (from campaign.settings.messages):
 *   new                   → trigger: invite_approved_at
 *   existing_no_history   → trigger: msg_sequence_started_at
 *   existing_with_history → trigger: msg_sequence_started_at
 *
 * For each sequence, messages are sent in order:
 *   - Step 0: trigger_time + delay ± jitter
 *   - Step N: msg_sent_at  + delay ± jitter
 *
 * JITTER: Each contact gets a random offset of ±20% of the configured delay,
 * seeded from the contact's ID so it stays stable across runs.
 * This ensures messages never go out at predictable identical intervals.
 */

const db = require('./db');
const { sendMessage, startDirectMessage } = require('./unipile');

const INTERVAL_MS  = 5 * 60 * 1000; // every 5 minutes
const JITTER_RATIO = 0.20;           // ±20% of configured delay
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

/**
 * Returns a deterministic but unique jitter multiplier for a given contact + step.
 * Range: (1 - JITTER_RATIO) to (1 + JITTER_RATIO)
 * Using contact ID + step as seed so the jitter stays consistent across restarts.
 * This means each contact always has its own fixed offset — not a new roll every run.
 */
function jitterMultiplier(contactId, stepIndex) {
  // Simple deterministic hash from contactId + stepIndex
  const seed = (parseInt(contactId, 10) * 31 + stepIndex * 17) % 1000;
  const rand  = seed / 1000; // 0.0 → 0.999
  return 1 - JITTER_RATIO + rand * (JITTER_RATIO * 2);
  // Range: 0.80 → 1.20
}

/**
 * Returns the jittered delay in ms for a given contact/step.
 * Example: 1 day delay for contact #42, step 0
 *   → base = 86400000ms, jitter multiplier ~= 0.93 → actual = ~80352000ms (~22.3h)
 */
function jitteredDelayMs(delay, unit, contactId, stepIndex) {
  const base = toMs(delay, unit);
  const mult = jitterMultiplier(contactId, stepIndex);
  return Math.round(base * mult);
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
 * Keys: 1=Mon ... 7=Sun
 */
function isWithinWorkingHours(hours) {
  if (!hours || typeof hours !== 'object') return true;
  const now    = new Date();
  const jsDay  = now.getDay();
  const dayKey = String(jsDay === 0 ? 7 : jsDay);
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

      if (!isWithinWorkingHours(hours)) continue;

      await processCampaign(camp, messages);
    }
  } catch (err) {
    console.error('[MsgSender] runOnce error:', err.message);
  }
}

async function processCampaign(camp, messages) {
  const SEQ = [
    { type: 'new',                   key: 'new' },
    { type: 'existing_no_history',   key: 'existing_no_history' },
    { type: 'existing_with_history', key: 'existing_with_history' },
  ];

  for (const { type, key } of SEQ) {
    const seqMsgs = messages[key];
    if (!Array.isArray(seqMsgs) || seqMsgs.length === 0) continue;

    let contacts;
    if (type === 'new') {
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

  // Apply jitter: each contact+step gets a stable ±20% offset on the delay
  const delayMs = jitteredDelayMs(msg.delay, msg.unit, contact.id, stepIndex);

  // Determine reference time
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

  const text = substituteTokens(msg.text, contact);
  if (!text.trim()) return;

  try {
    let chatId = contact.chat_id;

    if (chatId) {
      await sendMessage(camp.account_id, chatId, text);
    } else if (contact.provider_id) {
      const result = await startDirectMessage(camp.account_id, contact.provider_id, text);
      chatId = result?.id || result?.chat_id || null;
      if (chatId) {
        await db.query('UPDATE contacts SET chat_id = $1 WHERE id = $2', [chatId, contact.id]);
      }
    } else {
      console.warn(`[MsgSender] contact ${contact.id} has no chat_id or provider_id — skipping`);
      return;
    }

    await db.query(
      `UPDATE contacts SET
         msg_sent    = true,
         msg_sent_at = NOW(),
         msg_step    = msg_step + 1
       WHERE id = $1`,
      [contact.id]
    );

    const baseDelay  = toMs(msg.delay, msg.unit);
    const mult       = jitterMultiplier(contact.id, stepIndex);
    console.log(
      `[MsgSender] Sent step ${stepIndex + 1}/${seqMsgs.length}` +
      ` → contact ${contact.id} (${contact.first_name} ${contact.last_name})` +
      ` · sequence: ${seqType}` +
      ` · delay: ${Math.round(delayMs / 3600000 * 10) / 10}h (base ${Math.round(baseDelay / 3600000 * 10) / 10}h × ${Math.round(mult * 100)}%)`
    );
  } catch (err) {
    console.error(`[MsgSender] Failed contact ${contact.id}: ${err.message}`);
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

function start() {
  console.log('[MsgSender] Starting — interval:', INTERVAL_MS / 60000, 'min | jitter: ±' + (JITTER_RATIO * 100) + '%');
  runOnce();
  timer = setInterval(runOnce, INTERVAL_MS);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, runOnce };

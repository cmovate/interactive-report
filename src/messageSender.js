/**
 * messageSender.js
 *
 * Sends LinkedIn messages based on campaign sequences.
 * Runs every 5 minutes. Respects campaign working hours.
 *
 * After each successful send:
 *   - msgs_sent_count is incremented
 *   - msg_1_text through msg_5_text are populated with the actual sent text
 *
 * TIMING STRATEGY
 * ───────────────
 * Each contact gets a scheduled_send_at timestamp computed ONCE when it first
 * becomes eligible for a step. That timestamp is stored in the DB.
 * Every 5-minute run simply queries: WHERE msg_scheduled_send_at <= NOW()
 *
 * JITTER FORMULA
 * ──────────────
 * Actual delay = base_delay + random offset in range [-maxJitterMs, +maxJitterMs]
 * where maxJitterMs defaults to 3 hours.
 * Random extra seconds (0-3599) are added so sends never land on the hour.
 */

const db = require('./db');
const { sendMessage, startDirectMessage } = require('./unipile');

const INTERVAL_MS    = 5 * 60 * 1000;   // poll every 5 minutes
const MAX_JITTER_MS  = 3 * 3600 * 1000; // ±3 hours max jitter
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

function computeScheduledAt(triggerTime, delay, unit) {
  const baseMs   = toMs(delay, unit);
  const jitterMs = (Math.random() * 2 - 1) * MAX_JITTER_MS;
  const extraMs  = Math.floor(Math.random() * 3600) * 1000;
  return new Date(new Date(triggerTime).getTime() + baseMs + jitterMs + extraMs);
}

function substituteTokens(text, contact) {
  return String(text || '')
    .replace(/\{\{first_name\}\}/g, contact.first_name || '')
    .replace(/\{\{last_name\}\}/g,  contact.last_name  || '')
    .replace(/\{\{company\}\}/g,    contact.company    || '');
}

function isWithinWorkingHours(hours) {
  if (!hours || typeof hours !== 'object') return true;
  const now    = new Date();
  const jsDay  = now.getDay();
  const dayKey = String(jsDay === 0 ? 7 : jsDay);
  const d      = hours[dayKey];
  if (!d?.on) return false;
  const [fH, fM] = d.from.split(':').map(Number);
  const [tH, tM] = d.to.split(':').map(Number);
  const nowMins  = now.getHours() * 60 + now.getMinutes();
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
      if (!isWithinWorkingHours(settings.hours)) continue;
      await processCampaign(camp, settings.messages || {});
    }
  } catch (err) {
    console.error('[MsgSender] runOnce error:', err.message);
  }
}

async function processCampaign(camp, messages) {
  const SEQ = [
    { type: 'new',                   triggerCol: 'invite_approved_at',      condition: `invite_approved = true AND invite_approved_at IS NOT NULL` },
    { type: 'existing_no_history',   triggerCol: 'msg_sequence_started_at', condition: `msg_sequence_started_at IS NOT NULL` },
    { type: 'existing_with_history', triggerCol: 'msg_sequence_started_at', condition: `msg_sequence_started_at IS NOT NULL` },
  ];

  for (const seq of SEQ) {
    const seqMsgs = messages[seq.type];
    if (!Array.isArray(seqMsgs) || seqMsgs.length === 0) continue;

    // PHASE 1: schedule contacts that don't yet have a send time
    const { rows: unscheduled } = await db.query(
      `SELECT * FROM contacts
       WHERE campaign_id = $1
         AND msg_sequence = $2
         AND msg_step < $3
         AND msg_scheduled_send_at IS NULL
         AND ${seq.condition}`,
      [camp.id, seq.type, seqMsgs.length]
    );
    for (const contact of unscheduled) {
      const stepIndex   = parseInt(contact.msg_step) || 0;
      const msg         = seqMsgs[stepIndex];
      if (!msg) continue;
      const triggerTime = contact[seq.triggerCol];
      if (!triggerTime) continue;
      const scheduledAt = computeScheduledAt(triggerTime, msg.delay, msg.unit);
      await db.query(
        `UPDATE contacts SET msg_scheduled_send_at = $1 WHERE id = $2`,
        [scheduledAt, contact.id]
      );
      console.log(`[MsgSender] Scheduled contact ${contact.id} step ${stepIndex + 1} → ${scheduledAt.toISOString()}`);
    }

    // PHASE 2: send contacts whose scheduled time has arrived
    const { rows: ready } = await db.query(
      `SELECT * FROM contacts
       WHERE campaign_id = $1
         AND msg_sequence = $2
         AND msg_step < $3
         AND msg_scheduled_send_at IS NOT NULL
         AND msg_scheduled_send_at <= NOW()
         AND ${seq.condition}`,
      [camp.id, seq.type, seqMsgs.length]
    );
    for (const contact of ready) {
      await trySendMessage(contact, camp, seqMsgs, seq.type);
    }
  }
}

async function trySendMessage(contact, camp, seqMsgs, seqType) {
  const stepIndex = parseInt(contact.msg_step) || 0;
  const msg       = seqMsgs[stepIndex];
  if (!msg) return;

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
      console.warn(`[MsgSender] contact ${contact.id} — no chat_id or provider_id, skipping`);
      return;
    }

    // Save message text to the appropriate slot (msg_1_text ... msg_5_text)
    // stepIndex is 0-based: step 0 → msg_1_text, step 4 → msg_5_text
    const slotNum = stepIndex + 1; // 1-5
    const msgTextCol = slotNum <= 5 ? `, msg_${slotNum}_text = $2` : '';
    const updateParams = slotNum <= 5 ? [contact.id, text] : [contact.id];

    await db.query(
      `UPDATE contacts SET
         msg_sent              = true,
         msg_sent_at           = NOW(),
         msg_step              = msg_step + 1,
         msg_scheduled_send_at = NULL,
         msgs_sent_count       = COALESCE(msgs_sent_count, 0) + 1
         ${msgTextCol}
       WHERE id = $1`,
      updateParams
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
  console.log(`[MsgSender] Starting — poll every ${INTERVAL_MS / 60000} min | jitter ±${MAX_JITTER_MS / 3600000}h`);
  runOnce();
  timer = setInterval(runOnce, INTERVAL_MS);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, runOnce };

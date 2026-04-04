/**
 * messageSender.js
 *
 * Sends LinkedIn messages based on campaign sequences.
 * Runs every 5 minutes. Respects campaign working hours.
 *
 * A/B/C VARIANTS
 * ââââââââââââââ
 * Each step can define multiple variants:
 *   { delay: 3, unit: 'days', variants: [
 *     { label: 'A', text: 'Hi {{first_name}}...' },
 *     { label: 'B', text: 'Hello {{first_name}}...' },
 *   ]}
 * A random variant is chosen per contact at send time.
 * Variant label saved to msg_N_variant. Supports up to 20 steps.
 * Backward compatible: if no variants array, falls back to msg.text.
 */

const db = require('./db');
const { sendMessage, startDirectMessage } = require('./unipile');

const INTERVAL_MS    = 5 * 60 * 1000;
const MAX_JITTER_MS  = 3 * 3600 * 1000;
const MAX_SLOTS      = 20;
const MIN_FUTURE_MS  = 60 * 1000; // scheduled time must be at least 1 min in the future
let timer = null;

function toMs(delay, unit) {
  const n = parseFloat(delay) || 1;
  switch (String(unit).toLowerCase()) {
    case 'hours': return n * 3600 * 1000;
    case 'weeks': return n * 7 * 24 * 3600 * 1000;
    default:      return n * 24 * 3600 * 1000;
  }
}

function computeScheduledAt(triggerTime, delay, unit) {
  const baseMs   = toMs(delay, unit);
  const jitterMs = (Math.random() * 2 - 1) * MAX_JITTER_MS;
  const extraMs  = Math.floor(Math.random() * 3600) * 1000;
  const raw      = new Date(triggerTime).getTime() + baseMs + jitterMs + extraMs;
  // Clamp: scheduled time must be at least MIN_FUTURE_MS from now
  return new Date(Math.max(raw, Date.now() + MIN_FUTURE_MS));
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

async function runOnce() {
  try {
    const { rows: campaigns } = await db.query(
      `SELECT id, account_id, settings FROM campaigns WHERE status = 'active'`
    );
    for (const camp of campaigns) {
      const settings = typeof camp.settings === 'string'
        ? JSON.parse(camp.settings) : (camp.settings || {});
      // Working hours only affect scheduling, not sending already-scheduled msgs
      await processCampaign(camp, settings.messages || {}, settings.hours);
    }
  } catch (err) {
    console.error('[MsgSender] runOnce error:', err.message);
  }
}

async function processCampaign(camp, messages, hours) {
  const SEQ = [
    { type: 'new',                   triggerCol: 'invite_approved_at',      condition: `invite_approved = true AND invite_approved_at IS NOT NULL` },
    { type: 'existing_no_history',   triggerCol: 'msg_sequence_started_at', condition: `msg_sequence_started_at IS NOT NULL` },
    { type: 'existing_with_history', triggerCol: 'msg_sequence_started_at', condition: `msg_sequence_started_at IS NOT NULL` },
  ];

  for (const seq of SEQ) {
    const seqMsgs = messages[seq.type];
    if (!Array.isArray(seqMsgs) || seqMsgs.length === 0) continue;

    const { rows: unscheduled } = isWithinWorkingHours(hours) ? await db.query(
      `SELECT * FROM contacts
       WHERE campaign_id = $1 AND msg_sequence = $2 AND msg_step < $3
         AND msg_scheduled_send_at IS NULL AND ${seq.condition}`,
      [camp.id, seq.type, seqMsgs.length]
    ); : { rows: [] };
    for (const contact of unscheduled) {
      const stepIndex   = parseInt(contact.msg_step) || 0;
      const msg         = seqMsgs[stepIndex];
      if (!msg) continue;
      const triggerTime = contact[seq.triggerCol];
      if (!triggerTime) continue;
      const scheduledAt = computeScheduledAt(triggerTime, msg.delay, msg.unit);
      await db.query(`UPDATE contacts SET msg_scheduled_send_at = $1 WHERE id = $2`, [scheduledAt, contact.id]);
      console.log(`[MsgSender] Scheduled contact ${contact.id} step ${stepIndex + 1} â ${scheduledAt.toISOString()}`);
    }

    const { rows: ready } = await db.query(
      `SELECT * FROM contacts
       WHERE campaign_id = $1 AND msg_sequence = $2 AND msg_step < $3
         AND msg_scheduled_send_at IS NOT NULL AND msg_scheduled_send_at <= NOW()
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

  const variants = Array.isArray(msg.variants) && msg.variants.length > 0
    ? msg.variants
    : (msg.text ? [{ label: 'A', text: msg.text }] : []);
  if (!variants.length) return;

  const picked       = variants[Math.floor(Math.random() * variants.length)];
  const variantLabel = (picked.label || 'A').toUpperCase();
  const text         = substituteTokens(picked.text || '', contact);
  if (!text.trim()) return;

  try {
    let chatId = contact.chat_id;
    if (chatId) {
      await sendMessage(camp.account_id, chatId, text);
    } else if (contact.provider_id) {
      const result = await startDirectMessage(camp.account_id, contact.provider_id, text);
      chatId = result?.id || result?.chat_id || null;
      if (chatId) await db.query('UPDATE contacts SET chat_id = $1 WHERE id = $2', [chatId, contact.id]);
    } else {
      console.warn(`[MsgSender] contact ${contact.id} â no chat_id or provider_id, skipping`);
      return;
    }

    const slotNum    = stepIndex + 1;
    const textCol    = slotNum <= MAX_SLOTS ? `, msg_${slotNum}_text = $2`    : '';
    const variantCol = slotNum <= MAX_SLOTS ? `, msg_${slotNum}_variant = $3` : '';
    const updateParams = slotNum <= MAX_SLOTS ? [contact.id, text, variantLabel] : [contact.id];

    await db.query(
      `UPDATE contacts SET
         msg_sent = true, msg_sent_at = NOW(),
         msg_step = msg_step + 1,
         msg_scheduled_send_at = NULL,
         msgs_sent_count = COALESCE(msgs_sent_count, 0) + 1
         ${textCol}${variantCol}
       WHERE id = $1`,
      updateParams
    );

    console.log(
      `[MsgSender] Sent step ${stepIndex + 1}/${seqMsgs.length}` +
      ` â contact ${contact.id} (${contact.first_name} ${contact.last_name})` +
      ` Â· variant: ${variantLabel} Â· sequence: ${seqType}`
    );
  } catch (err) {
    console.error(`[MsgSender] Failed contact ${contact.id}: ${err.message}`);
  }
}

function start() {
  console.log(`[MsgSender] Starting â poll every ${INTERVAL_MS / 60000} min | jitter Â±${MAX_JITTER_MS / 3600000}h | max slots: ${MAX_SLOTS} | A/B/C enabled`);
  runOnce();
  timer = setInterval(runOnce, INTERVAL_MS);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, runOnce };

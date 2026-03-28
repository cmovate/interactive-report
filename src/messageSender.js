/**
 * messageSender.js
 *
 * Sends LinkedIn messages based on campaign sequences.
 * Runs every 5 minutes. Respects campaign working hours.
 *
 * TIMING STRATEGY
 * ───────────────
 * Each contact gets a scheduled_send_at timestamp computed ONCE when it first
 * becomes eligible for a step. That timestamp is stored in the DB.
 * Every 5-minute run simply queries: WHERE msg_scheduled_send_at <= NOW()
 *
 * This is the only correct way to use Math.random() in a polling system —
 * computing it on every poll would reset the window on each run.
 *
 * JITTER FORMULA
 * ──────────────
 * Actual delay = base_delay + random offset in range [-maxJitterMs, +maxJitterMs]
 * where maxJitterMs defaults to 3 hours (10800000 ms).
 *
 * The result is floored to a non-round minute (randomised seconds added)
 * so send times are never on the hour or half-hour.
 *
 * Example — base delay 2 days, jitter ±3h:
 *   contact A → 2d 1h 43m 17s
 *   contact B → 1d 22h 7m 52s
 *   contact C → 2d 2h 51m 4s
 *
 * Three sequences (from campaign.settings.messages):
 *   new                   → trigger: invite_approved_at
 *   existing_no_history   → trigger: msg_sequence_started_at
 *   existing_with_history → trigger: msg_sequence_started_at
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

/**
 * Compute a truly random send timestamp.
 *
 * - Adds a random offset in [-MAX_JITTER_MS, +MAX_JITTER_MS] to the base delay.
 * - Then adds a random 0–59 seconds so the time is never on a clean minute.
 * - Called ONCE per contact per step; result is stored in msg_scheduled_send_at.
 *
 * @param {Date|string} triggerTime  - when the wait period starts
 * @param {number}      delay        - configured delay value
 * @param {string}      unit         - 'hours' | 'days' | 'weeks'
 * @returns {Date}  the scheduled send time
 */
function computeScheduledAt(triggerTime, delay, unit) {
  const baseMs    = toMs(delay, unit);
  // Random offset: uniform in [-MAX_JITTER_MS, +MAX_JITTER_MS]
  const jitterMs  = (Math.random() * 2 - 1) * MAX_JITTER_MS;
  // Random extra seconds (0–3599s) so time is never on the minute
  const extraMs   = Math.floor(Math.random() * 3600) * 1000;
  const totalMs   = baseMs + jitterMs + extraMs;
  return new Date(new Date(triggerTime).getTime() + totalMs);
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
 * Keys: 1=Mon … 7=Sun
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

    // ── PHASE 1: Schedule any contacts that don't yet have a send time ──
    // These are contacts that just became eligible but haven't been scheduled.
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
      const stepIndex  = parseInt(contact.msg_step) || 0;
      const msg        = seqMsgs[stepIndex];
      if (!msg) continue;

      const triggerTime = contact[seq.triggerCol];
      if (!triggerTime) continue;

      const scheduledAt = computeScheduledAt(triggerTime, msg.delay, msg.unit);
      await db.query(
        `UPDATE contacts SET msg_scheduled_send_at = $1 WHERE id = $2`,
        [scheduledAt, contact.id]
      );
      console.log(
        `[MsgSender] Scheduled contact ${contact.id} (${contact.first_name} ${contact.last_name})` +
        ` step ${stepIndex + 1} → ${scheduledAt.toISOString()}` +
        ` (base ${msg.delay} ${msg.unit} + jitter ±${MAX_JITTER_MS / 3600000}h)`
      );
    }

    // ── PHASE 2: Send any contacts whose scheduled time has arrived ──
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

    // Advance step + clear scheduled_send_at so next step will be freshly scheduled
    await db.query(
      `UPDATE contacts SET
         msg_sent              = true,
         msg_sent_at           = NOW(),
         msg_step              = msg_step + 1,
         msg_scheduled_send_at = NULL
       WHERE id = $1`,
      [contact.id]
    );

    console.log(
      `[MsgSender] Sent step ${stepIndex + 1}/${seqMsgs.length}` +
      ` → contact ${contact.id} (${contact.first_name} ${contact.last_name})` +
      ` · sequence: ${seqType}` +
      ` · was scheduled: ${contact.msg_scheduled_send_at}`
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

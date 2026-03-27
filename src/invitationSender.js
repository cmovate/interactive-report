/**
 * Invitation Sender — runs periodically and sends LinkedIn connection requests.
 *
 * Logic:
 *   For each active campaign:
 *     1. Check working hours (from account settings)
 *     2. Check daily limit (how many already sent today)
 *     3. Send up to N invitations with random delay between each
 *     4. Mark invite_sent = true + invite_sent_at = now
 *
 * Scheduled: runs every 15 minutes via setInterval.
 * Random delay between invitations: 30–90 seconds (human-like pacing).
 */

const db = require('./db');
const { sendInvitation } = require('./unipile');

// Default limits/hours if account has no saved settings
const DEFAULT_DAILY_LIMIT  = 20;
const DEFAULT_WORKING_HOURS = {
  1: { on: true,  from: '09:00', to: '18:00' }, // Mon
  2: { on: true,  from: '09:00', to: '18:00' }, // Tue
  3: { on: true,  from: '09:00', to: '18:00' }, // Wed
  4: { on: true,  from: '09:00', to: '18:00' }, // Thu
  5: { on: true,  from: '09:00', to: '18:00' }, // Fri
  6: { on: false, from: '09:00', to: '18:00' }, // Sat
  7: { on: false, from: '09:00', to: '18:00' }, // Sun
};

// State: track which accounts are currently sending (prevent overlap)
const activelySending = new Set();

// ── Public API ────────────────────────────────────────────────────────────────

function start() {
  console.log('[InvitationSender] Started — checking every 15 minutes');
  run(); // Run immediately on startup
  setInterval(run, 15 * 60 * 1000); // Then every 15 min
}

// ── Main runner ───────────────────────────────────────────────────────────────

async function run() {
  console.log('[InvitationSender] Running check...');
  try {
    // Get all active campaigns with their account info
    const { rows: campaigns } = await db.query(`
      SELECT c.id, c.account_id, c.name, c.workspace_id,
             c.settings,
             ua.status as account_status
      FROM campaigns c
      JOIN unipile_accounts ua ON ua.account_id = c.account_id
      WHERE c.status = 'active'
    `);

    if (!campaigns.length) {
      console.log('[InvitationSender] No active campaigns');
      return;
    }

    // Group by account to respect per-account limits
    const byAccount = {};
    for (const camp of campaigns) {
      if (!byAccount[camp.account_id]) byAccount[camp.account_id] = [];
      byAccount[camp.account_id].push(camp);
    }

    for (const [accountId, accountCampaigns] of Object.entries(byAccount)) {
      // Skip if this account is already sending
      if (activelySending.has(accountId)) {
        console.log(`[InvitationSender] Account ${accountId} already sending, skipping`);
        continue;
      }

      // Get account settings (saved in unipile_accounts.settings JSONB)
      const { rows: accRows } = await db.query(
        'SELECT settings FROM unipile_accounts WHERE account_id = $1',
        [accountId]
      );
      const settings = accRows[0]?.settings || {};

      // Check working hours
      if (!isWithinWorkingHours(settings)) {
        console.log(`[InvitationSender] Account ${accountId} outside working hours, skipping`);
        continue;
      }

      // Check daily limit
      const dailyLimit  = settings.limits?.connection_requests ?? DEFAULT_DAILY_LIMIT;
      const sentToday   = await countSentToday(accountId);
      const canSend     = dailyLimit - sentToday;

      if (canSend <= 0) {
        console.log(`[InvitationSender] Account ${accountId} reached daily limit (${dailyLimit}), skipping`);
        continue;
      }

      console.log(`[InvitationSender] Account ${accountId}: ${sentToday}/${dailyLimit} sent today, can send ${canSend} more`);

      // Collect contacts to invite across all campaigns for this account
      const contacts = await getPendingContacts(accountId, canSend);
      if (!contacts.length) {
        console.log(`[InvitationSender] Account ${accountId}: no pending contacts`);
        continue;
      }

      // Send invitations in background (don't await — non-blocking)
      sendBatch(accountId, contacts);
    }
  } catch (err) {
    console.error('[InvitationSender] Error in run():', err.message);
  }
}

// ── Batch sender ──────────────────────────────────────────────────────────────

async function sendBatch(accountId, contacts) {
  activelySending.add(accountId);
  console.log(`[InvitationSender] Starting batch for account ${accountId}: ${contacts.length} contacts`);

  for (const contact of contacts) {
    try {
      const identifier = extractIdentifier(contact.li_profile_url);
      if (!identifier) {
        console.warn(`[InvitationSender] Cannot extract identifier from: ${contact.li_profile_url}`);
        continue;
      }

      // Send the invitation
      await sendInvitation(accountId, contact.li_profile_url);

      // Mark as sent in DB
      await db.query(
        'UPDATE contacts SET invite_sent = true, invite_sent_at = NOW() WHERE id = $1',
        [contact.id]
      );

      console.log(`[InvitationSender] ✓ Sent invitation to ${identifier} (contact ${contact.id}, campaign ${contact.campaign_id})`);

      // Random delay 30–90 seconds between invitations
      const delay = 30000 + Math.random() * 60000;
      console.log(`[InvitationSender] Waiting ${(delay/1000).toFixed(0)}s before next...`);
      await sleep(delay);
    } catch (err) {
      console.error(`[InvitationSender] ✗ Failed contact ${contact.id}: ${err.message}`);
      // Don't stop the batch on individual failure
    }
  }

  activelySending.delete(accountId);
  console.log(`[InvitationSender] Batch done for account ${accountId}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isWithinWorkingHours(settings) {
  const now   = new Date();
  // Day of week: 1=Mon, 7=Sun (JS: 0=Sun, 1=Mon...6=Sat)
  const jsDay = now.getDay();
  const dayKey = String(jsDay === 0 ? 7 : jsDay); // Convert to 1=Mon..7=Sun
  const hours = settings.hours?.[dayKey] ?? DEFAULT_WORKING_HOURS[dayKey];

  if (!hours?.on) return false;

  const [fromH, fromM] = (hours.from || '09:00').split(':').map(Number);
  const [toH,   toM  ] = (hours.to   || '18:00').split(':').map(Number);

  const nowMinutes  = now.getHours() * 60 + now.getMinutes();
  const fromMinutes = fromH * 60 + fromM;
  const toMinutes   = toH   * 60 + toM;

  return nowMinutes >= fromMinutes && nowMinutes < toMinutes;
}

async function countSentToday(accountId) {
  const { rows } = await db.query(`
    SELECT COUNT(*) as cnt
    FROM contacts c
    JOIN campaigns camp ON camp.id = c.campaign_id
    WHERE camp.account_id = $1
      AND c.invite_sent = true
      AND c.invite_sent_at >= NOW() - INTERVAL '24 hours'
  `, [accountId]);
  return parseInt(rows[0].cnt, 10);
}

async function getPendingContacts(accountId, limit) {
  const { rows } = await db.query(`
    SELECT c.id, c.li_profile_url, c.first_name, c.last_name, c.campaign_id
    FROM contacts c
    JOIN campaigns camp ON camp.id = c.campaign_id
    WHERE camp.account_id = $1
      AND camp.status = 'active'
      AND c.invite_sent = false
      AND c.li_profile_url IS NOT NULL
      AND c.li_profile_url != ''
    ORDER BY c.created_at ASC
    LIMIT $2
  `, [accountId, limit]);
  return rows;
}

function extractIdentifier(url) {
  const match = (url || '').match(/linkedin\.com\/in\/([^/?#]+)/);
  return match ? match[1] : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { start };

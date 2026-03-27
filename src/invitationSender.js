/**
 * Invitation Sender
 *
 * Sends LinkedIn connection requests for active campaigns.
 *
 * === GATING — campaign must have enabled in Sequence step ===
 *   campaign.settings.connection.enabled = true
 *   (the "Send connection requests" toggle in the wizard)
 *
 * === LOGIC ===
 *   For each account:
 *     1. Check working hours (from account settings)
 *     2. Check daily limit (connection_requests limit from Settings)
 *     3. Pull pending contacts from campaigns where connection is enabled
 *     4. Send with 30-90s random delay between each
 *     5. Mark invite_sent = true, invite_sent_at = now
 *
 * Scheduled: every 15 minutes.
 */

const db = require('./db');
const { sendInvitation } = require('./unipile');

const DEFAULT_DAILY_LIMIT = 20;
const DEFAULT_WORKING_HOURS = {
  1: { on: true,  from: '09:00', to: '18:00' },
  2: { on: true,  from: '09:00', to: '18:00' },
  3: { on: true,  from: '09:00', to: '18:00' },
  4: { on: true,  from: '09:00', to: '18:00' },
  5: { on: true,  from: '09:00', to: '18:00' },
  6: { on: false, from: '09:00', to: '18:00' },
  7: { on: false, from: '09:00', to: '18:00' },
};

const activelySending = new Set();

function start() {
  console.log('[InvitationSender] Started — checking every 15 minutes');
  run();
  setInterval(run, 15 * 60 * 1000);
}

async function run() {
  console.log('[InvitationSender] Running check...');
  try {
    // Only campaigns where the "Send connection requests" toggle is ON
    const { rows: campaigns } = await db.query(`
      SELECT c.id, c.account_id, c.name, c.workspace_id, c.settings
      FROM campaigns c
      JOIN unipile_accounts ua ON ua.account_id = c.account_id
      WHERE c.status = 'active'
        AND (c.settings->'connection'->>'enabled')::boolean = true
    `);

    if (!campaigns.length) {
      console.log('[InvitationSender] No active campaigns with connection requests enabled');
      return;
    }

    // Group by account to respect per-account daily limits
    const byAccount = {};
    for (const camp of campaigns) {
      if (!byAccount[camp.account_id]) byAccount[camp.account_id] = [];
      byAccount[camp.account_id].push(camp);
    }

    for (const [accountId, accountCampaigns] of Object.entries(byAccount)) {
      if (activelySending.has(accountId)) {
        console.log(`[InvitationSender] Account ${accountId} already sending, skipping`);
        continue;
      }

      const { rows: accRows } = await db.query(
        'SELECT settings FROM unipile_accounts WHERE account_id = $1',
        [accountId]
      );
      const accSettings = accRows[0]?.settings || {};

      if (!isWithinWorkingHours(accSettings)) {
        console.log(`[InvitationSender] Account ${accountId} outside working hours, skipping`);
        continue;
      }

      const dailyLimit = accSettings.limits?.connection_requests ?? DEFAULT_DAILY_LIMIT;
      const sentToday  = await countSentToday(accountId);
      const canSend    = dailyLimit - sentToday;

      if (canSend <= 0) {
        console.log(`[InvitationSender] Account ${accountId} reached daily limit (${dailyLimit}), skipping`);
        continue;
      }

      console.log(`[InvitationSender] Account ${accountId}: ${sentToday}/${dailyLimit} sent today, can send ${canSend} more`);

      // Only from campaigns where connection toggle is enabled (already filtered above)
      const campaignIds = accountCampaigns.map(c => c.id);
      const contacts    = await getPendingContacts(campaignIds, canSend);

      if (!contacts.length) {
        console.log(`[InvitationSender] Account ${accountId}: no pending contacts`);
        continue;
      }

      sendBatch(accountId, contacts);
    }
  } catch (err) {
    console.error('[InvitationSender] Error in run():', err.message);
  }
}

async function sendBatch(accountId, contacts) {
  activelySending.add(accountId);
  console.log(`[InvitationSender] Starting batch for ${accountId}: ${contacts.length} contacts`);

  for (const contact of contacts) {
    try {
      const identifier = extractIdentifier(contact.li_profile_url);
      if (!identifier) {
        console.warn(`[InvitationSender] No identifier for: ${contact.li_profile_url}`);
        continue;
      }

      await sendInvitation(accountId, contact.li_profile_url);

      await db.query(
        'UPDATE contacts SET invite_sent = true, invite_sent_at = NOW() WHERE id = $1',
        [contact.id]
      );

      console.log(`[InvitationSender] ✓ Sent to ${identifier} (contact ${contact.id}, campaign ${contact.campaign_id})`);

      const delay = 30000 + Math.random() * 60000;
      console.log(`[InvitationSender] Waiting ${(delay/1000).toFixed(0)}s...`);
      await sleep(delay);
    } catch (err) {
      console.error(`[InvitationSender] ✗ contact ${contact.id}: ${err.message}`);
    }
  }

  activelySending.delete(accountId);
  console.log(`[InvitationSender] Batch done for ${accountId}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isWithinWorkingHours(settings) {
  const now    = new Date();
  const jsDay  = now.getDay();
  const dayKey = String(jsDay === 0 ? 7 : jsDay);
  const hours  = settings.hours?.[dayKey] ?? DEFAULT_WORKING_HOURS[dayKey];
  if (!hours?.on) return false;
  const [fromH, fromM] = (hours.from || '09:00').split(':').map(Number);
  const [toH,   toM  ] = (hours.to   || '18:00').split(':').map(Number);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return nowMin >= fromH * 60 + fromM && nowMin < toH * 60 + toM;
}

async function countSentToday(accountId) {
  const { rows } = await db.query(`
    SELECT COUNT(*) AS cnt
    FROM contacts c
    JOIN campaigns camp ON camp.id = c.campaign_id
    WHERE camp.account_id = $1
      AND c.invite_sent = true
      AND c.invite_sent_at >= NOW() - INTERVAL '24 hours'
  `, [accountId]);
  return parseInt(rows[0].cnt, 10);
}

/**
 * Only returns contacts from campaigns where the connection toggle is enabled.
 * Campaign-level filtering is the source of truth — not just account-level.
 */
async function getPendingContacts(campaignIds, limit) {
  const { rows } = await db.query(`
    SELECT c.id, c.li_profile_url, c.first_name, c.last_name, c.campaign_id
    FROM contacts c
    JOIN campaigns camp ON camp.id = c.campaign_id
    WHERE camp.id = ANY($1)
      AND camp.status = 'active'
      AND (camp.settings->'connection'->>'enabled')::boolean = true
      AND c.invite_sent = false
      AND c.li_profile_url IS NOT NULL
      AND c.li_profile_url != ''
    ORDER BY c.created_at ASC
    LIMIT $2
  `, [campaignIds, limit]);
  return rows;
}

function extractIdentifier(url) {
  const match = (url || '').match(/linkedin\.com\/in\/([^/?#]+)/);
  return match ? match[1] : null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { start };

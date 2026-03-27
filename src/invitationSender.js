/**
 * Invitation Sender
 *
 * Sends LinkedIn connection requests for active campaigns.
 *
 * Working hours are now per-campaign (campaign.settings.hours).
 * Daily limits are per-account (accSettings.limits.connection_requests).
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
    // Only campaigns where connection toggle is ON
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

    // Group by account to check per-account daily limit once
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

      // Check daily limit (per account)
      const dailyLimit = accSettings.limits?.connection_requests ?? DEFAULT_DAILY_LIMIT;
      const sentToday  = await countSentToday(accountId);
      const canSend    = dailyLimit - sentToday;

      if (canSend <= 0) {
        console.log(`[InvitationSender] Account ${accountId} reached daily limit (${dailyLimit}), skipping`);
        continue;
      }

      console.log(`[InvitationSender] Account ${accountId}: ${sentToday}/${dailyLimit} sent today, can send ${canSend} more`);

      // For each campaign, check its own working hours
      let remaining = canSend;
      for (const campaign of accountCampaigns) {
        if (remaining <= 0) break;

        // Working hours come from campaign settings (fallback: account settings, then default)
        const hours = campaign.settings?.hours || accSettings.hours || null;
        if (!isWithinWorkingHours(hours)) {
          console.log(`[InvitationSender] Campaign ${campaign.id} outside working hours`);
          continue;
        }

        const contacts = await getPendingContactsForCampaign(campaign.id, remaining);
        if (!contacts.length) {
          console.log(`[InvitationSender] Campaign ${campaign.id}: no pending contacts`);
          continue;
        }

        remaining -= contacts.length;
        sendBatch(accountId, contacts);
      }
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
      await sleep(delay);
    } catch (err) {
      console.error(`[InvitationSender] ✗ contact ${contact.id}: ${err.message}`);
    }
  }

  activelySending.delete(accountId);
  console.log(`[InvitationSender] Batch done for ${accountId}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * isWithinWorkingHours
 * @param {object|null} hours - campaign.settings.hours structure
 *   { '1': { on: true, from: '09:00', to: '18:00' }, ... }
 *   Keys are '1'=Mon ... '7'=Sun
 * Fallback to default Mon-Fri 9-18 if not configured.
 */
function isWithinWorkingHours(hours) {
  const now    = new Date();
  const jsDay  = now.getDay();
  const dayKey = String(jsDay === 0 ? 7 : jsDay);
  const h      = (hours && hours[dayKey]) || DEFAULT_WORKING_HOURS[dayKey];
  if (!h?.on) return false;
  const [fromH, fromM] = (h.from || '09:00').split(':').map(Number);
  const [toH,   toM  ] = (h.to   || '18:00').split(':').map(Number);
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
      AND c.invite_sent_at >= date_trunc('day', NOW())
  `, [accountId]);
  return parseInt(rows[0].cnt, 10);
}

async function getPendingContactsForCampaign(campaignId, limit) {
  const { rows } = await db.query(`
    SELECT c.id, c.li_profile_url, c.first_name, c.last_name, c.campaign_id
    FROM contacts c
    JOIN campaigns camp ON camp.id = c.campaign_id
    WHERE camp.id = $1
      AND camp.status = 'active'
      AND (camp.settings->'connection'->>'enabled')::boolean = true
      AND c.invite_sent = false
      AND c.li_profile_url IS NOT NULL
      AND c.li_profile_url != ''
    ORDER BY c.created_at ASC
    LIMIT $2
  `, [campaignId, limit]);
  return rows;
}

function extractIdentifier(url) {
  const match = (url || '').match(/linkedin\.com\/in\/([^/?#]+)/);
  return match ? match[1] : null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { start };

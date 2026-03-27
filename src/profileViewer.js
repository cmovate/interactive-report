/**
 * Profile Viewer
 *
 * Views LinkedIn profiles on behalf of the account.
 *
 * === GATING ===
 *   campaign.settings.engagement.view_profile = true
 *
 * === RULES ===
 *   - Each contact viewed at most ONCE EVERY 7 DAYS
 *   - Daily limit: settings.limits.profile_views (default 40)
 *   - Respects working hours
 *   - Independent of any other action
 *   - 30-90s random delay between views
 *
 * === ORDERING ===
 *   Never-viewed first (NULLS FIRST), then oldest-viewed ASC.
 *
 * === DB ===
 *   contacts.last_profile_view_at  — timestamp of most recent view
 *   contacts.profile_view_count    — total views sent for this contact
 *
 * Scheduled: every 15 minutes.
 */

const db      = require('./db');
const unipile = require('./unipile');

const DEFAULT_DAILY_LIMIT = 40;
const MIN_DAYS_BETWEEN    = 7;
const CHECK_INTERVAL_MS   = 15 * 60 * 1000;

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
  console.log('[ProfileViewer] Started — checking every 15 minutes');
  run();
  setInterval(run, CHECK_INTERVAL_MS);
}

async function run() {
  console.log('[ProfileViewer] Running check...');
  try {
    const { rows: campaigns } = await db.query(`
      SELECT c.id, c.account_id, c.workspace_id
      FROM campaigns c
      JOIN unipile_accounts ua ON ua.account_id = c.account_id
      WHERE c.status = 'active'
        AND (c.settings->'engagement'->>'view_profile')::boolean = true
    `);

    if (!campaigns.length) {
      console.log('[ProfileViewer] No active campaigns with view_profile enabled');
      return;
    }

    // Group by account
    const byAccount = {};
    for (const camp of campaigns) {
      if (!byAccount[camp.account_id]) byAccount[camp.account_id] = [];
      byAccount[camp.account_id].push(camp);
    }

    for (const [accountId, accountCampaigns] of Object.entries(byAccount)) {
      if (activelySending.has(accountId)) {
        console.log(`[ProfileViewer] Account ${accountId} already running, skipping`);
        continue;
      }

      const { rows: accRows } = await db.query(
        'SELECT settings FROM unipile_accounts WHERE account_id = $1',
        [accountId]
      );
      const accSettings = accRows[0]?.settings || {};

      if (!isWithinWorkingHours(accSettings)) {
        console.log(`[ProfileViewer] Account ${accountId} outside working hours`);
        continue;
      }

      const dailyLimit  = accSettings.limits?.profile_views ?? DEFAULT_DAILY_LIMIT;
      const viewedToday = await countViewedToday(accountId);
      const canView     = dailyLimit - viewedToday;

      if (canView <= 0) {
        console.log(`[ProfileViewer] Account ${accountId} reached daily limit (${dailyLimit})`);
        continue;
      }

      console.log(`[ProfileViewer] Account ${accountId}: ${viewedToday}/${dailyLimit} today, can view ${canView} more`);

      const campaignIds = accountCampaigns.map(c => c.id);
      const contacts    = await getPendingContacts(campaignIds, canView);

      if (!contacts.length) {
        console.log(`[ProfileViewer] Account ${accountId}: no contacts due for viewing`);
        continue;
      }

      // Fire-and-forget batch
      sendBatch(accountId, contacts);
    }
  } catch (err) {
    console.error('[ProfileViewer] Error in run():', err.message);
  }
}

async function sendBatch(accountId, contacts) {
  activelySending.add(accountId);
  console.log(`[ProfileViewer] Batch for ${accountId}: ${contacts.length} contacts`);

  for (const contact of contacts) {
    try {
      const identifier = extractIdentifier(contact.li_profile_url);
      if (!identifier) {
        console.warn(`[ProfileViewer] No identifier for contact ${contact.id}`);
        continue;
      }

      // CONFIRMED: *_preview + notify=true → 200 OK (tested live)
      await unipile.viewProfile(accountId, identifier);

      await db.query(
        `UPDATE contacts
         SET last_profile_view_at = NOW(),
             profile_view_count   = COALESCE(profile_view_count, 0) + 1
         WHERE id = $1`,
        [contact.id]
      );

      console.log(`[ProfileViewer] ✓ Viewed ${identifier} (contact ${contact.id}, campaign ${contact.campaign_id})`);

      const delay = 30000 + Math.random() * 60000; // 30-90s
      await sleep(delay);
    } catch (err) {
      console.error(`[ProfileViewer] ✗ contact ${contact.id}: ${err.message}`);
      // Continue on individual failure
    }
  }

  activelySending.delete(accountId);
  console.log(`[ProfileViewer] Batch done for ${accountId}`);
}

/**
 * Eligible contacts:
 *   - Campaign has view_profile = true
 *   - Valid LinkedIn URL
 *   - Never viewed OR last viewed >= 7 days ago
 *   - Order: never-viewed first, then oldest-viewed ASC
 */
async function getPendingContacts(campaignIds, limit) {
  const { rows } = await db.query(`
    SELECT c.id, c.li_profile_url, c.first_name, c.last_name, c.campaign_id
    FROM contacts c
    JOIN campaigns camp ON camp.id = c.campaign_id
    WHERE camp.id = ANY($1)
      AND camp.status = 'active'
      AND (camp.settings->'engagement'->>'view_profile')::boolean = true
      AND c.li_profile_url IS NOT NULL
      AND c.li_profile_url != ''
      AND (
        c.last_profile_view_at IS NULL
        OR c.last_profile_view_at < NOW() - INTERVAL '7 days'
      )
    ORDER BY
      c.last_profile_view_at ASC NULLS FIRST,
      c.created_at ASC
    LIMIT $2
  `, [campaignIds, limit]);
  return rows;
}

async function countViewedToday(accountId) {
  const { rows } = await db.query(`
    SELECT COUNT(*) AS cnt
    FROM contacts c
    JOIN campaigns camp ON camp.id = c.campaign_id
    WHERE camp.account_id = $1
      AND c.last_profile_view_at >= date_trunc('day', NOW())
  `, [accountId]);
  return parseInt(rows[0].cnt, 10);
}

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

function extractIdentifier(url) {
  const match = (url || '').match(/linkedin\.com\/in\/([^/?#]+)/);
  return match ? match[1] : null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { start };

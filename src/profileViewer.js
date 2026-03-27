/**
 * Profile Viewer
 *
 * Views LinkedIn profiles on behalf of the account, once per day per run.
 *
 * === GATING ===
 *   campaign.settings.engagement.view_profile = true
 *   (the "View profile" toggle in the Sequence step)
 *
 * === RULES ===
 *   - Each contact is viewed at most ONCE EVERY 7 DAYS
 *   - Respects daily limit from account settings:
 *       settings.limits.profile_views (default: 40)
 *   - Respects working hours from account settings
 *   - Independent of any other action — no prerequisite on invite_sent or approved
 *   - Random 30-90s delay between each profile view (human-like pacing)
 *
 * === ORDERING ===
 *   Contacts who have never been viewed come first (last_profile_view_at IS NULL),
 *   then by oldest last viewed (ASC), so the whole list rotates evenly.
 *
 * === DB ===
 *   contacts.last_profile_view_at  — timestamp of most recent view
 *   contacts.profile_view_count    — total views sent
 *
 * Scheduled: every 15 minutes (checks, but rate-limits per day).
 */

const db     = require('./db');
const unipile = require('./unipile');

const DEFAULT_DAILY_LIMIT  = 40;
const MIN_DAYS_BETWEEN     = 7;   // must be at least 7 days between views
const CHECK_INTERVAL_MS    = 15 * 60 * 1000; // 15 min
const DELAY_BETWEEN_MS     = () => 30000 + Math.random() * 60000; // 30-90s

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

// ── Public API ────────────────────────────────────────────────────────────────

function start() {
  console.log('[ProfileViewer] Started — checking every 15 minutes');
  run();
  setInterval(run, CHECK_INTERVAL_MS);
}

// ── Main runner ───────────────────────────────────────────────────────────────

async function run() {
  console.log('[ProfileViewer] Running check...');
  try {
    // Get all active campaigns where view_profile is enabled
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

      // Load account settings
      const { rows: accRows } = await db.query(
        'SELECT settings FROM unipile_accounts WHERE account_id = $1',
        [accountId]
      );
      const accSettings = accRows[0]?.settings || {};

      if (!isWithinWorkingHours(accSettings)) {
        console.log(`[ProfileViewer] Account ${accountId} outside working hours`);
        continue;
      }

      const dailyLimit = accSettings.limits?.profile_views ?? DEFAULT_DAILY_LIMIT;
      const viewedToday = await countViewedToday(accountId);
      const canView    = dailyLimit - viewedToday;

      if (canView <= 0) {
        console.log(`[ProfileViewer] Account ${accountId} reached daily limit (${dailyLimit})`);
        continue;
      }

      console.log(`[ProfileViewer] Account ${accountId}: ${viewedToday}/${dailyLimit} viewed today, can view ${canView} more`);

      const campaignIds = accountCampaigns.map(c => c.id);
      const contacts    = await getPendingContacts(campaignIds, canView);

      if (!contacts.length) {
        console.log(`[ProfileViewer] Account ${accountId}: no contacts due for viewing`);
        continue;
      }

      // Non-blocking batch
      sendBatch(accountId, contacts);
    }
  } catch (err) {
    console.error('[ProfileViewer] Error in run():', err.message);
  }
}

// ── Batch viewer ──────────────────────────────────────────────────────────────

async function sendBatch(accountId, contacts) {
  activelySending.add(accountId);
  console.log(`[ProfileViewer] Starting batch for ${accountId}: ${contacts.length} contacts`);

  for (const contact of contacts) {
    try {
      const identifier = extractIdentifier(contact.li_profile_url);
      if (!identifier) {
        console.warn(`[ProfileViewer] No identifier for contact ${contact.id}`);
        continue;
      }

      // Call Unipile with notify=true — triggers a LinkedIn profile view
      await unipile.viewProfile(accountId, identifier);

      // Record in DB
      await db.query(
        `UPDATE contacts
         SET last_profile_view_at = NOW(),
             profile_view_count   = COALESCE(profile_view_count, 0) + 1
         WHERE id = $1`,
        [contact.id]
      );

      console.log(`[ProfileViewer] ✓ Viewed ${identifier} (contact ${contact.id}, campaign ${contact.campaign_id})`);

      const delay = DELAY_BETWEEN_MS();
      console.log(`[ProfileViewer] Waiting ${(delay/1000).toFixed(0)}s...`);
      await sleep(delay);
    } catch (err) {
      console.error(`[ProfileViewer] ✗ contact ${contact.id}: ${err.message}`);
      // Continue to next contact — don't stop the batch on individual failure
    }
  }

  activelySending.delete(accountId);
  console.log(`[ProfileViewer] Batch done for ${accountId}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Contacts eligible for viewing:
 *   - Campaign has view_profile = true
 *   - Have a valid LinkedIn URL
 *   - Never viewed OR last viewed >= 7 days ago
 *   - Order: never-viewed first, then oldest-viewed-at ASC (even rotation)
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
        OR c.last_profile_view_at < NOW() - INTERVAL '${MIN_DAYS_BETWEEN} days'
      )
    ORDER BY
      c.last_profile_view_at ASC NULLS FIRST,
      c.created_at ASC
    LIMIT $2
  `, [campaignIds, limit]);
  return rows;
}

async function countViewedToday(accountId) {
  // Calendar day — same fix as invitationSender
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

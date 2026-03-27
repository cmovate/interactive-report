/**
 * Company Follow Sender
 * Invites approved contacts to follow the LinkedIn company page.
 *
 * Rules:
 *   - Only contacts with invite_approved = true (already connected)
 *   - Only contacts NOT yet invited to follow (company_follow_invited = false)
 *   - Max 250 invitations per MONTH per account across ALL campaigns
 *   - Uses working hours from account settings
 *   - Sends in batches of up to 5 at a time (Unipile batch_create)
 *   - Random delay 60-120s between batches
 *
 * Requires in account settings: company_page_urn
 *   e.g. "urn:li:fsd_company:38114588"
 *   (get your company ID from your LinkedIn company page URL)
 *
 * Scheduled: every 30 minutes.
 */

const db = require('./db');
const { sendCompanyFollowInvites } = require('./unipile');

const MONTHLY_LIMIT  = 250;
const BATCH_SIZE     = 5;   // Unipile accepts batch_create
const CHECK_INTERVAL = 30 * 60 * 1000; // 30 min

const activelySending = new Set();

function start() {
  console.log('[CompanyFollow] Started — checking every 30 minutes');
  run();
  setInterval(run, CHECK_INTERVAL);
}

async function run() {
  console.log('[CompanyFollow] Running check...');
  try {
    // Get all accounts that have a company_page_urn configured
    const { rows: accounts } = await db.query(`
      SELECT DISTINCT ua.account_id, ua.settings
      FROM unipile_accounts ua
      JOIN campaigns c ON c.account_id = ua.account_id
      WHERE c.status = 'active'
        AND ua.settings->>'company_page_urn' IS NOT NULL
        AND ua.settings->>'company_page_urn' != ''
    `);

    if (!accounts.length) {
      console.log('[CompanyFollow] No accounts with company_page_urn configured');
      return;
    }

    for (const acc of accounts) {
      if (activelySending.has(acc.account_id)) continue;

      const settings      = acc.settings || {};
      const companyPageUrn = settings.company_page_urn;

      // Check working hours
      if (!isWithinWorkingHours(settings)) {
        console.log(`[CompanyFollow] Account ${acc.account_id} outside working hours`);
        continue;
      }

      // Count how many already sent this calendar month
      const sentThisMonth = await countSentThisMonth(acc.account_id);
      const remaining     = MONTHLY_LIMIT - sentThisMonth;

      if (remaining <= 0) {
        console.log(`[CompanyFollow] Account ${acc.account_id} reached monthly limit (${MONTHLY_LIMIT})`);
        continue;
      }

      console.log(`[CompanyFollow] Account ${acc.account_id}: ${sentThisMonth}/${MONTHLY_LIMIT} sent this month, ${remaining} remaining`);

      // Get pending contacts: approved connections, not yet invited to follow
      const contacts = await getPendingContacts(acc.account_id, remaining);
      if (!contacts.length) {
        console.log(`[CompanyFollow] Account ${acc.account_id}: no pending contacts`);
        continue;
      }

      sendBatch(acc.account_id, companyPageUrn, contacts);
    }
  } catch (err) {
    console.error('[CompanyFollow] Error in run():', err.message);
  }
}

async function sendBatch(accountId, companyPageUrn, contacts) {
  activelySending.add(accountId);
  console.log(`[CompanyFollow] Starting batch for ${accountId}: ${contacts.length} contacts, company: ${companyPageUrn}`);

  // Send in chunks of BATCH_SIZE
  for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
    const chunk = contacts.slice(i, i + BATCH_SIZE);

    // Build URNs — Unipile profile gives us member_urn like "urn:li:fsd_profile:XXXXX"
    // If member_urn not available, fall back to provider_id
    const elements = chunk
      .map(c => {
        const profileData = c.profile_data || {};
        const memberUrn   = profileData.member_urn || null;
        const providerId  = profileData.provider_id || null;

        let inviteeMember = null;
        if (memberUrn && memberUrn.startsWith('urn:li:')) {
          inviteeMember = memberUrn;
        } else if (providerId) {
          inviteeMember = `urn:li:fsd_profile:${providerId}`;
        }
        return inviteeMember ? { id: c.id, inviteeMember } : null;
      })
      .filter(Boolean);

    if (!elements.length) {
      console.log(`[CompanyFollow] Chunk ${i}-${i+BATCH_SIZE}: no valid URNs, skipping`);
      continue;
    }

    try {
      await sendCompanyFollowInvites(
        accountId,
        companyPageUrn,
        elements.map(e => e.inviteeMember)
      );

      // Mark all in chunk as invited
      const ids = elements.map(e => e.id);
      await db.query(
        `UPDATE contacts SET company_follow_invited = true, company_follow_invited_at = NOW() WHERE id = ANY($1)`,
        [ids]
      );

      console.log(`[CompanyFollow] ✓ Sent follow invites to ${ids.length} contacts (account ${accountId})`);
    } catch (err) {
      console.error(`[CompanyFollow] ✗ Batch failed for account ${accountId}: ${err.message}`);
    }

    // Random delay 60-120s between batches
    const delay = 60000 + Math.random() * 60000;
    console.log(`[CompanyFollow] Waiting ${(delay/1000).toFixed(0)}s before next batch...`);
    await sleep(delay);
  }

  activelySending.delete(accountId);
  console.log(`[CompanyFollow] Batch done for account ${accountId}`);
}

async function countSentThisMonth(accountId) {
  const { rows } = await db.query(`
    SELECT COUNT(*) as cnt
    FROM contacts c
    JOIN campaigns camp ON camp.id = c.campaign_id
    WHERE camp.account_id = $1
      AND c.company_follow_invited = true
      AND c.company_follow_invited_at >= date_trunc('month', NOW())
  `, [accountId]);
  return parseInt(rows[0].cnt, 10);
}

async function getPendingContacts(accountId, limit) {
  const { rows } = await db.query(`
    SELECT c.id, c.first_name, c.last_name, c.campaign_id, c.profile_data
    FROM contacts c
    JOIN campaigns camp ON camp.id = c.campaign_id
    WHERE camp.account_id = $1
      AND camp.status = 'active'
      AND c.invite_approved = true
      AND (c.company_follow_invited = false OR c.company_follow_invited IS NULL)
      AND c.profile_data IS NOT NULL
      AND c.profile_data::text != 'null'
      AND c.profile_data::text != '{}'
    ORDER BY c.created_at ASC
    LIMIT $2
  `, [accountId, limit]);
  return rows;
}

function isWithinWorkingHours(settings) {
  const now    = new Date();
  const jsDay  = now.getDay();
  const dayKey = String(jsDay === 0 ? 7 : jsDay);
  const hours  = settings.hours?.[dayKey] ?? { on: jsDay >= 1 && jsDay <= 5, from: '09:00', to: '18:00' };
  if (!hours?.on) return false;
  const [fromH, fromM] = (hours.from || '09:00').split(':').map(Number);
  const [toH,   toM  ] = (hours.to   || '18:00').split(':').map(Number);
  const nowMin  = now.getHours() * 60 + now.getMinutes();
  return nowMin >= fromH * 60 + fromM && nowMin < toH * 60 + toM;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { start, countSentThisMonth };

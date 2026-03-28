/**
 * Company Follow Sender
 *
 * Working hours check: runs if ANY eligible campaign for the account
 * is within working hours (union logic, not just the first campaign).
 *
 * State machine (normal/waiting_5d/drip/waiting_7d) is per-account.
 *
 * Scheduled: every 30 minutes.
 */

const db = require('./db');
const { sendCompanyFollowInvites } = require('./unipile');
const { DEFAULT_WORKING_HOURS } = require('./constants');

const MONTHLY_LIMIT  = 250;
const BATCH_SIZE     = 5;
const CHECK_INTERVAL = 30 * 60 * 1000;

const activelySending = new Set();

function start() {
  console.log('[CompanyFollow] Started — checking every 30 minutes');
  run();
  setInterval(run, CHECK_INTERVAL);
}

async function countSentThisMonth(accountId) {
  const { rows } = await db.query(`
    SELECT COUNT(*) AS cnt
    FROM contacts c
    JOIN campaigns camp ON camp.id = c.campaign_id
    WHERE camp.account_id = $1
      AND c.company_follow_invited = true
      AND c.company_follow_invited_at >= date_trunc('month', NOW())
  `, [accountId]);
  return parseInt(rows[0].cnt, 10);
}

async function run() {
  console.log('[CompanyFollow] Running check...');
  try {
    const { rows: accounts } = await db.query(`
      SELECT DISTINCT ua.account_id, ua.settings
      FROM unipile_accounts ua
      JOIN campaigns c ON c.account_id = ua.account_id
      WHERE c.status = 'active'
        AND (c.settings->'engagement'->>'follow_company')::boolean = true
        AND ua.settings->>'company_page_urn' IS NOT NULL
        AND ua.settings->>'company_page_urn' != ''
    `);

    if (!accounts.length) { console.log('[CompanyFollow] No eligible accounts'); return; }

    for (const acc of accounts) {
      if (activelySending.has(acc.account_id)) continue;

      const settings      = acc.settings || {};
      const companyPageUrn = settings.company_page_urn;

      // Working hours: allow if ANY eligible campaign is within working hours.
      // This is fairer than using only the first campaign arbitrarily.
      const { rows: eligibleCamps } = await db.query(`
        SELECT settings FROM campaigns
        WHERE account_id = $1 AND status = 'active'
          AND (settings->'engagement'->>'follow_company')::boolean = true
      `, [acc.account_id]);

      const anyWithinHours = eligibleCamps.some(camp =>
        isWithinWorkingHours(camp.settings?.hours || null)
      );

      if (!anyWithinHours) {
        console.log(`[CompanyFollow] Account ${acc.account_id} outside working hours for all campaigns`);
        continue;
      }

      // Monthly reset
      const nowDate   = new Date();
      const cfMonth   = settings.cf_month || '';
      const thisMonth = `${nowDate.getFullYear()}-${String(nowDate.getMonth()+1).padStart(2,'0')}`;

      if (cfMonth !== thisMonth) {
        console.log(`[CompanyFollow] New month — resetting state for ${acc.account_id}`);
        await patchSettings(acc.account_id, {
          cf_state: 'normal', cf_state_since: new Date().toISOString(),
          cf_month: thisMonth, cf_drip_date: '', cf_drip_sent_today: 0,
        });
        settings.cf_state = 'normal'; settings.cf_state_since = new Date().toISOString();
        settings.cf_month = thisMonth; settings.cf_drip_date = ''; settings.cf_drip_sent_today = 0;
      }

      const state      = settings.cf_state || 'normal';
      const stateSince = settings.cf_state_since ? new Date(settings.cf_state_since) : new Date();
      console.log(`[CompanyFollow] Account ${acc.account_id} state: ${state}`);

      if (state === 'waiting_5d') {
        const daysPassed = daysBetween(stateSince, nowDate);
        if (daysPassed >= 5) {
          await patchSettings(acc.account_id, { cf_state: 'drip', cf_state_since: new Date().toISOString() });
          settings.cf_state = 'drip';
        } else { console.log(`[CompanyFollow] ${acc.account_id}: waiting_5d — ${daysPassed.toFixed(1)}d`); continue; }
      }

      if (state === 'waiting_7d') {
        const daysPassed = daysBetween(stateSince, nowDate);
        if (daysPassed >= 7) {
          await patchSettings(acc.account_id, { cf_state: 'drip', cf_state_since: new Date().toISOString() });
          settings.cf_state = 'drip';
        } else { console.log(`[CompanyFollow] ${acc.account_id}: waiting_7d — ${daysPassed.toFixed(1)}d`); continue; }
      }

      if (settings.cf_state === 'normal') {
        const sentThisMonth = await countSentThisMonth(acc.account_id);
        const remaining     = MONTHLY_LIMIT - sentThisMonth;
        console.log(`[CompanyFollow] ${acc.account_id}: normal — ${sentThisMonth}/${MONTHLY_LIMIT}`);
        if (remaining <= 0) {
          await patchSettings(acc.account_id, { cf_state: 'waiting_5d', cf_state_since: new Date().toISOString() }); continue;
        }
        const contacts = await getPendingContacts(acc.account_id, Math.min(remaining, BATCH_SIZE));
        if (!contacts.length) { console.log(`[CompanyFollow] ${acc.account_id}: no pending contacts`); continue; }
        sendBatch(acc.account_id, companyPageUrn, contacts, settings, 'normal');
      }
      else if (settings.cf_state === 'drip') {
        const todayStr    = toDateStr(nowDate);
        const dripDate    = settings.cf_drip_date || '';
        let dripSentToday = (dripDate === todayStr) ? (settings.cf_drip_sent_today || 0) : 0;
        if (dripDate !== todayStr) {
          await patchSettings(acc.account_id, { cf_drip_date: todayStr, cf_drip_sent_today: 0 });
          dripSentToday = 0;
        }
        const canSendToday = 5 - dripSentToday;
        if (canSendToday <= 0) { console.log(`[CompanyFollow] ${acc.account_id}: drip — already sent 5 today`); continue; }
        const contacts = await getPendingContacts(acc.account_id, canSendToday);
        if (!contacts.length) { console.log(`[CompanyFollow] ${acc.account_id}: drip — no pending contacts`); continue; }
        sendBatch(acc.account_id, companyPageUrn, contacts, settings, 'drip');
      }
    }
  } catch (err) { console.error('[CompanyFollow] Error in run():', err.message); }
}

async function sendBatch(accountId, companyPageUrn, contacts, settings, mode) {
  activelySending.add(accountId);
  console.log(`[CompanyFollow] Sending ${contacts.length} follow invites for ${accountId} (mode: ${mode})`);

  for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
    const chunk = contacts.slice(i, i + BATCH_SIZE);
    const elements = chunk.map(c => {
      let pd = {};
      try { const raw = typeof c.profile_data === 'string' ? JSON.parse(c.profile_data) : c.profile_data; if (raw && typeof raw === 'object') pd = raw; } catch (_) {}
      const memberUrn  = pd.member_urn  || null;
      const providerId = pd.provider_id || null;
      let inviteeMember = null;
      if (memberUrn && memberUrn.startsWith('urn:li:'))  inviteeMember = memberUrn;
      else if (providerId)                                inviteeMember = `urn:li:fsd_profile:${providerId}`;
      return inviteeMember ? { id: c.id, inviteeMember } : null;
    }).filter(Boolean);

    if (!elements.length) { console.warn(`[CompanyFollow] Chunk has no valid URNs`); continue; }

    try {
      await sendCompanyFollowInvites(accountId, companyPageUrn, elements.map(e => e.inviteeMember));
      const ids = elements.map(e => e.id);
      await db.query('UPDATE contacts SET company_follow_invited = true, company_follow_invited_at = NOW() WHERE id = ANY($1)', [ids]);
      if (mode === 'drip') {
        const todayStr = toDateStr(new Date());
        const prevSent = (settings.cf_drip_date === todayStr) ? (settings.cf_drip_sent_today || 0) : 0;
        const newSent  = prevSent + ids.length;
        await patchSettings(accountId, { cf_drip_date: todayStr, cf_drip_sent_today: newSent });
        settings.cf_drip_date = todayStr; settings.cf_drip_sent_today = newSent;
      }
      console.log(`[CompanyFollow] ✓ ${elements.length} follow invites sent (account ${accountId})`);
    } catch (err) {
      console.error(`[CompanyFollow] ✗ API error for ${accountId}: ${err.message}`);
      if (mode === 'drip') await patchSettings(accountId, { cf_state: 'waiting_7d', cf_state_since: new Date().toISOString() });
      break;
    }

    await sleep(60000 + Math.random() * 60000);
  }

  if (mode === 'normal') {
    const nowSent = await countSentThisMonth(accountId);
    if (nowSent >= MONTHLY_LIMIT) await patchSettings(accountId, { cf_state: 'waiting_5d', cf_state_since: new Date().toISOString() });
  }
  activelySending.delete(accountId);
}

async function getPendingContacts(accountId, limit) {
  const { rows } = await db.query(`
    SELECT c.id, c.first_name, c.last_name, c.invite_approved, c.campaign_id, c.profile_data
    FROM contacts c
    JOIN campaigns camp ON camp.id = c.campaign_id
    WHERE camp.account_id = $1
      AND camp.status = 'active'
      AND (camp.settings->'engagement'->>'follow_company')::boolean = true
      AND (
        c.invite_approved = true
        OR (c.profile_data->>'network_distance') = '1'
        OR (c.profile_data->>'is_relationship')::boolean = true
      )
      AND (c.company_follow_invited = false OR c.company_follow_invited IS NULL)
      AND c.profile_data IS NOT NULL
      AND c.profile_data::text NOT IN ('null', '{}', '')
    ORDER BY c.invite_approved DESC, c.created_at ASC
    LIMIT $2
  `, [accountId, limit]);
  return rows;
}

async function patchSettings(accountId, patch) {
  const entries = Object.entries(patch);
  if (!entries.length) return;
  const args = [accountId], parts = [];
  for (const [k, v] of entries) {
    args.push(k, v === undefined ? null : v);
    parts.push(`$${args.length-1}, $${args.length}`);
  }
  await db.query(
    `UPDATE unipile_accounts SET settings = settings || jsonb_build_object(${parts.join(', ')}) WHERE account_id = $1`,
    args
  );
}

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

function daysBetween(d1, d2) { return (d2 - d1) / (1000 * 60 * 60 * 24); }
function toDateStr(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { start, countSentThisMonth };

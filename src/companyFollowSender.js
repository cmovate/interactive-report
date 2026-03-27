/**
 * Company Follow Sender
 *
 * Invites LinkedIn connections to follow the company page.
 *
 * === ELIGIBILITY (contact must meet ALL) ===
 *   1. Already connected to us:
 *        a) invite_approved = true  (they accepted our campaign invite)  ← PRIORITY
 *        b) OR profile_data network_distance = '1' / is_relationship = 'true' (pre-existing connection)
 *   2. company_follow_invited = false  (not yet invited)
 *   3. profile_data contains a valid member_urn or provider_id
 *   4. Campaign status = 'active'
 *   5. Campaign engagement.follow_company = true  (toggle enabled in Sequence step)
 *   6. Account has company_page_urn configured in settings
 *
 * === STATE MACHINE (per account, stored in unipile_accounts.settings) ===
 *
 *   normal
 *     → send batches of 5 until sent_this_month >= 250
 *     → on reaching 250: state = waiting_5d
 *
 *   waiting_5d
 *     → after 5 days: state = drip
 *
 *   drip
 *     → send up to 5/day
 *     → on API error: state = waiting_7d
 *
 *   waiting_7d
 *     → after 7 days: state = drip
 *
 *   On 1st of every month: full reset → state = normal, new 250 quota
 *
 * === ORDERING ===
 *   invite_approved DESC (accepted our invite first), then created_at ASC (FIFO)
 *
 * Scheduled: every 30 minutes.
 */

const db = require('./db');
const { sendCompanyFollowInvites } = require('./unipile');

const MONTHLY_LIMIT  = 250;
const BATCH_SIZE     = 5;
const CHECK_INTERVAL = 30 * 60 * 1000; // 30 min

const activelySending = new Set();

// ── Public API ────────────────────────────────────────────────────────────────

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

// ── Main runner ───────────────────────────────────────────────────────────────

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

    if (!accounts.length) {
      console.log('[CompanyFollow] No eligible accounts');
      return;
    }

    for (const acc of accounts) {
      if (activelySending.has(acc.account_id)) continue;

      const settings      = acc.settings || {};
      const companyPageUrn = settings.company_page_urn;

      if (!isWithinWorkingHours(settings)) {
        console.log(`[CompanyFollow] Account ${acc.account_id} outside working hours`);
        continue;
      }

      // ── Monthly reset on 1st of month ─────────────────────────────────────
      const nowDate   = new Date();
      const cfMonth   = settings.cf_month || '';
      const thisMonth = `${nowDate.getFullYear()}-${String(nowDate.getMonth()+1).padStart(2,'0')}`;

      if (cfMonth !== thisMonth) {
        console.log(`[CompanyFollow] New month — resetting state for ${acc.account_id}`);
        await patchSettings(acc.account_id, {
          cf_state:           'normal',
          cf_state_since:     new Date().toISOString(),
          cf_month:           thisMonth,
          cf_drip_date:       '',
          cf_drip_sent_today: 0,
        });
        settings.cf_state           = 'normal';
        settings.cf_state_since     = new Date().toISOString();
        settings.cf_month           = thisMonth;
        settings.cf_drip_date       = '';
        settings.cf_drip_sent_today = 0;
      }

      const state      = settings.cf_state || 'normal';
      const stateSince = settings.cf_state_since ? new Date(settings.cf_state_since) : new Date();

      console.log(`[CompanyFollow] Account ${acc.account_id} state: ${state}`);

      // ── State transitions ─────────────────────────────────────────────────

      if (state === 'waiting_5d') {
        const daysPassed = daysBetween(stateSince, nowDate);
        if (daysPassed >= 5) {
          console.log(`[CompanyFollow] ${acc.account_id}: 5 days passed → entering drip mode`);
          await patchSettings(acc.account_id, { cf_state: 'drip', cf_state_since: new Date().toISOString() });
          settings.cf_state = 'drip';
        } else {
          console.log(`[CompanyFollow] ${acc.account_id}: waiting_5d — ${daysPassed.toFixed(1)} days elapsed, need 5`);
          continue;
        }
      }

      if (state === 'waiting_7d') {
        const daysPassed = daysBetween(stateSince, nowDate);
        if (daysPassed >= 7) {
          console.log(`[CompanyFollow] ${acc.account_id}: 7 days passed → resuming drip mode`);
          await patchSettings(acc.account_id, { cf_state: 'drip', cf_state_since: new Date().toISOString() });
          settings.cf_state = 'drip';
        } else {
          console.log(`[CompanyFollow] ${acc.account_id}: waiting_7d — ${daysPassed.toFixed(1)} days elapsed, need 7`);
          continue;
        }
      }

      // ── normal mode ───────────────────────────────────────────────────────
      if (settings.cf_state === 'normal') {
        const sentThisMonth = await countSentThisMonth(acc.account_id);
        const remaining     = MONTHLY_LIMIT - sentThisMonth;

        console.log(`[CompanyFollow] ${acc.account_id}: normal — ${sentThisMonth}/${MONTHLY_LIMIT} sent, ${remaining} remaining`);

        if (remaining <= 0) {
          console.log(`[CompanyFollow] ${acc.account_id}: reached 250 → waiting_5d`);
          await patchSettings(acc.account_id, { cf_state: 'waiting_5d', cf_state_since: new Date().toISOString() });
          continue;
        }

        const contacts = await getPendingContacts(acc.account_id, Math.min(remaining, BATCH_SIZE));
        if (!contacts.length) {
          console.log(`[CompanyFollow] ${acc.account_id}: no pending contacts`);
          continue;
        }

        sendBatch(acc.account_id, companyPageUrn, contacts, settings, 'normal');
      }

      // ── drip mode (5/day) ─────────────────────────────────────────────────
      else if (settings.cf_state === 'drip') {
        const todayStr = toDateStr(nowDate);
        const dripDate = settings.cf_drip_date || '';
        let dripSentToday = (dripDate === todayStr) ? (settings.cf_drip_sent_today || 0) : 0;

        if (dripDate !== todayStr) {
          await patchSettings(acc.account_id, { cf_drip_date: todayStr, cf_drip_sent_today: 0 });
          dripSentToday = 0;
        }

        const canSendToday = 5 - dripSentToday;
        if (canSendToday <= 0) {
          console.log(`[CompanyFollow] ${acc.account_id}: drip — already sent 5 today`);
          continue;
        }

        const contacts = await getPendingContacts(acc.account_id, canSendToday);
        if (!contacts.length) {
          console.log(`[CompanyFollow] ${acc.account_id}: drip — no pending contacts`);
          continue;
        }

        sendBatch(acc.account_id, companyPageUrn, contacts, settings, 'drip');
      }
    }
  } catch (err) {
    console.error('[CompanyFollow] Error in run():', err.message);
  }
}

// ── Batch sender ──────────────────────────────────────────────────────────────

async function sendBatch(accountId, companyPageUrn, contacts, settings, mode) {
  activelySending.add(accountId);
  console.log(`[CompanyFollow] Sending ${contacts.length} follow invites for ${accountId} (mode: ${mode})`);

  for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
    const chunk = contacts.slice(i, i + BATCH_SIZE);

    const elements = chunk.map(c => {
      // FIX: safe profile_data parsing — JSON.parse('null') returns null, not {}
      let pd = {};
      try {
        const raw = typeof c.profile_data === 'string'
          ? JSON.parse(c.profile_data)
          : c.profile_data;
        if (raw && typeof raw === 'object') pd = raw;
      } catch (_) {}

      const memberUrn  = pd.member_urn  || null;
      const providerId = pd.provider_id || null;
      let inviteeMember = null;
      if (memberUrn && memberUrn.startsWith('urn:li:'))  inviteeMember = memberUrn;
      else if (providerId)                                inviteeMember = `urn:li:fsd_profile:${providerId}`;
      return inviteeMember ? { id: c.id, inviteeMember } : null;
    }).filter(Boolean);

    if (!elements.length) {
      console.warn(`[CompanyFollow] Chunk has no valid URNs — contacts may need enrichment`);
      continue;
    }

    try {
      await sendCompanyFollowInvites(accountId, companyPageUrn, elements.map(e => e.inviteeMember));

      const ids = elements.map(e => e.id);
      await db.query(
        'UPDATE contacts SET company_follow_invited = true, company_follow_invited_at = NOW() WHERE id = ANY($1)',
        [ids]
      );

      if (mode === 'drip') {
        const todayStr    = toDateStr(new Date());
        const dripDate    = settings.cf_drip_date || '';
        const prevSent    = (dripDate === todayStr) ? (settings.cf_drip_sent_today || 0) : 0;
        const newSent     = prevSent + ids.length;
        await patchSettings(accountId, { cf_drip_date: todayStr, cf_drip_sent_today: newSent });
        settings.cf_drip_date       = todayStr;
        settings.cf_drip_sent_today = newSent;
      }

      console.log(`[CompanyFollow] ✓ ${ids.length} follow invites sent (account ${accountId})`);
    } catch (err) {
      console.error(`[CompanyFollow] ✗ API error for ${accountId}: ${err.message}`);

      if (mode === 'drip') {
        console.log(`[CompanyFollow] API error in drip — entering waiting_7d for ${accountId}`);
        await patchSettings(accountId, { cf_state: 'waiting_7d', cf_state_since: new Date().toISOString() });
      }
      break;
    }

    const delay = 60000 + Math.random() * 60000;
    console.log(`[CompanyFollow] Waiting ${(delay/1000).toFixed(0)}s...`);
    await sleep(delay);
  }

  if (mode === 'normal') {
    const nowSent = await countSentThisMonth(accountId);
    if (nowSent >= MONTHLY_LIMIT) {
      console.log(`[CompanyFollow] ${accountId}: hit 250 → waiting_5d`);
      await patchSettings(accountId, { cf_state: 'waiting_5d', cf_state_since: new Date().toISOString() });
    }
  }

  activelySending.delete(accountId);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
    ORDER BY
      c.invite_approved DESC,
      c.created_at ASC
    LIMIT $2
  `, [accountId, limit]);
  return rows;
}

/**
 * Safe patch of settings JSONB using parameterized query.
 * Builds jsonb_build_object($2, $3, $4, $5, ...) to avoid SQL injection.
 */
async function patchSettings(accountId, patch) {
  const entries = Object.entries(patch);
  if (!entries.length) return;

  const args  = [accountId];
  const parts = [];
  for (const [k, v] of entries) {
    args.push(k, v === undefined ? null : v);
    parts.push(`$${args.length - 1}, $${args.length}`);
  }

  await db.query(
    `UPDATE unipile_accounts
     SET settings = settings || jsonb_build_object(${parts.join(', ')})
     WHERE account_id = $1`,
    args
  );
}

function isWithinWorkingHours(settings) {
  const now    = new Date();
  const jsDay  = now.getDay();
  const dayKey = String(jsDay === 0 ? 7 : jsDay);
  const hours  = settings.hours?.[dayKey] ?? { on: jsDay >= 1 && jsDay <= 5, from: '09:00', to: '18:00' };
  if (!hours?.on) return false;
  const [fromH, fromM] = (hours.from || '09:00').split(':').map(Number);
  const [toH,   toM  ] = (hours.to   || '18:00').split(':').map(Number);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return nowMin >= fromH * 60 + fromM && nowMin < toH * 60 + toM;
}

function daysBetween(d1, d2) {
  return (d2 - d1) / (1000 * 60 * 60 * 24);
}

function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { start, countSentThisMonth };

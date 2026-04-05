/**
 * Admin Analytics Route
 *
 * GET /api/admin/filter-options
 *   Returns distinct countries (from contacts.location) and companies
 *   (from contacts.company) for the autocomplete filters.
 *
 * GET /api/admin/analytics?from=&to=&country=&company=
 *   Cross-workspace analytics filtered by date range AND optionally by
 *   contact country (location ILIKE) and/or company (company ILIKE).
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db');

// GET /api/admin/filter-options
// Returns distinct values to populate the autocomplete dropdowns.
router.get('/filter-options', async (req, res) => {
  try {
    const [locRes, compRes] = await Promise.all([
      db.query(`
        SELECT DISTINCT TRIM(location) AS value
        FROM contacts
        WHERE location IS NOT NULL AND TRIM(location) != ''
        ORDER BY value
        LIMIT 300
      `),
      db.query(`
        SELECT DISTINCT TRIM(company) AS value
        FROM contacts
        WHERE company IS NOT NULL AND TRIM(company) != ''
        ORDER BY value
        LIMIT 500
      `),
    ]);
    res.json({
      countries: locRes.rows.map(r => r.value).filter(Boolean),
      companies: compRes.rows.map(r => r.value).filter(Boolean),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD&country=&company=
router.get('/analytics', async (req, res) => {
  try {
    const from    = req.query.from    || null;  // date or null
    const to      = req.query.to      || null;  // date or null
    const country = req.query.country || null;  // ILIKE filter on contacts.location
    const company = req.query.company || null;  // ILIKE filter on contacts.company

    // $1 = from, $2 = to, $3 = country, $4 = company
    const p = [from, to, country, company];

    // Date-range conditions on _at timestamp columns ($1/$2 = date bounds)
    const inv  = `ct.invite_sent    = true AND ($1::date IS NULL OR ct.invite_sent_at    >= $1::date) AND ($2::date IS NULL OR ct.invite_sent_at    < $2::date + interval '1 day')`;
    const appr = `ct.invite_approved= true AND ($1::date IS NULL OR ct.invite_approved_at>= $1::date) AND ($2::date IS NULL OR ct.invite_approved_at< $2::date + interval '1 day')`;
    const msgs = `ct.msg_sent       = true AND ($1::date IS NULL OR ct.msg_sent_at        >= $1::date) AND ($2::date IS NULL OR ct.msg_sent_at        < $2::date + interval '1 day')`;
    const repl = `ct.msg_replied    = true AND ($1::date IS NULL OR ct.msg_replied_at     >= $1::date) AND ($2::date IS NULL OR ct.msg_replied_at     < $2::date + interval '1 day')`;
    const pos  = `ct.positive_reply = true AND ($1::date IS NULL OR ct.positive_reply_at  >= $1::date) AND ($2::date IS NULL OR ct.positive_reply_at  < $2::date + interval '1 day')`;
    const added= `($1::date IS NULL OR ct.created_at >= $1::date) AND ($2::date IS NULL OR ct.created_at < $2::date + interval '1 day')`;

    // Pre-filtered contacts subquery ($3/$4 = country/company ILIKE filters)
    // Using a subquery in the JOIN lets us keep LEFT JOIN semantics while
    // restricting which contacts contribute to the aggregate counts.
    const ctJoin = `
      LEFT JOIN (
        SELECT * FROM contacts
        WHERE ($3::text IS NULL OR location ILIKE '%' || $3 || '%')
          AND ($4::text IS NULL OR company  ILIKE '%' || $4 || '%')
      ) ct ON ct.campaign_id = c.id
    `;

    // 1. Per-workspace
    const { rows: byWorkspace } = await db.query(`
      SELECT
        w.id   AS workspace_id,
        w.name AS workspace_name,
        COUNT(DISTINCT c.id)                                     AS campaign_count,
        COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'active') AS active_campaigns,
        COUNT(ct.id) FILTER (WHERE ${added})                    AS contacts_added,
        COUNT(ct.id) FILTER (WHERE ${inv})                      AS invites_sent,
        COUNT(ct.id) FILTER (WHERE ${appr})                     AS invites_approved,
        COUNT(ct.id) FILTER (WHERE ${msgs})                     AS messages_sent,
        COUNT(ct.id) FILTER (WHERE ${repl})                     AS messages_replied,
        COUNT(ct.id) FILTER (WHERE ${pos})                      AS positive_replies
      FROM workspaces w
      LEFT JOIN campaigns c ON c.workspace_id = w.id
      ${ctJoin}
      GROUP BY w.id, w.name
      ORDER BY (COUNT(ct.id) FILTER (WHERE ${inv})) DESC NULLS LAST
    `, p);

    // 2. Per Unipile account
    const { rows: byAccount } = await db.query(`
      SELECT
        c.account_id,
        COALESCE(ua.display_name, c.account_id) AS account_name,
        COALESCE(w.name, '?')                   AS workspace_name,
        COUNT(DISTINCT c.id)                                     AS campaign_count,
        COUNT(ct.id) FILTER (WHERE ${added})                    AS contacts_added,
        COUNT(ct.id) FILTER (WHERE ${inv})                      AS invites_sent,
        COUNT(ct.id) FILTER (WHERE ${appr})                     AS invites_approved,
        COUNT(ct.id) FILTER (WHERE ${msgs})                     AS messages_sent,
        COUNT(ct.id) FILTER (WHERE ${repl})                     AS messages_replied,
        COUNT(ct.id) FILTER (WHERE ${pos})                      AS positive_replies
      FROM campaigns c
      LEFT JOIN workspaces       w  ON w.id          = c.workspace_id
      LEFT JOIN unipile_accounts ua ON ua.account_id = c.account_id
      ${ctJoin}
      WHERE c.account_id IS NOT NULL
      GROUP BY c.account_id, ua.display_name, w.name
      ORDER BY (COUNT(ct.id) FILTER (WHERE ${inv})) DESC NULLS LAST
    `, p);

    // 3. All campaigns
    const { rows: byCampaign } = await db.query(`
      SELECT
        c.id, c.name AS campaign_name, c.status,
        c.account_id, c.workspace_id, c.created_at,
        w.name                                  AS workspace_name,
        COALESCE(ua.display_name, c.account_id) AS account_name,
        COUNT(ct.id) FILTER (WHERE ${added})    AS contacts_added,
        COUNT(ct.id) FILTER (WHERE ${inv})      AS invites_sent,
        COUNT(ct.id) FILTER (WHERE ${appr})     AS invites_approved,
        COUNT(ct.id) FILTER (WHERE ${msgs})     AS messages_sent,
        COUNT(ct.id) FILTER (WHERE ${repl})     AS messages_replied,
        COUNT(ct.id) FILTER (WHERE ${pos})      AS positive_replies
      FROM campaigns c
      LEFT JOIN workspaces       w  ON w.id          = c.workspace_id
      LEFT JOIN unipile_accounts ua ON ua.account_id = c.account_id
      ${ctJoin}
      GROUP BY c.id, c.name, c.status, c.account_id, c.workspace_id, c.created_at, w.name, ua.display_name
      ORDER BY c.created_at DESC
    `, p);

    // 4. Daily timeline filtered by country/company as well.
    // $1/$2 = effectiveFrom/To, $3/$4 = country/company
    const effectiveFrom = from || (() => { const d = new Date(); d.setDate(d.getDate()-29); return d.toISOString().slice(0,10); })();
    const effectiveTo   = to   || new Date().toISOString().slice(0,10);
    const tp = [effectiveFrom, effectiveTo, country, company];

    const ctFilter = `($3::text IS NULL OR location ILIKE '%' || $3 || '%')
        AND ($4::text IS NULL OR company  ILIKE '%' || $4 || '%')`;

    const { rows: timeline } = await db.query(`
      WITH ds AS (
        SELECT generate_series($1::date, $2::date, '1 day'::interval)::date AS d
      ),
      inv  AS (SELECT invite_sent_at::date    AS d, COUNT(*) AS cnt FROM contacts WHERE invite_sent_at::date    BETWEEN $1::date AND $2::date AND ${ctFilter} GROUP BY 1),
      appr AS (SELECT invite_approved_at::date AS d, COUNT(*) AS cnt FROM contacts WHERE invite_approved_at::date BETWEEN $1::date AND $2::date AND ${ctFilter} GROUP BY 1),
      msgs AS (SELECT msg_sent_at::date       AS d, COUNT(*) AS cnt FROM contacts WHERE msg_sent_at::date       BETWEEN $1::date AND $2::date AND ${ctFilter} GROUP BY 1),
      repl AS (SELECT msg_replied_at::date    AS d, COUNT(*) AS cnt FROM contacts WHERE msg_replied_at::date    BETWEEN $1::date AND $2::date AND ${ctFilter} GROUP BY 1),
      pos  AS (SELECT positive_reply_at::date  AS d, COUNT(*) AS cnt FROM contacts WHERE positive_reply_at::date  BETWEEN $1::date AND $2::date AND ${ctFilter} GROUP BY 1),
      adc  AS (SELECT created_at::date         AS d, COUNT(*) AS cnt FROM contacts WHERE created_at::date         BETWEEN $1::date AND $2::date AND ${ctFilter} GROUP BY 1)
      SELECT
        ds.d::text            AS date,
        COALESCE(inv.cnt,  0) AS invites_sent,
        COALESCE(appr.cnt, 0) AS invites_approved,
        COALESCE(msgs.cnt, 0) AS messages_sent,
        COALESCE(repl.cnt, 0) AS messages_replied,
        COALESCE(pos.cnt,  0) AS positive_replies,
        COALESCE(adc.cnt,  0) AS contacts_added
      FROM ds
      LEFT JOIN inv  ON inv.d  = ds.d
      LEFT JOIN appr ON appr.d = ds.d
      LEFT JOIN msgs ON msgs.d = ds.d
      LEFT JOIN repl ON repl.d = ds.d
      LEFT JOIN pos  ON pos.d  = ds.d
      LEFT JOIN adc  ON adc.d  = ds.d
      ORDER BY ds.d
    `, tp);

    // Global summary
    const summary = byWorkspace.reduce((acc, r) => {
      acc.contacts_added   += parseInt(r.contacts_added)   || 0;
      acc.invites_sent     += parseInt(r.invites_sent)     || 0;
      acc.invites_approved += parseInt(r.invites_approved) || 0;
      acc.messages_sent    += parseInt(r.messages_sent)    || 0;
      acc.messages_replied += parseInt(r.messages_replied) || 0;
      acc.positive_replies += parseInt(r.positive_replies) || 0;
      acc.campaign_count   += parseInt(r.campaign_count)   || 0;
      return acc;
    }, { contacts_added:0, invites_sent:0, invites_approved:0, messages_sent:0, messages_replied:0, positive_replies:0, campaign_count:0 });

    res.json({ summary, by_workspace: byWorkspace, by_account: byAccount, by_campaign: byCampaign, timeline });
  } catch (err) {
    console.error('[Admin] Analytics error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/backfill-li-company-url
// Backfill li_company_url on contacts that were saved without it,
// by matching company name against list_companies.
router.post('/backfill-li-company-url', async (req, res) => {
  try {
    const { workspace_id } = req.body;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });

    // Update contacts that have connected_via but no li_company_url
    // by joining to list_companies on matching company name
    const result = await db.query(
      `UPDATE contacts c
        SET li_company_url = lc.li_company_url
        FROM list_companies lc
        JOIN lists l ON l.id = lc.list_id
        WHERE c.workspace_id = $1
          AND l.workspace_id = $1
          AND c.campaign_id IS NULL
          AND (c.li_company_url IS NULL OR c.li_company_url = '')
          AND (
            LOWER(c.company) = LOWER(lc.company_name)
            OR lc.li_company_url ILIKE '%/' || LOWER(REPLACE(c.company, ' ', '-')) || '%'
          )`,
      [workspace_id]
    );
    res.json({ updated: result.rowCount, workspace_id });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/backfill-names
// Enriches contacts that have no first_name/last_name by calling enrichProfile.
// Runs in background — responds immediately.
router.post('/backfill-names', async (req, res) => {
  try {
    const { workspace_id, limit = 200 } = req.body;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });

    // Get contacts without names
    const { rows: contacts } = await db.query(
      "SELECT id, li_profile_url FROM contacts WHERE workspace_id=$1 AND campaign_id IS NULL AND (first_name IS NULL OR first_name = '') AND li_profile_url IS NOT NULL AND li_profile_url != '' LIMIT $2",
      [workspace_id, limit]
    );

    // Get one account for enrichment
    const { rows: accounts } = await db.query(
      'SELECT account_id FROM unipile_accounts WHERE workspace_id=$1 LIMIT 1',
      [workspace_id]
    );

    if (!accounts.length) return res.json({ error: 'no accounts' });
    const accountId = accounts[0].account_id;

    res.json({ status: 'started', total: contacts.length });

    const { enrichProfile } = require('../unipile');

    (async () => {
      let updated = 0, failed = 0;
      for (const c of contacts) {
        try {
          const data = await enrichProfile(accountId, c.li_profile_url);
          if (data && (data.first_name || data.last_name)) {
            await db.query(
              "UPDATE contacts SET first_name=COALESCE(NULLIF($2,''), first_name), last_name=COALESCE(NULLIF($3,''), last_name) WHERE id=$1",
              [c.id, data.first_name || '', data.last_name || '']
            );
            updated++;
          } else { failed++; }
          await new Promise(r => setTimeout(r, 800));
        } catch(e) {
          failed++;
          console.warn('[backfill-names] err:', e.message);
        }
      }
      console.log('[backfill-names] done: updated=' + updated + ' failed=' + failed + ' / ' + contacts.length);
    })().catch(e => console.error('[backfill-names] bg error:', e.message));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

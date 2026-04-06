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
          await new Promise(r => setTimeout(r, 200));
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

// POST /api/admin/backfill-names-from-slug
// Extracts first/last name from the LinkedIn URL slug for contacts with missing names.
// e.g. /in/ran-rubinstein-1a2b3c  -> first="Ran" last="Rubinstein"
// Pure Node.js, no external API calls, runs in ~1 second for all contacts.
router.post('/backfill-names-from-slug', async (req, res) => {
  try {
    const { workspace_id } = req.body;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });

    // Get all contacts without names
    const { rows } = await db.query(
      "SELECT id, li_profile_url FROM contacts WHERE workspace_id=$1 AND campaign_id IS NULL AND (first_name IS NULL OR first_name = '') AND li_profile_url LIKE '%linkedin.com/in/%'",
      [workspace_id]
    );

    if (!rows.length) return res.json({ updated: 0, message: 'No contacts without names' });

    function parseNameFromSlug(url) {
      const m = url.match(/linkedin\.com\/in\/([^/?#]+)/);
      if (!m) return { first: '', last: '' };
      let slug = m[1];
      // Remove numeric/alphanum suffix (LinkedIn ID suffix like -1a2b3c or -123456)
      slug = slug.replace(/-[a-z0-9]{3,12}$/i, '');
      // Remove query string leftovers
      slug = slug.replace(/[?#].*$/, '');
      const parts = slug.split('-').filter(Boolean);
      if (!parts.length) return { first: '', last: '' };
      const capitalize = function(s) { return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); };
      const first = capitalize(parts[0]);
      const last  = parts.slice(1).map(capitalize).join(' ');
      return { first, last };
    }

    // Batch update
    let updated = 0;
    for (const c of rows) {
      const { first, last } = parseNameFromSlug(c.li_profile_url);
      if (first) {
        await db.query(
          'UPDATE contacts SET first_name=$2, last_name=$3 WHERE id=$1',
          [c.id, first, last]
        );
        updated++;
      }
    }

    res.json({ updated, total: rows.length, workspace_id });
  } catch(e) {
    console.error('[backfill-names-from-slug]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/test-get-post?workspace_id=X&urn=Y  — also inserts parent post
router.get('/test-get-post', async (req, res) => {
  try {
    const { workspace_id, urn } = req.query;
    const { rows: accs } = await db.query('SELECT account_id FROM unipile_accounts WHERE workspace_id=$1 LIMIT 1',[workspace_id]);
    if (!accs.length) return res.json({error:'no accounts'});
    const { getPost } = require('../unipile');
    const raw = await getPost(accs[0].account_id, urn);
    if (!raw) return res.json({error:'no raw data returned'});
    
    const postUrn    = raw.social_id || raw.id || urn;
    const authorName = (raw.author && (raw.author.name ||
                        ((raw.author.first_name||'') + ' ' + (raw.author.last_name||'')).trim())) || 'Unknown';
    const authorTitle = (raw.author && (raw.author.headline || raw.author.occupation)) || '';
    const authorPic   = (raw.author && (raw.author.profile_picture_url || raw.author.picture_url ||
                          (Array.isArray(raw.author.profile_picture) ?
                            raw.author.profile_picture[raw.author.profile_picture.length-1]?.url : null))) || '';
    const authorUrl   = raw.author?.public_identifier
                          ? 'https://www.linkedin.com/in/' + raw.author.public_identifier
                          : (raw.author?.profile_url || '');
    const content     = raw.text || raw.content || '';
    const postedAt    = raw.parsed_datetime || (raw.date && !isNaN(Date.parse(raw.date)) ? new Date(raw.date).toISOString() : null);

    let insertResult = 'skipped';
    try {
      const { rowCount } = await db.query(
        `INSERT INTO linkedin_posts
           (campaign_id,workspace_id,contact_id,post_urn,author_name,author_title,
            author_profile_url,author_avatar_url,content,likes_count,comments_count,shares_count,posted_at)
         VALUES (NULL,$1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (post_urn) DO UPDATE SET
           author_name=EXCLUDED.author_name,
           author_title=EXCLUDED.author_title,
           author_avatar_url=EXCLUDED.author_avatar_url,
           content=EXCLUDED.content`,
        [workspace_id, postUrn, authorName, authorTitle, authorUrl, authorPic,
         content, raw.reaction_counter||0, raw.comment_counter||0, raw.repost_counter||0, postedAt]
      );
      insertResult = 'ok rows=' + rowCount;
    } catch(e2) { insertResult = 'INSERT ERROR: ' + e2.message; }

    res.json({
      postUrn, authorName, authorTitle, authorPic: authorPic?.substring(0,60),
      authorUrl, content: content.substring(0,100), insertResult,
      raw_author_keys: raw.author ? Object.keys(raw.author) : null
    });
  } catch(e) { res.status(500).json({error: e.message}); }
});

// POST /api/admin/enrich-campaign
// Fixes bad li_profile_url (missing https://) and queues all contacts
// without provider_id for enrichment so invitationSender can process them.
router.post('/enrich-campaign', async (req, res) => {
  try {
    const { campaign_id, workspace_id } = req.body;
    if (!campaign_id || !workspace_id) return res.status(400).json({ error: 'campaign_id and workspace_id required' });

    // Step 1: Fix URLs missing https://
    const urlFix = await db.query(
      `UPDATE contacts
         SET li_profile_url = 'https://' || li_profile_url
       WHERE campaign_id = $1
         AND li_profile_url IS NOT NULL
         AND li_profile_url != ''
         AND li_profile_url NOT LIKE 'http%'`,
      [campaign_id]
    );

    // Step 2: Get all contacts without provider_id
    const { rows: contacts } = await db.query(
      `SELECT id, li_profile_url FROM contacts
        WHERE campaign_id = $1
          AND (provider_id IS NULL OR provider_id = '')
          AND li_profile_url LIKE '%linkedin.com/in/%'
        ORDER BY id
        LIMIT 2000`,
      [campaign_id]
    );

    // Step 3: Get a workspace account for enrichment
    const { rows: camp } = await db.query('SELECT account_id FROM campaigns WHERE id=$1', [campaign_id]);
    if (!camp.length) return res.json({ error: 'campaign not found' });
    const accountId = camp[0].account_id;

    // Step 4: Enqueue all contacts
    const { enqueue } = require('../enrichment');
    let queued = 0;
    for (const c of contacts) {
      enqueue(c.id, accountId, c.li_profile_url);
      queued++;
    }

    res.json({
      url_fixes: urlFix.rowCount,
      queued_for_enrichment: queued,
      total_contacts: contacts.length,
      account_id: accountId
    });
  } catch(e) {
    console.error('[enrich-campaign]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/copy-provider-ids
// Copies provider_id from contacts that already have it to contacts in a
// target campaign that share the same li_profile_url (same person, different campaign).
// Much faster than re-enriching when both campaigns use the same list.
router.post('/copy-provider-ids', async (req, res) => {
  try {
    const { target_campaign_id, workspace_id } = req.body;
    if (!target_campaign_id || !workspace_id)
      return res.status(400).json({ error: 'target_campaign_id and workspace_id required' });

    // UPDATE contacts in the target campaign by joining on normalised URL
    // to any other contact in the same workspace that already has provider_id
    const { rowCount } = await db.query(`
      UPDATE contacts AS t
      SET    provider_id  = src.provider_id,
             member_urn   = src.member_urn,
             profile_data = COALESCE(t.profile_data, src.profile_data)
      FROM   contacts AS src
      WHERE  t.campaign_id  = $1
        AND  t.workspace_id = $2
        AND  (t.provider_id IS NULL OR t.provider_id = '')
        AND  src.workspace_id = $2
        AND  (src.provider_id IS NOT NULL AND src.provider_id <> '')
        AND  LOWER(REGEXP_REPLACE(t.li_profile_url,   '^https?://', '')) =
             LOWER(REGEXP_REPLACE(src.li_profile_url, '^https?://', ''))
    `, [target_campaign_id, workspace_id]);

    // Count remaining contacts still missing provider_id
    const { rows: remaining } = await db.query(`
      SELECT COUNT(*) AS cnt FROM contacts
      WHERE campaign_id = $1
        AND (provider_id IS NULL OR provider_id = '')
    `, [target_campaign_id]);

    res.json({
      copied: rowCount,
      still_missing: parseInt(remaining[0].cnt, 10)
    });
  } catch(e) {
    console.error('[copy-provider-ids]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/register-message-webhooks
// Registers message_received webhooks for all existing accounts that don't have one yet.
// Safe to run multiple times — skips accounts that already have msg_webhook_id.
router.post('/register-message-webhooks', async (req, res) => {
  try {
    // Ensure msg_webhook_id column exists (idempotent migration)
    await db.query(`ALTER TABLE unipile_accounts ADD COLUMN IF NOT EXISTS msg_webhook_id VARCHAR`).catch(()=>{});

    const SERVER_URL = process.env.SERVER_URL || 'https://interactive-report-production-0c5d.up.railway.app';
    const { createMessageWebhook } = require('../unipile');

    const { rows: accounts } = await db.query(
      `SELECT account_id, display_name FROM unipile_accounts WHERE msg_webhook_id IS NULL`
    );

    let registered = 0, failed = 0, errors = [];
    for (const acc of accounts) {
      try {
        const wId = await createMessageWebhook(acc.account_id, SERVER_URL);
        if (wId) {
          await db.query('UPDATE unipile_accounts SET msg_webhook_id=$1 WHERE account_id=$2', [wId, acc.account_id]);
          console.log('[Admin] msg webhook', wId, 'registered for', acc.display_name || acc.account_id);
          registered++;
        }
      } catch(e) {
        console.warn('[Admin] msg webhook FAILED for', acc.account_id, ':', e.message);
        errors.push({ account_id: acc.account_id, error: e.message });
        failed++;
      }
    }
    res.json({ registered, failed, total: accounts.length, errors });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/test-create-msg-webhook?account_id=X — test single account
router.get('/test-create-msg-webhook', async (req, res) => {
  try {
    const { account_id } = req.query;
    if (!account_id) return res.status(400).json({ error: 'account_id required' });
    const SERVER_URL = process.env.SERVER_URL || 'https://interactive-report-production-0c5d.up.railway.app';
    // Call Unipile directly to see raw response
    const { request } = require('../unipile');
    const raw = await request('/api/v1/webhooks', {
      method: 'POST',
      body: JSON.stringify({
        source: 'messaging',
        name: 'msg_received_' + account_id,
        request_url: SERVER_URL + '/api/webhooks/unipile',
        account_ids: [account_id],
        events: ['message_received'],
        format: 'json',
        headers: [{ key: 'x-webhook-secret', value: process.env.WEBHOOK_SECRET || 'elvia-secret' }]
      })
    });
    res.json({ raw_keys: Object.keys(raw || {}), raw: raw, account_id });
  } catch(e) {
    res.status(500).json({ error: e.message, stack: e.stack?.split('\n').slice(0,3).join(' | ') });
  }
});

// POST /api/admin/enrich-inbox-contacts — background enrichment of inbox contacts with empty names
router.post('/enrich-inbox-contacts', async (req, res) => {
  try {
    const workspace_id = req.body?.workspace_id || req.query.workspace_id;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });
    
    // Respond immediately — run in background
    res.json({ status: 'started', workspace_id });
    
    (async () => {
      const { enrichProfile } = require('../unipile');
      const { rows: contacts } = await db.query(
        `SELECT DISTINCT c.id, c.li_profile_url, t.account_id
         FROM contacts c
         JOIN inbox_threads t ON t.contact_id = c.id
         WHERE c.workspace_id = $1
           AND (c.first_name IS NULL OR c.first_name = '')
           AND c.li_profile_url IS NOT NULL AND c.li_profile_url != ''
         LIMIT 150`,
        [workspace_id]
      );
      let enriched = 0;
      for (const c of contacts) {
        try {
          const profile = await enrichProfile(c.account_id, c.li_profile_url);
          if (profile && (profile.first_name || profile.full_name)) {
            const nameParts = (profile.full_name || '').split(' ');
            const fn  = profile.first_name || nameParts[0] || '';
            const ln  = profile.last_name  || nameParts.slice(1).join(' ') || '';
            const ttl = profile.headline || profile.title || null;
            const pid = profile.provider_id || profile.id || null;
            await db.query(
              'UPDATE contacts SET first_name=$1,last_name=$2,title=$3,provider_id=COALESCE(provider_id,$4) WHERE id=$5',
              [fn, ln, ttl, pid, c.id]
            );
            enriched++;
          }
          await new Promise(r => setTimeout(r, 700));
        } catch(e) { console.warn('[Admin] enrich contact', c.id, ':', e.message); }
      }
      console.log('[Admin] enrich-inbox-contacts done: '+enriched+'/'+contacts.length+' enriched for ws '+workspace_id);
    })().catch(function(e){ console.error('[Admin] enrich background error:', e.message); });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/debug-messages?account_id=X&chat_id=Y — raw Unipile messages structure
router.get('/debug-messages', async (req, res) => {
  try {
    const { account_id, chat_id } = req.query;
    if (!account_id || !chat_id) return res.status(400).json({ error: 'account_id and chat_id required' });
    const { request } = require('../unipile');
    const data = await request('/api/v1/chats/' + encodeURIComponent(chat_id) + '/messages?account_id=' + encodeURIComponent(account_id) + '&limit=5');
    const items = (data?.items || []).slice(0, 3);
    res.json({ 
      count: items.length,
      fields: items[0] ? Object.keys(items[0]) : [],
      samples: items.map(function(m) {
        return { 
          id: m.id, 
          from_me: m.from_me, 
          is_sender: m.is_sender,
          sender_type: m.sender_type,
          is_me: m.is_me,
          role: m.role,
          sender: m.sender ? { id: m.sender.attendee_provider_id, name: m.sender.attendee_name } : null,
          text_preview: (m.text || m.body || '').substring(0,40)
        };
      })
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/fix-message-directions — fixes direction for all existing messages
router.post('/fix-message-directions', async (req, res) => {
  const { workspace_id } = req.body;
  if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });
  res.json({ status: 'started', workspace_id });
  try {
    const { rows: threads } = await db.query(
      'SELECT t.id, t.thread_id, t.account_id FROM inbox_threads t WHERE t.workspace_id = $1 ORDER BY t.updated_at DESC',
      [workspace_id]
    );
    const DSN = process.env.UNIPILE_DSN;
    const KEY = process.env.UNIPILE_API_KEY;
    let fixed = 0;
    for (const thread of threads) {
      try {
        const r = await fetch(
          DSN+'/api/v1/chats/'+encodeURIComponent(thread.thread_id)+'/messages?account_id='+encodeURIComponent(thread.account_id)+'&limit=20',
          { headers: { 'X-API-KEY': KEY, 'accept': 'application/json' } }
        );
        if (!r.ok) continue;
        const data = await r.json();
        const msgs = Array.isArray(data?.items) ? data.items : [];
        for (const msg of msgs) {
          if (!msg.id) continue;
          const dir = (msg.is_sender === 1 || msg.is_sender === true) ? 'sent' : 'received';
          await db.query(
            'UPDATE inbox_messages SET direction=$1 WHERE thread_id=$2 AND unipile_msg_id=$3',
            [dir, thread.id, msg.id]
          );
        }
        fixed++;
        await new Promise(r=>setTimeout(r,150));
      } catch(e) {}
    }
    console.log('[Admin] fix-message-directions: fixed', fixed, '/', threads.length, 'threads for ws', workspace_id);
  } catch(e) { console.error('[Admin] fix-message-directions error:', e.message); }
});

// POST /api/admin/sync-opp-contacts-to-inbox
// Finds all opportunities contacts with provider_id, fetches their Unipile chat, 
// creates inbox thread + syncs 20 messages for each.
router.post('/sync-opp-contacts-to-inbox', async (req, res) => {
  const { workspace_id } = req.body;
  if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });
  res.json({ status: 'started', workspace_id });

  try {
    const DSN = process.env.UNIPILE_DSN;
    const KEY = process.env.UNIPILE_API_KEY;

    // Get all accounts in workspace
    const { rows: accounts } = await db.query(
      'SELECT account_id FROM unipile_accounts WHERE workspace_id = $1', [workspace_id]
    );

    // Get all opportunity contacts with provider_id
    const { rows: contacts } = await db.query(
      `SELECT DISTINCT c.id, c.first_name, c.last_name, c.provider_id, c.li_profile_url, c.campaign_id
       FROM contacts c
       INNER JOIN campaigns camp ON camp.id = c.campaign_id
       WHERE camp.workspace_id = $1
         AND c.provider_id IS NOT NULL AND c.provider_id != ''
         AND NOT EXISTS (SELECT 1 FROM inbox_threads it WHERE it.contact_id = c.id)`,
      [workspace_id]
    );

    console.log('[Admin] sync-opp-contacts: found', contacts.length, 'contacts without inbox thread');
    let synced = 0;

    for (const contact of contacts) {
      // Find the account for this contact's campaign
      const { rows: campAcc } = await db.query(
        'SELECT account_id FROM campaigns WHERE id = $1', [contact.campaign_id]
      );
      const accountId = campAcc[0]?.account_id || accounts[0]?.account_id;
      if (!accountId) continue;

      try {
        // Find chat with this contact on Unipile
        const chatRes = await fetch(
          `${DSN}/api/v1/chats?account_id=${encodeURIComponent(accountId)}&limit=50`,
          { headers: { 'X-API-KEY': KEY, 'accept': 'application/json' } }
        );
        if (!chatRes.ok) continue;
        const chatData = await chatRes.json();
        const chats = Array.isArray(chatData?.items) ? chatData.items : [];

        // Find chat matching this contact's provider_id
        const chat = chats.find(function(c) {
          return c.attendee_provider_id === contact.provider_id;
        });
        if (!chat) continue;

        const chatId = chat.id;

        // Upsert inbox thread
        const { rows: threadRows } = await db.query(
          `INSERT INTO inbox_threads (campaign_id, workspace_id, contact_id, account_id, thread_id, updated_at)
           VALUES ($1,$2,$3,$4,$5,NOW())
           ON CONFLICT (thread_id) DO UPDATE SET updated_at=NOW()
           RETURNING id`,
          [contact.campaign_id, workspace_id, contact.id, accountId, chatId]
        );
        const threadDbId = threadRows[0]?.id;
        if (!threadDbId) continue;

        // Sync last 20 messages
        const msgRes = await fetch(
          `${DSN}/api/v1/chats/${encodeURIComponent(chatId)}/messages?account_id=${encodeURIComponent(accountId)}&limit=20`,
          { headers: { 'X-API-KEY': KEY, 'accept': 'application/json' } }
        );
        if (msgRes.ok) {
          const msgData = await msgRes.json();
          const msgs = Array.isArray(msgData?.items) ? msgData.items.reverse() : [];
          let lastMsg = null;
          for (const msg of msgs) {
            if (!msg.id) continue;
            const dir = (msg.is_sender === 1 || msg.is_sender === true) ? 'sent' : 'received';
            const content = msg.text || msg.body || '';
            const sentAt  = msg.timestamp || msg.created_at || null;
            await db.query(
              `INSERT INTO inbox_messages (thread_id, unipile_msg_id, direction, content, sent_at)
               VALUES ($1,$2,$3,$4,$5) ON CONFLICT (unipile_msg_id) DO NOTHING`,
              [threadDbId, msg.id, dir, content, sentAt]
            );
            lastMsg = { content: content.slice(0,120), sentAt };
          }
          if (lastMsg) {
            await db.query(
              'UPDATE inbox_threads SET last_message_at=$1, last_message_preview=$2, updated_at=NOW() WHERE id=$3',
              [lastMsg.sentAt, lastMsg.content, threadDbId]
            );
          }
        }
        synced++;
        await new Promise(r => setTimeout(r, 300));
      } catch(e) { console.warn('[Admin] sync-opp contact', contact.id, e.message); }
    }
    console.log('[Admin] sync-opp-contacts-to-inbox: synced', synced, '/', contacts.length, 'for ws', workspace_id);
  } catch(e) { console.error('[Admin] sync-opp-contacts-to-inbox error:', e.message); }
});

module.exports = router;
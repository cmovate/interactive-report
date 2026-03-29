/**
 * Admin Analytics Route
 * GET /api/admin/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Returns cross-workspace analytics:
 * - Global summary
 * - Per workspace breakdown
 * - Per Unipile account breakdown
 * - Per campaign breakdown
 * - Daily timeline (when date range provided)
 *
 * All date filtering uses _at timestamp columns so numbers
 * reflect WHEN actions actually happened, not cumulative totals.
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db');

router.get('/analytics', async (req, res) => {
  try {
    const from = req.query.from || null;  // YYYY-MM-DD or null (= all time)
    const to   = req.query.to   || null;
    const p    = [from, to];  // $1, $2 reused throughout

    // When $1/$2 are NULL, conditions collapse to TRUE (no date bound)
    // When given, conditions filter by the _at timestamp column for the period.
    // The boolean col (invite_sent, etc.) is always checked so we don't count
    // contacts where the action timestamp is missing.
    const inv  = `ct.invite_sent    = true AND ($1::date IS NULL OR ct.invite_sent_at    >= $1::date) AND ($2::date IS NULL OR ct.invite_sent_at    < $2::date + interval '1 day')`;
    const appr = `ct.invite_approved= true AND ($1::date IS NULL OR ct.invite_approved_at>= $1::date) AND ($2::date IS NULL OR ct.invite_approved_at< $2::date + interval '1 day')`;
    const msgs = `ct.msg_sent       = true AND ($1::date IS NULL OR ct.msg_sent_at        >= $1::date) AND ($2::date IS NULL OR ct.msg_sent_at        < $2::date + interval '1 day')`;
    const repl = `ct.msg_replied    = true AND ($1::date IS NULL OR ct.msg_replied_at     >= $1::date) AND ($2::date IS NULL OR ct.msg_replied_at     < $2::date + interval '1 day')`;
    const pos  = `ct.positive_reply = true AND ($1::date IS NULL OR ct.positive_reply_at  >= $1::date) AND ($2::date IS NULL OR ct.positive_reply_at  < $2::date + interval '1 day')`;
    const added= `($1::date IS NULL OR ct.created_at >= $1::date) AND ($2::date IS NULL OR ct.created_at < $2::date + interval '1 day')`;

    // 1. Per-workspace breakdown
    const { rows: byWorkspace } = await db.query(`
      SELECT
        w.id   AS workspace_id,
        w.name AS workspace_name,
        COUNT(DISTINCT c.id)                                               AS campaign_count,
        COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'active')           AS active_campaigns,
        COUNT(ct.id) FILTER (WHERE ${added})                              AS contacts_added,
        COUNT(ct.id) FILTER (WHERE ${inv})                                AS invites_sent,
        COUNT(ct.id) FILTER (WHERE ${appr})                               AS invites_approved,
        COUNT(ct.id) FILTER (WHERE ${msgs})                               AS messages_sent,
        COUNT(ct.id) FILTER (WHERE ${repl})                               AS messages_replied,
        COUNT(ct.id) FILTER (WHERE ${pos})                                AS positive_replies
      FROM workspaces w
      LEFT JOIN campaigns c  ON c.workspace_id = w.id
      LEFT JOIN contacts  ct ON ct.campaign_id  = c.id
      GROUP BY w.id, w.name
      ORDER BY (COUNT(ct.id) FILTER (WHERE ${inv})) DESC NULLS LAST
    `, p);

    // 2. Per Unipile account breakdown
    const { rows: byAccount } = await db.query(`
      SELECT
        c.account_id,
        COALESCE(ua.display_name, c.account_id)  AS account_name,
        COALESCE(w.name, '?')                    AS workspace_name,
        COUNT(DISTINCT c.id)                                               AS campaign_count,
        COUNT(ct.id) FILTER (WHERE ${added})                              AS contacts_added,
        COUNT(ct.id) FILTER (WHERE ${inv})                                AS invites_sent,
        COUNT(ct.id) FILTER (WHERE ${appr})                               AS invites_approved,
        COUNT(ct.id) FILTER (WHERE ${msgs})                               AS messages_sent,
        COUNT(ct.id) FILTER (WHERE ${repl})                               AS messages_replied,
        COUNT(ct.id) FILTER (WHERE ${pos})                                AS positive_replies
      FROM campaigns c
      LEFT JOIN workspaces     w  ON w.id          = c.workspace_id
      LEFT JOIN unipile_accounts ua ON ua.account_id = c.account_id
      LEFT JOIN contacts        ct ON ct.campaign_id = c.id
      WHERE c.account_id IS NOT NULL
      GROUP BY c.account_id, ua.display_name, w.name
      ORDER BY (COUNT(ct.id) FILTER (WHERE ${inv})) DESC NULLS LAST
    `, p);

    // 3. All campaigns
    const { rows: byCampaign } = await db.query(`
      SELECT
        c.id, c.name AS campaign_name, c.status,
        c.account_id, c.workspace_id, c.created_at,
        w.name                                   AS workspace_name,
        COALESCE(ua.display_name, c.account_id)  AS account_name,
        COUNT(ct.id) FILTER (WHERE ${added})     AS contacts_added,
        COUNT(ct.id) FILTER (WHERE ${inv})       AS invites_sent,
        COUNT(ct.id) FILTER (WHERE ${appr})      AS invites_approved,
        COUNT(ct.id) FILTER (WHERE ${msgs})      AS messages_sent,
        COUNT(ct.id) FILTER (WHERE ${repl})      AS messages_replied,
        COUNT(ct.id) FILTER (WHERE ${pos})       AS positive_replies
      FROM campaigns c
      LEFT JOIN workspaces       w  ON w.id          = c.workspace_id
      LEFT JOIN unipile_accounts ua ON ua.account_id = c.account_id
      LEFT JOIN contacts         ct ON ct.campaign_id = c.id
      GROUP BY c.id, c.name, c.status, c.account_id, c.workspace_id, c.created_at, w.name, ua.display_name
      ORDER BY c.created_at DESC
    `, p);

    // 4. Daily timeline (always generated for the given range; fallback = last 30 days)
    const effectiveFrom = from || (() => { const d = new Date(); d.setDate(d.getDate()-29); return d.toISOString().slice(0,10); })();
    const effectiveTo   = to   || new Date().toISOString().slice(0,10);

    const { rows: timeline } = await db.query(`
      WITH ds AS (
        SELECT generate_series($3::date, $4::date, '1 day'::interval)::date AS d
      ),
      inv  AS (SELECT invite_sent_at::date   AS d, COUNT(*) AS cnt FROM contacts WHERE invite_sent_at::date    BETWEEN $3::date AND $4::date GROUP BY 1),
      appr AS (SELECT invite_approved_at::date AS d, COUNT(*) AS cnt FROM contacts WHERE invite_approved_at::date BETWEEN $3::date AND $4::date GROUP BY 1),
      msgs AS (SELECT msg_sent_at::date      AS d, COUNT(*) AS cnt FROM contacts WHERE msg_sent_at::date       BETWEEN $3::date AND $4::date GROUP BY 1),
      repl AS (SELECT msg_replied_at::date   AS d, COUNT(*) AS cnt FROM contacts WHERE msg_replied_at::date    BETWEEN $3::date AND $4::date GROUP BY 1),
      pos  AS (SELECT positive_reply_at::date AS d, COUNT(*) AS cnt FROM contacts WHERE positive_reply_at::date BETWEEN $3::date AND $4::date GROUP BY 1),
      adc  AS (SELECT created_at::date        AS d, COUNT(*) AS cnt FROM contacts WHERE created_at::date        BETWEEN $3::date AND $4::date GROUP BY 1)
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
    `, [from, to, effectiveFrom, effectiveTo]);

    // Aggregate global summary from by_workspace rows
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

module.exports = router;

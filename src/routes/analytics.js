const express = require('express');
const router  = express.Router();
const db      = require('../db');

// GET /api/analytics?workspace_id=&date_from=&date_to=&campaign_id=
router.get('/', async (req, res) => {
  try {
    const { workspace_id, campaign_id } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });

    const dateFrom = req.query.date_from || new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0];
    const dateTo   = req.query.date_to   || new Date().toISOString().split('T')[0];

    // Build WHERE
    let where = 'c.workspace_id = $1';
    const params = [workspace_id, dateFrom + 'T00:00:00Z', dateTo + 'T23:59:59Z'];
    if (campaign_id) { where += ' AND c.campaign_id = $4'; params.push(campaign_id); }

    const sql = `
      SELECT
        c.campaign_id,
        cam.name AS campaign_name,
        -- Connection
        COUNT(*) FILTER (WHERE c.invite_sent_at BETWEEN $2 AND $3)     AS invites_sent,
        COUNT(*) FILTER (WHERE c.invite_approved_at BETWEEN $2 AND $3) AS invites_approved,
        COUNT(*) FILTER (WHERE c.invite_withdrawn_at BETWEEN $2 AND $3) AS invites_withdrawn,
        -- Messaging
        COUNT(*) FILTER (WHERE c.msg_sent_at BETWEEN $2 AND $3)        AS messages_sent,
        COUNT(*) FILTER (WHERE c.msg_replied_at BETWEEN $2 AND $3)     AS replies_received,
        COUNT(*) FILTER (WHERE c.positive_reply_at BETWEEN $2 AND $3)  AS positive_replies,
        -- Engagement personal
        COALESCE(SUM(c.post_likes_sent)    FILTER (WHERE c.likes_sent_at BETWEEN $2 AND $3), 0)    AS post_likes,
        COALESCE(SUM(c.comment_likes_sent) FILTER (WHERE c.likes_sent_at BETWEEN $2 AND $3), 0)    AS comment_likes,
        -- Engagement company
        COALESCE(SUM(c.company_post_likes_sent)    FILTER (WHERE c.company_likes_sent_at BETWEEN $2 AND $3), 0) AS company_post_likes,
        COALESCE(SUM(c.company_comment_likes_sent) FILTER (WHERE c.company_likes_sent_at BETWEEN $2 AND $3), 0) AS company_comment_likes,
        -- Company follow
        COUNT(*) FILTER (WHERE c.company_follow_invited_at   BETWEEN $2 AND $3) AS company_follow_invites,
        COUNT(*) FILTER (WHERE c.company_follow_confirmed_at BETWEEN $2 AND $3) AS company_follow_confirmed,
        -- Profile views
        COALESCE(SUM(c.profile_view_count) FILTER (WHERE c.last_profile_view_at BETWEEN $2 AND $3), 0) AS profile_views,
        COUNT(*) FILTER (WHERE c.last_profile_view_at BETWEEN $2 AND $3) AS contacts_viewed
      FROM contacts c
      JOIN campaigns cam ON cam.id = c.campaign_id
      WHERE ${where}
      GROUP BY c.campaign_id, cam.name
      ORDER BY cam.name
    `;

    const { rows: campaigns } = await db.query(sql, params);

    // Totals
    const totals = {
      invites_sent: 0, invites_approved: 0, invites_withdrawn: 0,
      messages_sent: 0, replies_received: 0, positive_replies: 0,
      post_likes: 0, comment_likes: 0, company_post_likes: 0, company_comment_likes: 0,
      company_follow_invites: 0, company_follow_confirmed: 0,
      profile_views: 0, contacts_viewed: 0
    };
    for (const row of campaigns) {
      for (const key of Object.keys(totals)) {
        totals[key] += parseInt(row[key]) || 0;
      }
    }

    res.json({ campaigns, totals, date_from: dateFrom, date_to: dateTo });
  } catch (e) {
    console.error('[Analytics]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

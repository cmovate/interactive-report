/**
 * src/routes/signals.js
 *
 * Signals — inbound LinkedIn intent events.
 *
 * Sources:
 *   1. signals table — real webhook events (new_relation, message_received etc.)
 *   2. Derived signals — synthesized from existing data:
 *      - invite_accepted: enrollments where status went to 'approved'
 *      - message_replied: enrollments where status is 'replied' or 'positive_reply'
 *      - positive_reply: enrollments with positive_reply status
 *
 * GET  /api/signals?workspace_id=&type=&is_known=&page=&limit=
 * GET  /api/signals/stats?workspace_id=
 * POST /api/signals/:id/dismiss
 * POST /api/signals/:id/add-to-list
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db');

// ── Signal type metadata ──────────────────────────────────────────────────────
// ── Signal type metadata ──────────────────────────────────────────────────────
const SIGNAL_META = {
  inbound_message:   { icon: '💌', label: 'Wrote to Us',       color: '#EC4899', priority: 8 },
  unsolicited_message:{ icon: '📩', label: 'New Message',       color: '#EC4899', priority: 7 },
  invite_accepted:   { icon: '🤝', label: 'Accepted Invite',   color: '#1D9E75', priority: 3 },
  message_received:  { icon: '💬', label: 'Replied',           color: '#3B82F6', priority: 5 },
  positive_reply:    { icon: '⭐', label: 'Positive Reply',    color: '#F59E0B', priority: 6 },
  profile_view:      { icon: '👁️', label: 'Viewed Profile',   color: '#8B5CF6', priority: 4 },
  invitation_received:{ icon: '🔔', label: 'Sent Invite to Us',color: '#EC4899', priority: 5 },
  reaction_received: { icon: '👍', label: 'Liked Post',        color: '#F97316', priority: 2 },
  comment_received:  { icon: '💭', label: 'Commented',         color: '#06B6D4', priority: 4 },
  company_follow:    { icon: '🏢', label: 'Followed Company',  color: '#6366F1', priority: 3 },
  new_relation:      { icon: '✅', label: 'Connected',         color: '#10B981', priority: 3 },
};

// ── GET /api/signals?workspace_id=&type=&is_known=&page=&limit= ───────────────
router.get('/', async (req, res) => {
  try {
    const { workspace_id, type, is_known } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });
    const wsId  = parseInt(workspace_id);
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = (page - 1) * limit;

    // Build WHERE for real signals
    const conds  = ['s.workspace_id = $1'];
    const params = [wsId];
    if (type && type !== 'all') {
      if (type === 'inbound_message') {
        conds.push(`s.type IN ('inbound_message','unsolicited_message')`);
      } else {
        params.push(type); conds.push(`s.type = \$${params.length}`);
      }
    }
    const aiPriority = req.query.ai_priority || null;
    if (aiPriority) { params.push(aiPriority); conds.push(`s.ai_priority = $${params.length}`); }
    if (is_known === 'true') { conds.push('s.is_known = true'); }
    const where = conds.join(' AND ');

    // Real signals from signals table
    const { rows: realSignals } = await db.query(`
      SELECT
        s.id, s.type, s.actor_name, s.actor_li_url, s.actor_provider_id,
        s.actor_headline, s.is_known, s.content, s.post_url,
        s.occurred_at, s.created_at, s.subject_li_account_id,
        (s.raw_data->>'chat_id') AS chat_id,
        s.ai_priority, s.ai_action, s.ai_reason, s.ai_fit_score,
        c.first_name, c.last_name, c.company AS contact_company,
        c.title AS contact_title, c.li_profile_url AS contact_li_url,
        e.id AS enrollment_id, e.status AS enrollment_status,
        e.campaign_id,
        camp.name AS campaign_name,
        ua.display_name AS account_name,
        'real' AS source
      FROM signals s
      LEFT JOIN contacts       c    ON c.id  = s.actor_contact_id
      LEFT JOIN enrollments    e    ON e.contact_id = c.id AND e.campaign_id IN (
        SELECT id FROM campaigns WHERE workspace_id = $1
      )
      LEFT JOIN campaigns      camp ON camp.id = e.campaign_id
      LEFT JOIN unipile_accounts ua ON ua.account_id = s.subject_li_account_id AND ua.workspace_id = $1
      WHERE ${where}
      ORDER BY s.occurred_at DESC NULLS LAST
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    // If no real signals yet, synthesize from enrollment history
    let synthesized = [];
    if (realSignals.length === 0 && (!type || type === 'all' || ['invite_accepted','message_received','positive_reply'].includes(type))) {
      const typeFilter = type && type !== 'all'
        ? `AND e.status = '${type === 'invite_accepted' ? 'approved' : type === 'positive_reply' ? 'positive_reply' : 'replied'}'`
        : `AND e.status IN ('approved','messaged','replied','positive_reply')`;

      const { rows: synth } = await db.query(`
        SELECT
          e.id AS enrollment_id,
          e.status,
          e.invite_approved_at,
          e.updated_at,
          c.id AS contact_id,
          c.first_name, c.last_name, c.company, c.title,
          c.li_profile_url, c.chat_id,
          camp.name AS campaign_name,
          camp.account_id,
          ua.display_name AS account_name,
          (SELECT LEFT(m.content,200) FROM inbox_messages m
           JOIN inbox_threads t ON t.id = m.thread_id
           WHERE t.thread_id = COALESCE(e.chat_id, c.chat_id)
             AND m.direction = 'received'
           ORDER BY m.sent_at DESC LIMIT 1) AS last_reply
        FROM enrollments e
        JOIN contacts c ON c.id = e.contact_id
        JOIN campaigns camp ON camp.id = e.campaign_id
        LEFT JOIN unipile_accounts ua ON ua.account_id = camp.account_id AND ua.workspace_id = $1
        WHERE camp.workspace_id = $1
          ${typeFilter}
        ORDER BY
          CASE e.status
            WHEN 'positive_reply' THEN 1
            WHEN 'replied'        THEN 2
            WHEN 'messaged'       THEN 3
            ELSE 4
          END,
          e.updated_at DESC
        LIMIT $2 OFFSET $3
      `, [wsId, limit, offset]);

      synthesized = synth.map(r => {
        let signalType = 'invite_accepted';
        if (r.status === 'positive_reply') signalType = 'positive_reply';
        else if (r.status === 'replied') signalType = 'message_received';
        else if (r.status === 'messaged') signalType = 'invite_accepted';
        return {
          id: `synth_${r.enrollment_id}`,
          type: signalType,
          actor_name: [r.first_name, r.last_name].filter(Boolean).join(' '),
          actor_li_url: r.li_profile_url,
          contact_li_url: r.li_profile_url,
          contact_company: r.company,
          contact_title: r.title,
          is_known: true,
          content: r.last_reply || null,
          occurred_at: r.updated_at,
          enrollment_id: r.enrollment_id,
          enrollment_status: r.status,
          campaign_name: r.campaign_name,
          account_name: r.account_name,
          chat_id: r.chat_id,
          source: 'derived',
          first_name: r.first_name,
          last_name: r.last_name,
        };
      });
    }

    const items = realSignals.length > 0 ? realSignals : synthesized;
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) FROM signals s WHERE ${where}`, params
    );
    const total = parseInt(countRows[0]?.count || 0) || items.length;

    res.json({ items, total, page, limit, source: realSignals.length > 0 ? 'real' : 'derived' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/signals/stats?workspace_id= ─────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const { workspace_id } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });
    const wsId = parseInt(workspace_id);

    // Real signal stats (all types including inbound_message, unsolicited_message)
    const { rows: signalStats } = await db.query(`
      SELECT type, COUNT(*) as n, COUNT(*) FILTER (WHERE is_known) as known_n,
             COUNT(*) FILTER (WHERE ai_priority='HOT') as hot_n
      FROM signals WHERE workspace_id = $1
      GROUP BY type ORDER BY n DESC
    `, [wsId]);

    // Derived stats from enrollments
    // Count real inbound signals
    const totalReal = signalStats.reduce((s,r) => s + parseInt(r.n), 0);
    const hotCount  = signalStats.reduce((s,r) => s + parseInt(r.hot_n||0), 0);
    const inboundCount = signalStats.filter(r => ['inbound_message','unsolicited_message'].includes(r.type))
      .reduce((s,r) => s+parseInt(r.n),0);

    // Derived from enrollments (shown when no real signals)
    const { rows: enrollStats } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE e.status IN ('approved','messaged','replied','positive_reply')) AS total_activity,
        COUNT(*) FILTER (WHERE e.status = 'positive_reply') AS positive_replies,
        COUNT(*) FILTER (WHERE e.status IN ('replied','positive_reply')) AS replies,
        COUNT(*) FILTER (WHERE e.status IN ('approved','messaged','replied','positive_reply')) AS connections
      FROM enrollments e
      JOIN campaigns camp ON camp.id = e.campaign_id
      WHERE camp.workspace_id = $1
    `, [wsId]);

    const stats = enrollStats[0] || {};

    res.json({
      real_signals: signalStats,
      total_real: totalReal,
      hot_count: hotCount,
      inbound_count: inboundCount,
      derived: {
        connections: parseInt(stats.connections) || 0,
        replies: parseInt(stats.replies) || 0,
        positive_replies: parseInt(stats.positive_replies) || 0,
        total: totalReal > 0 ? totalReal : (parseInt(stats.total_activity) || 0),
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/signals/:id/dismiss ────────────────────────────────────────────
router.post('/:id/dismiss', async (req, res) => {
  const { id } = req.params;
  if (id.startsWith('synth_')) return res.json({ ok: true });
  await db.query('UPDATE signals SET is_notified=true WHERE id=$1', [id]).catch(()=>{});
  res.json({ ok: true });
});

module.exports = router;

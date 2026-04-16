/**
 * src/routes/signals.js
 *
 * Signals (inbound LinkedIn events) — the Feed tab.
 *
 * GET /api/workspaces/:wsId/feed     — paginated signal stream
 * GET /api/workspaces/:wsId/signals  — same, with more filters
 * POST /api/signals/:id/add-to-list  — add unknown actor to a list
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db');

// GET /api/signals?workspace_id=&type=&is_known=&from=&to=&page=&limit=
router.get('/', async (req, res) => {
  try {
    const { workspace_id, type, is_known, from, to } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });

    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = (page - 1) * limit;

    const conds  = ['s.workspace_id = $1'];
    const params = [workspace_id];

    if (type) {
      params.push(type);
      conds.push(`s.type = $${params.length}`);
    }
    if (is_known !== undefined) {
      params.push(is_known === 'true' || is_known === true);
      conds.push(`s.is_known = $${params.length}`);
    }
    if (from) {
      params.push(from);
      conds.push(`s.occurred_at >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      conds.push(`s.occurred_at <= $${params.length}`);
    }

    const where = conds.join(' AND ');

    const { rows: total } = await db.query(
      `SELECT COUNT(*) FROM signals s WHERE ${where}`, params
    );

    const { rows } = await db.query(`
      SELECT
        s.*,
        c.first_name, c.last_name, c.company, c.title, c.li_profile_url AS contact_li_url,
        ta.name AS target_account_name
      FROM signals s
      LEFT JOIN contacts       c  ON c.id  = s.actor_contact_id
      LEFT JOIN target_accounts ta ON ta.id = s.actor_target_account_id
      WHERE ${where}
      ORDER BY s.occurred_at DESC NULLS LAST
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    res.json({
      items: rows,
      total: parseInt(total[0].count),
      page, limit,
      pages: Math.ceil(parseInt(total[0].count) / limit) || 1,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/signals/:id/add-to-list — add unknown actor to a list
router.post('/:id/add-to-list', async (req, res) => {
  try {
    const { workspace_id, list_id } = req.body;
    if (!workspace_id || !list_id) return res.status(400).json({ error: 'workspace_id and list_id required' });

    const signalId = parseInt(req.params.id);
    const { rows: sig } = await db.query(
      'SELECT * FROM signals WHERE id=$1 AND workspace_id=$2',
      [signalId, workspace_id]
    );
    if (!sig.length) return res.status(404).json({ error: 'Signal not found' });
    const signal = sig[0];

    if (!signal.actor_li_url && !signal.actor_provider_id)
      return res.status(400).json({ error: 'Signal has no actor URL' });

    // Upsert contact
    const liUrl = signal.actor_li_url ||
      (signal.actor_provider_id ? `https://www.linkedin.com/in/${signal.actor_provider_id}` : null);

    const { rows: existing } = await db.query(
      'SELECT id FROM contacts WHERE workspace_id=$1 AND li_profile_url=$2 LIMIT 1',
      [workspace_id, liUrl]
    );

    let contactId;
    if (existing.length) {
      contactId = existing[0].id;
    } else {
      const { rows: ins } = await db.query(`
        INSERT INTO contacts (workspace_id, li_profile_url, first_name, last_name, title, provider_id)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
      `, [
        workspace_id, liUrl,
        signal.actor_name?.split(' ')[0] || '',
        signal.actor_name?.split(' ').slice(1).join(' ') || '',
        signal.actor_headline || '',
        signal.actor_provider_id || null,
      ]);
      contactId = ins[0].id;
    }

    // Add to list
    await db.query(
      'INSERT INTO list_contacts (list_id, contact_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [list_id, contactId]
    );

    // Mark signal as known
    await db.query(
      `UPDATE signals SET is_known=true, actor_contact_id=$2 WHERE id=$1`,
      [signalId, contactId]
    );

    res.json({ success: true, contact_id: contactId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

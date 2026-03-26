const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { reExtractAll } = require('../enrichment');

// GET /api/contacts?workspace_id=&campaign_id=&q=
router.get('/', async (req, res) => {
  try {
    const { workspace_id, campaign_id, q } = req.query;
    const conditions = [];
    const params = [];

    if (workspace_id) { params.push(workspace_id); conditions.push(`c.workspace_id = $${params.length}`); }
    if (campaign_id)  { params.push(campaign_id);  conditions.push(`c.campaign_id  = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      const i = params.length;
      conditions.push(
        `(c.first_name ILIKE $${i} OR c.last_name ILIKE $${i} OR c.company ILIKE $${i} OR c.title ILIKE $${i} OR c.email ILIKE $${i})`
      );
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await db.query(
      `SELECT c.*, camp.name AS campaign_name
       FROM contacts c
       LEFT JOIN campaigns camp ON camp.id = c.campaign_id
       ${where}
       ORDER BY c.created_at DESC`,
      params
    );
    res.json({ items: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/contacts/re-extract?workspace_id=X
 *
 * Re-runs field extraction on all contacts that already have profile_data
 * stored in the DB — NO new Unipile API calls.
 * Use this to fix extraction bugs on existing contacts.
 */
router.post('/re-extract', async (req, res) => {
  try {
    const workspace_id = req.query.workspace_id || req.body.workspace_id;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });
    const result = await reExtractAll(workspace_id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/contacts/:id
router.delete('/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM contacts WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/contacts (bulk)
router.delete('/', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
    await db.query('DELETE FROM contacts WHERE id = ANY($1)', [ids]);
    res.json({ success: true, deleted: ids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

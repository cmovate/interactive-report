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
      conditions.push(`(c.first_name ILIKE $${i} OR c.last_name ILIKE $${i} OR c.company ILIKE $${i} OR c.title ILIKE $${i} OR c.email ILIKE $${i})`);
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await db.query(
      `SELECT c.*, camp.name AS campaign_name FROM contacts c LEFT JOIN campaigns camp ON camp.id = c.campaign_id ${where} ORDER BY c.created_at DESC`,
      params
    );
    res.json({ items: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/contacts/debug-profile/:id
// Returns the raw Unipile profile_data + a flat key inventory for debugging
router.get('/debug-profile/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, first_name, last_name, li_profile_url, profile_data FROM contacts WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Contact not found' });
    const row = rows[0];
    const raw = row.profile_data
      ? (typeof row.profile_data === 'string' ? JSON.parse(row.profile_data) : row.profile_data)
      : null;

    function inventory(obj, prefix) {
      prefix = prefix || '';
      const result = {};
      if (!obj || typeof obj !== 'object') return result;
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        const fullKey = prefix ? prefix + '.' + k : k;
        if (Array.isArray(v)) {
          result[fullKey] = 'Array(' + v.length + ')';
          if (v.length > 0 && v[0] && typeof v[0] === 'object') Object.assign(result, inventory(v[0], fullKey + '[0]'));
          else if (v.length > 0) result[fullKey + '[0]'] = v[0];
        } else if (v && typeof v === 'object') {
          Object.assign(result, inventory(v, fullKey));
        } else {
          result[fullKey] = v;
        }
      }
      return result;
    }

    res.json({
      contact_id:      row.id,
      stored_name:     row.first_name + ' ' + row.last_name,
      li_profile_url:  row.li_profile_url,
      has_profile_data: !!raw,
      field_map:       raw ? inventory(raw) : null,
      experience_0:    raw ? (raw.experience && raw.experience[0]) || (raw.experiences && raw.experiences[0]) || (raw.positions && raw.positions[0]) || null : null,
      raw_profile:     raw,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/contacts/re-extract?workspace_id=X
router.post('/re-extract', async (req, res) => {
  try {
    const workspace_id = req.query.workspace_id || req.body.workspace_id;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });
    const result = await reExtractAll(workspace_id);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/contacts/:id
router.delete('/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM contacts WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/contacts (bulk)
router.delete('/', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
    await db.query('DELETE FROM contacts WHERE id = ANY($1)', [ids]);
    res.json({ success: true, deleted: ids.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

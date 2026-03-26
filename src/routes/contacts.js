const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', async (req, res) => {
  try {
    const { campaign_id, q } = req.query;
    let query = 'SELECT * FROM contacts';
    const conditions = [];
    const params = [];

    if (campaign_id) {
      params.push(campaign_id);
      conditions.push(`campaign_id = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      const idx = params.length;
      conditions.push(
        `(first_name ILIKE $${idx} OR last_name ILIKE $${idx} OR company ILIKE $${idx} OR title ILIKE $${idx})`
      );
    }

    if (conditions.length) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY created_at DESC';

    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM contacts WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

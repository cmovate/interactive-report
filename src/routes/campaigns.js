const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', async (req, res) => {
  try {
    const { workspace_id } = req.query;
    let query = 'SELECT * FROM campaigns';
    const params = [];
    if (workspace_id) {
      query += ' WHERE workspace_id = $1';
      params.push(workspace_id);
    }
    query += ' ORDER BY created_at DESC';
    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { workspace_id, name, company_url, titles } = req.body;
    if (!workspace_id || !name) {
      return res.status(400).json({ error: 'workspace_id and name are required' });
    }
    const { rows } = await db.query(
      'INSERT INTO campaigns (workspace_id, name, company_url, titles) VALUES ($1, $2, $3, $4) RETURNING *',
      [workspace_id, name, company_url || null, titles || []]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

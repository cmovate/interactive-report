const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/workspaces
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM workspaces ORDER BY created_at ASC');
    res.json({ items: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/workspaces
router.post('/', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    const { rows } = await db.query(
      'INSERT INTO workspaces (name) VALUES ($1) RETURNING *',
      [name.trim()]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/workspaces/:id
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM workspaces WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

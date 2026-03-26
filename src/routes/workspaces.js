const express = require('express');
const router = express.Router();
const db = require('../db');
const { getAccounts } = require('../unipile');

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

// GET /api/workspaces/:id/accounts
// Returns accounts that have been explicitly connected to this workspace
router.get('/:id/accounts', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM unipile_accounts WHERE workspace_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json({ items: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/workspaces/:id/accounts
// Connect a Unipile account to this workspace
router.post('/:id/accounts', async (req, res) => {
  try {
    const { account_id, display_name, provider, status } = req.body;
    if (!account_id) return res.status(400).json({ error: 'account_id is required' });

    // Check if already connected
    const existing = await db.query(
      'SELECT id FROM unipile_accounts WHERE workspace_id = $1 AND account_id = $2',
      [req.params.id, account_id]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Account already connected to this workspace' });
    }

    const { rows } = await db.query(
      `INSERT INTO unipile_accounts (workspace_id, account_id, display_name, provider, status)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.params.id, account_id, display_name || account_id, provider || 'linkedin', status || 'connected']
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/workspaces/:id/accounts/:accountId
// Disconnect an account from this workspace
router.delete('/:id/accounts/:accountId', async (req, res) => {
  try {
    await db.query(
      'DELETE FROM unipile_accounts WHERE workspace_id = $1 AND account_id = $2',
      [req.params.id, req.params.accountId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

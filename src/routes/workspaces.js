const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { createRelationWebhook, deleteWebhook } = require('../unipile');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';

// GET /api/workspaces
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM workspaces ORDER BY created_at ASC');
    res.json({ items: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/workspaces/:id
router.delete('/:id', async (req, res) => {
  try {
    const { rows: accounts } = await db.query(
      'SELECT account_id, webhook_id FROM unipile_accounts WHERE workspace_id = $1',
      [req.params.id]
    );
    for (const acc of accounts) {
      if (acc.webhook_id) {
        await deleteWebhook(acc.webhook_id);
      }
    }
    await db.query('DELETE FROM workspaces WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/workspaces/:id/accounts
router.get('/:id/accounts', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM unipile_accounts WHERE workspace_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json({ items: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/workspaces/:id/accounts
router.post('/:id/accounts', async (req, res) => {
  try {
    const { account_id, display_name, provider, status } = req.body;
    if (!account_id) return res.status(400).json({ error: 'account_id is required' });

    const existing = await db.query(
      'SELECT id FROM unipile_accounts WHERE workspace_id = $1 AND account_id = $2',
      [req.params.id, account_id]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Account already connected to this workspace' });
    }

    let webhookId = null;
    try {
      webhookId = await createRelationWebhook(account_id, SERVER_URL);
      console.log(`[Workspace] Created webhook ${webhookId} for account ${account_id}`);
    } catch (err) {
      console.warn(`[Workspace] Could not create webhook for ${account_id}: ${err.message}`);
    }

    const { rows } = await db.query(
      `INSERT INTO unipile_accounts (workspace_id, account_id, display_name, provider, status, webhook_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.params.id, account_id, display_name || account_id,
       provider || 'linkedin', status || 'connected', webhookId]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/workspaces/:id/accounts/:accountId/settings
// Saves daily action limits for an account to the DB.
// Body: { limits: { connection_requests, messages, profile_views, ... } }
router.patch('/:id/accounts/:accountId/settings', async (req, res) => {
  try {
    const { limits } = req.body;
    if (!limits || typeof limits !== 'object') {
      return res.status(400).json({ error: 'limits object required' });
    }
    // Merge into existing settings JSONB — only overwrite the limits key
    const { rows } = await db.query(
      `UPDATE unipile_accounts
       SET settings = settings || jsonb_build_object('limits', $1::jsonb)
       WHERE workspace_id = $2 AND account_id = $3
       RETURNING *`,
      [JSON.stringify(limits), req.params.id, req.params.accountId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Account not found' });
    console.log(`[Settings] Saved limits for account ${req.params.accountId}:`, limits);
    res.json({ success: true, settings: rows[0].settings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/workspaces/:id/accounts/:accountId
router.delete('/:id/accounts/:accountId', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT webhook_id FROM unipile_accounts WHERE workspace_id = $1 AND account_id = $2',
      [req.params.id, req.params.accountId]
    );
    if (rows.length > 0 && rows[0].webhook_id) {
      await deleteWebhook(rows[0].webhook_id);
    }
    await db.query(
      'DELETE FROM unipile_accounts WHERE workspace_id = $1 AND account_id = $2',
      [req.params.id, req.params.accountId]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

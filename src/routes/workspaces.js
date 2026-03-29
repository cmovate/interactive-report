const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { createRelationWebhook, deleteWebhook, getAccountInfo } = require('../unipile');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';

/**
 * Extract avatar URL from a Unipile account object.
 * Unipile returns different shapes across provider versions —
 * fall through the known field names in priority order.
 */
function extractAvatar(profile) {
  return (
    profile?.picture ||
    profile?.avatar ||
    profile?.avatar_url ||
    profile?.profile_picture_url ||
    profile?.photo_url ||
    profile?.sources?.find(s => s.type === 'picture')?.value ||
    null
  );
}

/**
 * Fetch Unipile account info and write avatar_url / full_name to DB.
 * Fire-and-forget safe — errors are only warned, never thrown.
 */
async function hydrateAccountProfile(accountId) {
  try {
    const profile = await getAccountInfo(accountId);
    const avatarUrl = extractAvatar(profile);
    const fullName  = profile?.name || null;
    if (avatarUrl || fullName) {
      await db.query(
        `UPDATE unipile_accounts SET avatar_url = $1, full_name = $2
         WHERE account_id = $3`,
        [avatarUrl, fullName, accountId]
      );
      console.log(`[Workspace] Profile hydrated for ${accountId}: name="${fullName}" avatar=${avatarUrl ? 'yes' : 'no'}`);
    }
  } catch (err) {
    console.warn(`[Workspace] Could not hydrate profile for ${accountId}: ${err.message}`);
  }
}

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
      if (acc.webhook_id) await deleteWebhook(acc.webhook_id);
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
    const saved = rows[0];

    // Fire-and-forget profile hydration (avatar + full_name)
    hydrateAccountProfile(account_id);

    res.status(201).json(saved);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/workspaces/:id/accounts/:accountId/refresh-profile
// Manually re-fetch the LinkedIn profile picture + name for an account.
// Call this from the settings page or on a weekly cron.
router.post('/:id/accounts/:accountId/refresh-profile', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT account_id FROM unipile_accounts WHERE workspace_id = $1 AND account_id = $2',
      [req.params.id, req.params.accountId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Account not found' });
    await hydrateAccountProfile(req.params.accountId);
    // Return the freshly updated row
    const { rows: updated } = await db.query(
      'SELECT * FROM unipile_accounts WHERE account_id = $1',
      [req.params.accountId]
    );
    res.json({ success: true, account: updated[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/workspaces/:id/accounts/:accountId/settings
router.patch('/:id/accounts/:accountId/settings', async (req, res) => {
  try {
    const { limits, company_page_url } = req.body;
    if (!limits || typeof limits !== 'object') {
      return res.status(400).json({ error: 'limits object required' });
    }
    const settingsPatch = { limits };
    if (typeof company_page_url === 'string') settingsPatch.company_page_url = company_page_url.trim();
    const { rows } = await db.query(
      `UPDATE unipile_accounts
       SET settings = settings || $1::jsonb
       WHERE workspace_id = $2 AND account_id = $3
       RETURNING *`,
      [JSON.stringify(settingsPatch), req.params.id, req.params.accountId]
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

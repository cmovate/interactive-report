const express = require('express');
const router = express.Router();
const { pool } = require('../db');

const INSTANTLY_BASE = 'https://api.instantly.ai/api/v2';

// Get Instantly API key for a workspace (only workspace_id=4 / Datatailr)
async function getKey(workspaceId) {
  const r = await pool.query('SELECT instantly_api_key FROM workspaces WHERE id=$1', [workspaceId]);
  return r.rows[0]?.instantly_api_key || null;
}

function proxyHeaders(key) {
  return { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' };
}

// GET /api/instantly/campaigns
router.get('/campaigns', async (req, res) => {
  try {
    const key = await getKey(req.query.workspace_id || 4);
    if (!key) return res.status(403).json({ error: 'No Instantly key for this workspace' });
    const r = await fetch(`${INSTANTLY_BASE}/campaigns?limit=50`, { headers: proxyHeaders(key) });
    const d = await r.json();
    res.json(d);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/instantly/campaigns/:id/analytics
router.get('/campaigns/:id/analytics', async (req, res) => {
  try {
    const key = await getKey(req.query.workspace_id || 4);
    if (!key) return res.status(403).json({ error: 'No Instantly key for this workspace' });
    const r = await fetch(`${INSTANTLY_BASE}/campaigns/analytics`, { headers: proxyHeaders(key) });
    const d = await r.json();
    // Return the specific campaign's analytics
    const items = Array.isArray(d) ? d : (d.items || d.data || []);
    const campaign = items.find(c => c.campaign_id === req.params.id);
    res.json(campaign || { error: 'Campaign not found', campaign_id: req.params.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/instantly/campaigns/:id/leads  — paginated list
router.post('/campaigns/:id/leads', async (req, res) => {
  try {
    const key = await getKey(req.query.workspace_id || 4);
    if (!key) return res.status(403).json({ error: 'No Instantly key for this workspace' });
    const body = { campaign_id: req.params.id, limit: req.body.limit || 100 };
    if (req.body.starting_after) body.starting_after = req.body.starting_after;
    const r = await fetch(`${INSTANTLY_BASE}/leads/list`, {
      method: 'POST',
      headers: proxyHeaders(key),
      body: JSON.stringify(body)
    });
    const d = await r.json();
    res.json(d);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/instantly/accounts
router.get('/accounts', async (req, res) => {
  try {
    const key = await getKey(req.query.workspace_id || 4);
    if (!key) return res.status(403).json({ error: 'No Instantly key for this workspace' });
    const r = await fetch(`${INSTANTLY_BASE}/accounts?limit=50`, { headers: proxyHeaders(key) });
    const d = await r.json();
    res.json(d);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

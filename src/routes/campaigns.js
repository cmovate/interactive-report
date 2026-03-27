const express  = require('express');
const router   = express.Router();
const db       = require('../db');
const { searchPeople }       = require('../unipile');
const { enqueue, getStatus } = require('../enrichment');
const { countSentThisMonth } = require('../companyFollowSender');

// GET /api/campaigns?workspace_id=
router.get('/', async (req, res) => {
  try {
    const { workspace_id } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });
    const { rows } = await db.query(
      `SELECT c.*,
        (SELECT COUNT(*) FROM contacts WHERE campaign_id = c.id)                                    AS contact_count,
        (SELECT COUNT(*) FROM contacts WHERE campaign_id = c.id AND invite_sent     = true)         AS invites_sent,
        (SELECT COUNT(*) FROM contacts WHERE campaign_id = c.id AND invite_approved  = true)        AS invites_approved,
        (SELECT COUNT(*) FROM contacts WHERE campaign_id = c.id AND msg_sent        = true)         AS messages_sent,
        (SELECT COUNT(*) FROM contacts WHERE campaign_id = c.id AND positive_reply  = true)         AS positive_replies,
        (SELECT COUNT(*) FROM contacts WHERE campaign_id = c.id AND company_follow_invited = true)  AS company_follows
       FROM campaigns c WHERE c.workspace_id = $1 ORDER BY c.created_at DESC`,
      [workspace_id]
    );
    res.json({ items: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/campaigns/enrichment-status
router.get('/enrichment-status', (_req, res) => res.json(getStatus()));

// GET /api/campaigns/company-follow-status?account_id=
// Returns monthly company-follow stats for an account
router.get('/company-follow-status', async (req, res) => {
  try {
    const { account_id } = req.query;
    if (!account_id) return res.status(400).json({ error: 'account_id required' });
    const sent = await countSentThisMonth(account_id);
    res.json({ sent_this_month: sent, monthly_limit: 250, remaining: Math.max(0, 250 - sent) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/campaigns
router.post('/', async (req, res) => {
  try {
    const { workspace_id, account_id, name, audience_type, contacts, settings } = req.body;
    if (!workspace_id || !name) return res.status(400).json({ error: 'workspace_id and name required' });
    const { rows } = await db.query(
      `INSERT INTO campaigns (workspace_id, account_id, name, audience_type, settings, status)
       VALUES ($1, $2, $3, $4, $5, 'active') RETURNING *`,
      [workspace_id, account_id, name, audience_type, JSON.stringify(settings || {})]
    );
    const campaign  = rows[0];
    const toEnrich  = [];
    if (Array.isArray(contacts) && contacts.length > 0) {
      for (const c of contacts) {
        const { rows: ins } = await db.query(
          `INSERT INTO contacts (campaign_id, workspace_id, first_name, last_name, company, title,
             li_profile_url, li_company_url, email, website)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, li_profile_url`,
          [campaign.id, workspace_id,
           c.first_name||'', c.last_name||'', c.company||'', c.title||'',
           c.li_profile_url||c.linkedin_url||'', c.li_company_url||'',
           c.email||'', c.website||'']
        );
        const saved = ins[0];
        if (saved?.li_profile_url?.includes('linkedin.com/in/')) {
          toEnrich.push({ id: saved.id, li_profile_url: saved.li_profile_url });
        }
      }
    }
    res.status(201).json({ ...campaign, enrichment_queued: toEnrich.length });
    for (const c of toEnrich) enqueue(c.id, account_id, c.li_profile_url);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/campaigns/:id/status
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active','paused'].includes(status)) return res.status(400).json({ error: 'status must be active or paused' });
    const { rows } = await db.query('UPDATE campaigns SET status=$1 WHERE id=$2 RETURNING *', [status, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/campaigns/:id
router.delete('/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM campaigns WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/campaigns/search-people
router.post('/search-people', async (req, res) => {
  try {
    const { account_id, company_urls, titles } = req.body;
    if (!account_id || !company_urls?.length) return res.status(400).json({ error: 'account_id and company_urls required' });
    const results = [];
    for (const url of company_urls) {
      const name = url.split('/company/')[1]?.replace(/\//g,'').replace(/-/g,' ') || url;
      try { results.push(...await searchPeople(account_id, name, titles || [])); }
      catch (err) { console.error(`Search failed for ${url}:`, err.message); }
      await new Promise(r => setTimeout(r, 5000 + Math.random() * 5000));
    }
    res.json({ items: results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

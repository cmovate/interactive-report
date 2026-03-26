const express = require('express');
const router = express.Router();
const db = require('../db');
const { searchPeople, getFullProfile } = require('../unipile');

// GET /api/campaigns?workspace_id=
router.get('/', async (req, res) => {
  try {
    const { workspace_id } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });

    const { rows: campaigns } = await db.query(
      `SELECT c.*,
        (SELECT COUNT(*) FROM contacts WHERE campaign_id = c.id) AS contact_count,
        (SELECT COUNT(*) FROM contacts WHERE campaign_id = c.id AND invite_sent = true) AS invites_sent,
        (SELECT COUNT(*) FROM contacts WHERE campaign_id = c.id AND invite_approved = true) AS invites_approved,
        (SELECT COUNT(*) FROM contacts WHERE campaign_id = c.id AND msg_sent = true) AS messages_sent,
        (SELECT COUNT(*) FROM contacts WHERE campaign_id = c.id AND positive_reply = true) AS positive_replies
       FROM campaigns c
       WHERE c.workspace_id = $1
       ORDER BY c.created_at DESC`,
      [workspace_id]
    );
    res.json({ items: campaigns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns
router.post('/', async (req, res) => {
  try {
    const { workspace_id, account_id, name, audience_type, contacts, settings } = req.body;
    if (!workspace_id || !name) return res.status(400).json({ error: 'workspace_id and name required' });

    const { rows } = await db.query(
      `INSERT INTO campaigns (workspace_id, account_id, name, audience_type, settings)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [workspace_id, account_id, name, audience_type, JSON.stringify(settings || {})]
    );
    const campaign = rows[0];

    // Save contacts if provided
    if (Array.isArray(contacts) && contacts.length > 0) {
      for (const c of contacts) {
        await db.query(
          `INSERT INTO contacts
            (campaign_id, workspace_id, first_name, last_name, company, title,
             li_profile_url, li_company_url, email, website)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            campaign.id, workspace_id,
            c.first_name || '', c.last_name || '',
            c.company || '', c.title || '',
            c.li_profile_url || c.linkedin_url || '',
            c.li_company_url || '',
            c.email || '', c.website || ''
          ]
        );
      }
    }

    res.status(201).json(campaign);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/campaigns/:id
router.delete('/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM campaigns WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/search-people
// Called from the wizard when searching by company URLs + titles
router.post('/search-people', async (req, res) => {
  try {
    const { account_id, company_urls, titles } = req.body;
    if (!account_id || !company_urls?.length) {
      return res.status(400).json({ error: 'account_id and company_urls required' });
    }

    const results = [];
    for (const url of company_urls) {
      // Extract company name from URL for search query
      const companyName = url.split('/company/')[1]?.replace(/\//g, '').replace(/-/g, ' ') || url;
      try {
        const people = await searchPeople(account_id, companyName, titles || []);
        results.push(...people);
      } catch (err) {
        console.error(`Search failed for ${url}:`, err.message);
      }
      // Rate limiting - wait 5-10 seconds between calls
      await new Promise(r => setTimeout(r, 5000 + Math.random() * 5000));
    }

    res.json({ items: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

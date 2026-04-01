const express = require('express');
const router = express.Router();
const db = require('../db');
const { request } = require('../unipile');

// POST /api/enrich-companies
// Enriches ONE company from a list at a time using Unipile company profile API.
// Frontend loops: offset=0,1,2... until finished:true
// Saves company_linkedin_id to list_companies table

router.post('/', async function(req, res) {
  try {
    var list_id = req.body.list_id;
    var workspace_id = req.body.workspace_id;
    var offset = parseInt(req.body.offset) || 0;
    if (!list_id || !workspace_id) return res.status(400).json({ error: 'list_id and workspace_id required' });

    var accRes = await db.query(
      'SELECT account_id FROM unipile_accounts WHERE workspace_id=$1 LIMIT 1',
      [workspace_id]
    );
    if (!accRes.rows.length) return res.json({ error: 'No LinkedIn account' });
    var accountId = accRes.rows[0].account_id;

    var totalRes = await db.query(
      'SELECT COUNT(*) AS n FROM list_companies WHERE list_id=$1',
      [list_id]
    );
    var total = parseInt(totalRes.rows[0].n);

    var coRes = await db.query(
      'SELECT id, company_name, li_company_url, company_linkedin_id FROM list_companies WHERE list_id=$1 ORDER BY id LIMIT 1 OFFSET $2',
      [list_id, offset]
    );
    if (!coRes.rows.length) return res.json({ finished: true, total: total, done: offset });

    var co = coRes.rows[0];

    // Already has ID — skip
    if (co.company_linkedin_id && co.company_linkedin_id.trim()) {
      return res.json({ done: offset + 1, total: total, company_id: co.id, company_name: co.company_name, linkedin_id: co.company_linkedin_id, skipped: true });
    }

    // Extract slug from URL
    var slug = (co.li_company_url || '').replace(/\/+$/, '').split('/').pop();
    if (!slug) return res.json({ done: offset + 1, total: total, company_id: co.id, skipped: true, reason: 'no_slug' });

    try {
      // Call Unipile company profile endpoint directly with slug
      var profileData = await request(
        '/api/v1/linkedin/company/' + encodeURIComponent(slug) + '?account_id=' + encodeURIComponent(accountId),
        { method: 'GET' }
      );

      if (profileData && profileData.id) {
        await db.query(
          'UPDATE list_companies SET company_linkedin_id=$1, company_name=$2 WHERE id=$3',
          [String(profileData.id), profileData.name || co.company_name, co.id]
        );
        return res.json({ done: offset + 1, total: total, company_id: co.id, company_name: profileData.name || co.company_name, linkedin_id: String(profileData.id) });
      }
    } catch (apiErr) {}

    return res.json({ done: offset + 1, total: total, company_id: co.id, company_name: co.company_name, error: 'not_found' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

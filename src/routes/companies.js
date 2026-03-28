/**
 * /api/companies — Campaign Companies routes
 *
 * Companies are automatically populated from enriched contacts' profile_data.
 * Each row = one unique employer company per campaign.
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');

// GET /api/companies?workspace_id=&campaign_id=
// Returns all companies for a workspace (optionally filtered by campaign)
router.get('/', async (req, res) => {
  try {
    const { workspace_id, campaign_id } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });

    const params = [workspace_id];
    let where = 'WHERE cc.workspace_id = $1';
    if (campaign_id) {
      params.push(campaign_id);
      where += ` AND cc.campaign_id = $${params.length}`;
    }

    const { rows } = await db.query(
      `SELECT cc.*,
              c.name AS campaign_name,
              c.account_id
       FROM campaign_companies cc
       LEFT JOIN campaigns c ON c.id = cc.campaign_id
       ${where}
       ORDER BY cc.company_name ASC`,
      params
    );

    res.json({ items: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/companies/backfill?workspace_id=X
// Re-populates campaign_companies from all enriched contacts in the workspace.
// Safe to run multiple times (upsert with ON CONFLICT).
router.post('/backfill', async (req, res) => {
  try {
    const workspace_id = req.query.workspace_id || req.body?.workspace_id;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });

    // Find all enriched contacts with a company_linkedin_id extractable from profile_data
    const { rows: contacts } = await db.query(
      `SELECT id, campaign_id, workspace_id, company,
              li_company_url,
              profile_data->>'provider_id' AS provider_id,
              profile_data->'work_experience'->0->>'company_id' AS company_linkedin_id,
              profile_data->'work_experience'->0->>'company'    AS company_from_exp
       FROM contacts
       WHERE workspace_id = $1
         AND profile_data IS NOT NULL
         AND profile_data::text != '{}'
         AND profile_data::text != 'null'
         AND profile_data->'work_experience'->0->>'company_id' IS NOT NULL`,
      [workspace_id]
    );

    console.log(`[Companies backfill] Found ${contacts.length} contacts with company_linkedin_id`);

    let upserted = 0;
    const seen = new Set();

    for (const c of contacts) {
      const cid  = c.company_linkedin_id;
      const key  = `${c.campaign_id}:${cid}`;
      if (!cid || !c.campaign_id) continue;

      const companyName = c.company_from_exp || c.company || '';
      const companyUrl  = c.li_company_url || `https://www.linkedin.com/company/${cid}`;

      if (seen.has(key)) {
        // Just increment count for this campaign+company
        await db.query(
          `UPDATE campaign_companies
           SET contact_count = contact_count + 1
           WHERE campaign_id = $1 AND company_linkedin_id = $2`,
          [c.campaign_id, cid]
        );
      } else {
        seen.add(key);
        await db.query(
          `INSERT INTO campaign_companies
             (campaign_id, workspace_id, company_name, li_company_url, company_linkedin_id, contact_count)
           VALUES ($1, $2, $3, $4, $5, 1)
           ON CONFLICT (campaign_id, company_linkedin_id)
           DO UPDATE SET
             company_name   = EXCLUDED.company_name,
             li_company_url = EXCLUDED.li_company_url`,
          [c.campaign_id, c.workspace_id, companyName, companyUrl, cid]
        );
        upserted++;
      }
    }

    res.json({
      contacts_scanned:   contacts.length,
      companies_upserted: upserted,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

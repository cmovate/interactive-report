/**
 * src/routes/opportunities.js
 *
 * Opportunities tab — shows 1st-degree LinkedIn connections at target companies.
 * Data comes exclusively from opportunity_contacts table (populated by syncOpportunities job).
 * Source companies come from list_companies (Lists tab).
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db');

// GET /api/opportunities?workspace_id=X&list_id=X&campaign_id=X
// Returns companies grouped with their verified 1st-degree connections
router.get('/', async (req, res) => {
  try {
    const { workspace_id, list_id } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });

    // Get all companies for this workspace (optionally filtered by list)
    let companyQuery = `
      SELECT DISTINCT ON (lc.company_linkedin_id)
        lc.id, lc.company_name, lc.company_linkedin_id, lc.li_company_url, lc.list_id,
        l.name AS list_name
      FROM list_companies lc
      JOIN lists l ON l.id = lc.list_id AND l.workspace_id = lc.workspace_id
      WHERE lc.workspace_id = $1
        AND l.type = 'companies'
        AND lc.company_linkedin_id IS NOT NULL
        AND lc.company_linkedin_id != ''
    `;
    const params = [workspace_id];
    if (list_id) {
      params.push(list_id);
      companyQuery += ` AND lc.list_id = $${params.length}`;
    }
    companyQuery += ` ORDER BY lc.company_linkedin_id, lc.id ASC`;

    const { rows: companies } = await db.query(companyQuery, params);

    // Get all opportunity contacts for this workspace
    const { rows: contacts } = await db.query(`
      SELECT
        oc.company_linkedin_id,
        oc.first_name, oc.last_name, oc.title,
        oc.li_profile_url, oc.provider_id,
        oc.connected_via_account_id,
        oc.connected_via_name,
        oc.last_seen_at
      FROM opportunity_contacts oc
      WHERE oc.workspace_id = $1
      ORDER BY oc.company_linkedin_id, oc.connected_via_name
    `, [workspace_id]);

    // Get all lists for filter dropdown
    const { rows: lists } = await db.query(`
      SELECT l.id, l.name, COUNT(lc.id)::int AS company_count
      FROM lists l
      LEFT JOIN list_companies lc ON lc.list_id = l.id AND lc.workspace_id = l.workspace_id
      WHERE l.workspace_id = $1 AND l.type = 'companies'
      GROUP BY l.id, l.name ORDER BY l.name
    `, [workspace_id]);

    // Get accounts for this workspace
    const { rows: accounts } = await db.query(
      `SELECT account_id, display_name FROM unipile_accounts WHERE workspace_id=$1 ORDER BY id`,
      [workspace_id]
    );

    // Group contacts by company
    const contactsByCompany = {};
    for (const c of contacts) {
      const key = c.company_linkedin_id;
      if (!contactsByCompany[key]) contactsByCompany[key] = [];
      contactsByCompany[key].push(c);
    }

    // Build result — only companies that have at least 1 connection
    const result = companies
      .map(co => ({
        ...co,
        connections: contactsByCompany[co.company_linkedin_id] || []
      }))
      .filter(co => co.connections.length > 0)
      .sort((a, b) => b.connections.length - a.connections.length);

    res.json({ companies: result, lists, accounts, total_companies: result.length });
  } catch(e) {
    console.error('[Opportunities] GET error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/opportunities/stats?workspace_id=X
router.get('/stats', async (req, res) => {
  try {
    const { workspace_id } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });
    const { rows } = await db.query(`
      SELECT
        COUNT(DISTINCT company_linkedin_id) AS companies_with_connections,
        COUNT(*)                            AS total_connections,
        COUNT(DISTINCT connected_via_account_id) AS accounts_with_connections,
        MAX(last_seen_at)                   AS last_synced_at
      FROM opportunity_contacts WHERE workspace_id=$1
    `, [workspace_id]);
    res.json(rows[0] || {});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

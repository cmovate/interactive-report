/**
 * /api/opportunities
 *
 * Warm leads intelligence ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ companies from campaigns + manually-added companies (views/labels).
 *
 * Routes:
 *   GET  /                       ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ all companies (merged) + views + campaigns metadata
 *   GET  /views                  ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ list views with company counts
 *   POST /views                  ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ create a view (label)
 *   DELETE /views/:id            ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ delete a view (workspace_id required)
 *   POST /companies              ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ add custom companies to a view
 *   DELETE /companies/:id        ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ remove a custom company (workspace_id required)
 *   POST /attach-to-campaign     ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ search LinkedIn & add contacts to an automation campaign
 *   POST /send-message           ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ send a direct LinkedIn message to a contact
 */

const express  = require('express');
const router   = express.Router();
const db       = require('../db');
const { sendMessage, startDirectMessage, searchPeopleByCompany, lookupCompany, searchFirstDegreeAtCompany, enrichProfile } = require('../unipile');
const { enqueue } = require('../enrichment');

function extractCompanySlug(url) {
  const match = String(url || '').match(/linkedin\.com\/company\/([^/?#\s]+)/);
  return match ? match[1].replace(/\/$/, '').trim() : null;
}

function validateCompanyResults(people, companyId, companyName) {
  if (!people.length) return [];
  if (!companyId) return people;
  const nameParts = String(companyName || '')
    .toLowerCase().split(/[\s\-_,&.]+/).filter(p => p.length > 2);
  const kept = [], dropped = [];
  for (const p of people) {
    const resultId = p.current_company_id || p.company_id ||
                     p.positions?.[0]?.company_id || p.position?.company_id || null;
    if (resultId && String(resultId) === String(companyId)) { kept.push(p); continue; }
    const headline = (p.headline || p.occupation || p.title || '').toLowerCase();
    if (nameParts.length > 0 &&
        nameParts.filter(pt => headline.includes(pt)).length >= Math.ceil(nameParts.length * 0.6)) {
      kept.push(p); continue;
    }
    dropped.push(`${p.first_name || ''} ${p.last_name || ''}`.trim());
  }
  if (dropped.length)
    console.log(`[Opportunities] Dropped ${dropped.length} unvalidated result(s) for "${companyName}"`);
  return kept;
}

async function findContactsAtCompany(workspace_id, company_name, company_linkedin_id) {
  const params = [workspace_id];
  let filter;
  if (company_linkedin_id) {
    params.push(company_linkedin_id, company_name);
    filter = `AND (
      (c.profile_data->'work_experience'->0->>'company_id') = $2
      OR LOWER(TRIM(c.company)) = LOWER(TRIM($3))
    )`;
  } else {
    params.push(company_name);
    filter = `AND LOWER(TRIM(c.company)) = LOWER(TRIM($2))`;
  }
  const { rows } = await db.query(`
    SELECT DISTINCT ON (COALESCE(NULLIF(c.li_profile_url, ''), c.id::text))
      c.id, c.first_name, c.last_name, c.company, c.title,
      c.li_profile_url, c.email, c.chat_id, c.provider_id,
      c.campaign_id, c.msg_replied, c.invite_approved,
      COALESCE(camp.name,'')   AS campaign_name,
      COALESCE(camp.status,'') AS campaign_status,
      camp.account_id
    FROM contacts c
    LEFT JOIN campaigns camp ON camp.id = c.campaign_id
    WHERE c.workspace_id = $1
      -- removed: -- contacts from campaigns AND opportunity scraper (already_connected can be true or false)
      AND c.campaign_id IS NULL
      ${filter}
    ORDER BY
      COALESCE(NULLIF(c.li_profile_url, ''), c.id::text),
      CASE WHEN camp.status = 'active' THEN 0 ELSE 1 END,
      c.created_at DESC
  `, params);
  return rows;
}

// GET /api/opportunities?workspace_id=X
router.get('/', async (req, res) => {
  try {
    const { workspace_id } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });

    const { rows: accounts } = await db.query(
      `SELECT account_id, display_name FROM unipile_accounts WHERE workspace_id = $1 ORDER BY id`,
      [workspace_id]
    );
    const { rows: rawCampaigns } = await db.query(
      `SELECT id, name, status, audience_type, settings
       FROM campaigns WHERE workspace_id = $1 ORDER BY name`,
      [workspace_id]
    );
    const campaigns = rawCampaigns.map(c => ({
      id:            c.id,
      name:          c.name,
      status:        c.status,
      audience_type: c.audience_type,
      settings:      typeof c.settings === 'string' ? JSON.parse(c.settings) : (c.settings || {}),
    }));
    const { rows: views } = await db.query(`
      SELECT ov.id, ov.name,
             COUNT(oc.id)::int AS company_count
      FROM opportunity_views ov
      LEFT JOIN opportunity_companies oc
             ON oc.view_id = ov.id AND oc.workspace_id = ov.workspace_id
      WHERE ov.workspace_id = $1
      GROUP BY ov.id, ov.name, ov.added_at
      ORDER BY ov.added_at DESC
    `, [workspace_id]);
    const { rows: campRows } = await db.query(`
      SELECT cc.company_name, cc.company_linkedin_id, cc.li_company_url, cc.campaign_id
      FROM campaign_companies cc
      WHERE cc.workspace_id = $1
        AND cc.company_name IS NOT NULL AND cc.company_name != ''
      ORDER BY cc.company_name
    `, [workspace_id]);
    const { rows: customRows } = await db.query(`
      SELECT oc.id, oc.company_name, oc.company_linkedin_id, oc.li_company_url,
             oc.view_id, ov.name AS view_name
      FROM opportunity_companies oc
      LEFT JOIN opportunity_views ov ON ov.id = oc.view_id
      WHERE oc.workspace_id = $1
      ORDER BY oc.added_at DESC
    `, [workspace_id]);

    const companyMap = new Map();
    const nameToKey  = new Map();
    for (const cc of campRows) {
      const key     = cc.company_linkedin_id || cc.company_name.toLowerCase().trim();
      const nameKey = cc.company_name.toLowerCase().trim();
      if (!companyMap.has(key)) {
        companyMap.set(key, {
          company_name:        cc.company_name,
          company_linkedin_id: cc.company_linkedin_id || null,
          li_company_url:      cc.li_company_url || null,
          source:              'campaign',
          campaign_ids:        [],
          custom_id:           null,
          view_id:             null,
          view_name:           null,
        });
        if (!nameToKey.has(nameKey)) nameToKey.set(nameKey, key);
      }
      const existing = companyMap.get(key);
      if (cc.campaign_id && !existing.campaign_ids.includes(cc.campaign_id))
        existing.campaign_ids.push(cc.campaign_id);
    }
    for (const oc of customRows) {
      const idKey   = oc.company_linkedin_id || null;
      const nameKey = oc.company_name.toLowerCase().trim();
      const existingKey =
        (idKey && companyMap.has(idKey))  ? idKey :
        (nameToKey.has(nameKey))           ? nameToKey.get(nameKey) :
        null;
      if (existingKey) {
        const existing = companyMap.get(existingKey);
        existing.source    = 'both';
        existing.custom_id = oc.id;
        existing.view_id   = oc.view_id;
        existing.view_name = oc.view_name;
        if (!existing.li_company_url && oc.li_company_url)
          existing.li_company_url = oc.li_company_url;
      } else {
        const newKey = idKey || nameKey;
        companyMap.set(newKey, {
          company_name:        oc.company_name,
          company_linkedin_id: idKey,
          li_company_url:      oc.li_company_url || null,
          source:              'custom',
          campaign_ids:        [],
          custom_id:           oc.id,
          view_id:             oc.view_id,
          view_name:           oc.view_name,
        });
        nameToKey.set(nameKey, newKey);
      }
    }
    const result = [];
    for (const co of companyMap.values()) {
      const contacts  = await findContactsAtCompany(workspace_id, co.company_name, co.company_linkedin_id);
      const byAccount = {};
      for (const acc of accounts) byAccount[acc.account_id] = 0;
      for (const c of contacts) {
        if (c.account_id && byAccount[c.account_id] !== undefined) byAccount[c.account_id]++;
      }
      result.push({ ...co, connections_by_account: byAccount, total: contacts.length, contacts });
    }
    result.sort((a, b) => b.total - a.total || a.company_name.localeCompare(b.company_name));
    res.json({ accounts, views, campaigns, companies: result });
  } catch (err) {
    console.error('[Opportunities] GET / error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/opportunities/views?workspace_id=X
router.get('/views', async (req, res) => {
  try {
    const { workspace_id } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });
    const { rows } = await db.query(`
      SELECT ov.id, ov.name, COUNT(oc.id)::int AS company_count
      FROM opportunity_views ov
      LEFT JOIN opportunity_companies oc ON oc.view_id = ov.id
      WHERE ov.workspace_id = $1
      GROUP BY ov.id, ov.name, ov.added_at
      ORDER BY ov.added_at DESC
    `, [workspace_id]);
    res.json({ items: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/opportunities/views
router.post('/views', async (req, res) => {
  try {
    const { workspace_id, name } = req.body;
    if (!workspace_id || !name?.trim())
      return res.status(400).json({ error: 'workspace_id and name required' });
    const { rows } = await db.query(
      `INSERT INTO opportunity_views (workspace_id, name) VALUES ($1, $2) RETURNING *`,
      [workspace_id, name.trim()]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/opportunities/views/:id  ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ workspace_id required
router.delete('/views/:id', async (req, res) => {
  try {
    const wsId = req.query.workspace_id;
    if (!wsId) return res.status(400).json({ error: 'workspace_id required' });
    // Verify view belongs to this workspace
    const { rows: viewRows } = await db.query(
      'SELECT id FROM opportunity_views WHERE id=$1 AND workspace_id=$2',
      [req.params.id, wsId]
    );
    if (!viewRows.length) return res.status(404).json({ error: 'View not found or access denied' });
    await db.query('UPDATE opportunity_companies SET view_id=NULL WHERE view_id=$1 AND workspace_id=$2', [req.params.id, wsId]);
    await db.query('DELETE FROM opportunity_views WHERE id=$1 AND workspace_id=$2', [req.params.id, wsId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/opportunities/companies
router.post('/companies', async (req, res) => {
  try {
    const { workspace_id, companies, view_id, view_name } = req.body;
    if (!workspace_id || !Array.isArray(companies) || !companies.length)
      return res.status(400).json({ error: 'workspace_id and companies[] required' });

    let resolvedViewId   = view_id   || null;
    let resolvedViewName = null;

    if (!resolvedViewId && view_name?.trim()) {
      const { rows } = await db.query(
        `INSERT INTO opportunity_views (workspace_id, name) VALUES ($1, $2) RETURNING id, name`,
        [workspace_id, view_name.trim()]
      );
      resolvedViewId   = rows[0].id;
      resolvedViewName = rows[0].name;
    } else if (resolvedViewId) {
      // Verify view belongs to this workspace
      const { rows } = await db.query(
        'SELECT name FROM opportunity_views WHERE id=$1 AND workspace_id=$2', [resolvedViewId, workspace_id]
      );
      if (!rows.length) return res.status(404).json({ error: 'View not found or access denied' });
      resolvedViewName = rows[0]?.name || null;
    }

    let added = 0, skipped = 0;
    for (const co of companies) {
      const name = (co.name || '').trim();
      if (!name) continue;
      const { rows: existing } = await db.query(
        `SELECT id FROM opportunity_companies
         WHERE workspace_id=$1 AND LOWER(company_name)=LOWER($2) LIMIT 1`,
        [workspace_id, name]
      );
      if (existing.length) { skipped++; continue; }
      await db.query(
        `INSERT INTO opportunity_companies
           (workspace_id, company_name, li_company_url, company_linkedin_id, view_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [workspace_id, name, co.url || null, co.linkedin_id || null, resolvedViewId]
      );
      added++;
    }
    res.json({ added, skipped, view_id: resolvedViewId, view_name: resolvedViewName });
  } catch (err) {
    console.error('[Opportunities] POST /companies error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/opportunities/companies/:id  ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ workspace_id required
router.delete('/companies/:id', async (req, res) => {
  try {
    const wsId = req.query.workspace_id;
    if (!wsId) return res.status(400).json({ error: 'workspace_id required' });
    const { rowCount } = await db.query(
      'DELETE FROM opportunity_companies WHERE id=$1 AND workspace_id=$2',
      [req.params.id, wsId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Not found or access denied' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/opportunities/attach-to-campaign
router.post('/attach-to-campaign', async (req, res) => {
  try {
    const { workspace_id, campaign_id, companies, titles, limit } = req.body;
    if (!workspace_id || !campaign_id || !companies?.length || !titles?.length)
      return res.status(400).json({
        error: 'workspace_id, campaign_id, companies[], and titles[] required',
      });
    // Verify campaign belongs to this workspace
    const { rows: campRows } = await db.query(
      'SELECT id, account_id, workspace_id FROM campaigns WHERE id=$1 AND workspace_id=$2',
      [campaign_id, workspace_id]
    );
    if (!campRows.length) return res.status(404).json({ error: 'Campaign not found or access denied' });
    const campaign = campRows[0];
    const effectiveLimit = Math.min(parseInt(limit) || 10, 50);
    let companiesSearched = 0, contactsFound = 0, contactsAdded = 0;
    const toEnrich = [];
    for (let idx = 0; idx < companies.length; idx++) {
      const co = companies[idx];
      if (!co.url) continue;
      const slug = extractCompanySlug(co.url);
      if (!slug) continue;
      try {
        const company     = await lookupCompany(campaign.account_id, slug);
        const companyId   = company?.id   || null;
        const companyName = company?.name || co.name || slug.replace(/-/g, ' ');
        const rawPeople = await searchPeopleByCompany(
          campaign.account_id, companyId, companyName, titles, effectiveLimit
        );
        const people = validateCompanyResults(rawPeople, companyId, companyName);
        companiesSearched++;
        contactsFound += people.length;
        console.log(`[Opportunities] attach: "${companyName}" found=${rawPeople.length} kept=${people.length}`);
        if (companyId) {
          await db.query(`
            INSERT INTO campaign_companies
              (campaign_id, workspace_id, company_name, li_company_url, company_linkedin_id)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (campaign_id, company_linkedin_id)
            DO UPDATE SET company_name=EXCLUDED.company_name, li_company_url=EXCLUDED.li_company_url
          `, [campaign_id, workspace_id, companyName, co.url, String(companyId)]);
        }
        for (const p of people) {
          const liUrl = p.public_profile_url || p.li_profile_url || '';
          if (!liUrl.includes('linkedin.com/in/')) continue;
          const { rows: dup } = await db.query(
            'SELECT id FROM contacts WHERE campaign_id=$1 AND workspace_id=$2 AND li_profile_url=$3 LIMIT 1',
            [campaign_id, workspace_id, liUrl]
          );
          if (dup.length) continue;
          const { rows: ins } = await db.query(`
            INSERT INTO contacts
              (campaign_id, workspace_id, first_name, last_name, company, title, li_profile_url, li_company_url)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id
          `, [campaign_id, workspace_id, p.first_name||'', p.last_name||'', companyName, p.headline||'', liUrl,
             companyId ? 'https://www.linkedin.com/company/' + companyId : (li_company_url||null)]);
          contactsAdded++;
          if (ins[0]?.id) toEnrich.push({ id: ins[0].id, li_profile_url: liUrl });
        }
      } catch (err) {
        console.error(`[Opportunities] attach error for ${co.url}: ${err.message}`);
      }
      if (idx < companies.length - 1)
        await new Promise(r => setTimeout(r, 4000 + Math.random() * 4000));
    }
    if (campaign.account_id) {
      for (const c of toEnrich) enqueue(c.id, campaign.account_id, c.li_profile_url);
    }
    res.json({
      companies_searched: companiesSearched,
      contacts_found:     contactsFound,
      contacts_added:     contactsAdded,
      contacts_existing:  contactsFound - contactsAdded,
      enrichment_queued:  toEnrich.length,
    });
  } catch (err) {
    console.error('[Opportunities] POST /attach-to-campaign error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/opportunities/send-message

// POST /enrich ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ search LinkedIn connections at opportunity companies (no campaign required)
router.post('/enrich', async (req, res) => {
  const { workspace_id, company_ids, titles, limit } = req.body;
  if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });

  try {
    // Get accounts for this workspace
    const acctRows = (await db.query(
      'SELECT account_id FROM unipile_accounts WHERE workspace_id = $1',
      [workspace_id]
    )).rows;
    if (!acctRows.length) return res.status(400).json({ error: "No LinkedIn accounts connected to this workspace" });
    const account_id = acctRows[0].account_id;

    // Get companies to enrich
    let companyRows;
    if (company_ids && company_ids.length) {
      companyRows = (await db.query(
        'SELECT id, company_name, company_linkedin_id, li_company_url FROM opportunity_companies WHERE workspace_id = $1 AND id = ANY($2)',
        [workspace_id, company_ids]
      )).rows;
    } else {
      companyRows = (await db.query(
        'SELECT id, company_name, company_linkedin_id, li_company_url FROM opportunity_companies WHERE workspace_id = $1',
        [workspace_id]
      )).rows;
    }

    const effectiveLimit = Math.min(parseInt(limit) || 25, 50);
    let enriched = 0, added = 0;
    const results = [];

    for (const comp of companyRows) {
      try {
        const slug = extractCompanySlug(comp.li_company_url || "");
        const companyId = comp.company_linkedin_id || slug;
        if (!companyId) { results.push({ company: comp.company_name, skipped: true, reason: "no linkedin id" }); continue; }

        const companyName = comp.company_name;
        const resolvedId = await lookupCompany(account_id, companyId, companyName);
        if (!resolvedId) { results.push({ company: companyName, skipped: true, reason: "lookup failed" }); continue; }

        const rawPeople = await searchPeopleByCompany(account_id, resolvedId, companyName, titles || [], effectiveLimit);
        const people = validateCompanyResults(rawPeople, companyName);
        enriched++;

        for (const p of people) {
          const liUrl = (p.linkedin_url || p.public_profile_url || "").split("?")[0].trim();
          if (!liUrl) continue;
          // Upsert contact ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ campaign_id = NULL, linked to opportunity_company
          const ins = (await db.query(
            'INSERT INTO contacts (campaign_id, workspace_id, first_name, last_name, company, title, li_profile_url, li_company_url, already_connected)' +
            ' SELECT NULL, $1, $2, $3, $4, $5, $6, $7, true' +
            ' WHERE NOT EXISTS (' +
            '   SELECT 1 FROM contacts WHERE workspace_id = $1 AND li_profile_url = $6' +
            ' ) RETURNING id',
            [workspace_id, p.first_name||"", p.last_name||"", companyName, p.headline||"", liUrl, comp.li_company_url||""]
          )).rows;
          if (ins.length) added++;
        }
        results.push({ company: companyName, found: people.length, added });
      } catch (compErr) {
        results.push({ company: comp.company_name, error: compErr.message });
      }
    }

    res.json({ ok: true, companies_processed: enriched, contacts_added: added, results });
  } catch (err) {
    console.error('[Opportunities] enrich error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/send-message', async (req, res) => {
  try {
    const { contact_id, text, workspace_id } = req.body;
    if (!contact_id || !text?.trim())
      return res.status(400).json({ error: 'contact_id and text are required' });
    if (!workspace_id)
      return res.status(400).json({ error: 'workspace_id required' });

    // Verify contact belongs to this workspace
    const { rows } = await db.query(
      `SELECT c.id, c.first_name, c.last_name, c.provider_id, c.chat_id,
              c.already_connected, camp.account_id
       FROM contacts c
       JOIN campaigns camp ON camp.id = c.campaign_id
       WHERE c.id=$1 AND c.workspace_id=$2`,
      [contact_id, workspace_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Contact not found or access denied' });
    const contact = rows[0];
    if (!contact.already_connected)
      return res.status(400).json({ error: 'Contact not yet connected on LinkedIn' });
    if (!contact.account_id)
      return res.status(400).json({ error: 'No Unipile account for this contact' });
    if (!contact.provider_id && !contact.chat_id)
      return res.status(400).json({ error: 'Contact not enriched ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ provider_id missing' });

    let chatId = contact.chat_id;
    if (chatId) {
      await sendMessage(contact.account_id, chatId, text.trim());
    } else {
      const result = await startDirectMessage(contact.account_id, contact.provider_id, text.trim());
      chatId = result?.id || result?.chat_id || null;
      if (chatId)
        await db.query('UPDATE contacts SET chat_id=$1 WHERE id=$2 AND workspace_id=$3', [chatId, contact_id, workspace_id]);
    }
    await db.query(
      `UPDATE contacts
       SET msg_sent=true, msg_sent_at=COALESCE(msg_sent_at,NOW()), msgs_sent_count=COALESCE(msgs_sent_count,0)+1
       WHERE id=$1 AND workspace_id=$2`,
      [contact_id, workspace_id]
    );
    res.json({ success: true, contact_id, chat_id: chatId });
  } catch (err) {
    console.error('[Opportunities] send-message error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// POST /api/opportunities/enrich-company-ids
// Background job: resolve LinkedIn company IDs for opportunity_companies that have a URL but no ID.
// Uses the first available Unipile account in the workspace.
router.post('/enrich-company-ids', async (req, res) => {
  try {
    const { workspace_id } = req.body;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });

    // Get first account for this workspace
    const { rows: accs } = await db.query(
      'SELECT account_id FROM unipile_accounts WHERE workspace_id = $1 LIMIT 1', [workspace_id]
    );
    if (!accs.length) return res.status(400).json({ error: 'No LinkedIn accounts in this workspace' });
    const accountId = accs[0].account_id;

    // Find companies with URL but no LinkedIn ID
    const { rows: companies } = await db.query(
      `SELECT id, company_name, li_company_url FROM opportunity_companies
       WHERE workspace_id = $1 AND (company_linkedin_id IS NULL OR company_linkedin_id = '')
       AND li_company_url IS NOT NULL AND li_company_url != ''
       ORDER BY id LIMIT 50`,
      [workspace_id]
    );

    if (!companies.length) return res.json({ status: 'nothing_to_do', message: 'All companies already have LinkedIn IDs' });

    res.json({ status: 'started', total: companies.length, message: `Resolving IDs for ${companies.length} companies...` });

    // Background enrichment
    (async () => {
      let updated = 0, failed = 0;
      for (const co of companies) {
        try {
          const slug = (co.li_company_url || '').match(/linkedin\.com\/company\/([^/?#]+)/)?.[1];
          if (!slug) { failed++; continue; }
          const result = await lookupCompany(accountId, slug);
          if (result?.id) {
            await db.query(
              'UPDATE opportunity_companies SET company_linkedin_id = $1 WHERE id = $2',
              [result.id, co.id]
            );
            updated++;
            console.log(`[Opp] Resolved ${co.company_name}: ${result.id}`);
          } else { failed++; }
          await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
        } catch (err) {
          console.warn(`[Opp] Failed to resolve ${co.company_name}: ${err.message}`);
          failed++;
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      console.log(`[Opp] enrich-company-ids complete: ${updated} resolved, ${failed} failed`);
    })().catch(e => console.error('[Opp] enrich-company-ids error:', e.message));
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// POST /api/opportunities/scan ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ trigger immediate scan for 1st-degree connections
router.post('/scan', async (req, res) => {
  try {
    const { workspace_id } = req.body;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });
    const oppScraper = require('../opportunityScraper');
    oppScraper.scanWorkspace(parseInt(workspace_id))
      .catch(e => console.error('[OppScraper] manual scan error:', e.message));
    res.json({ status: 'started', message: 'Scanning 1st-degree connections for all target companies...' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// POST /api/opportunities/scan ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ trigger immediate scan for 1st-degree connections
router.post('/scan', async (req, res) => {
  try {
    const { workspace_id } = req.body;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });
    const oppScraper = require('../opportunityScraper');
    oppScraper.scanWorkspace(parseInt(workspace_id))
      .catch(e => console.error('[OppScraper] manual scan error:', e.message));
    res.json({ status: 'started', message: 'Scanning 1st-degree connections for all target companies...' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// POST /api/opportunities/scan-company
router.post('/scan-company', async (req, res) => {
  try {
    const { workspace_id, company_name, li_company_url, company_linkedin_id } = req.body;
    if (!workspace_id || !company_name) return res.status(400).json({ error: 'workspace_id and company_name required' });
    const { rows: accounts } = await db.query('SELECT ua.account_id, ua.display_name FROM unipile_accounts ua WHERE ua.workspace_id=$1', [workspace_id]);
    if (!accounts.length) return res.json({ contacts: [], accounts_scanned: 0 });
    const slug = (li_company_url||'').match(/\/company\/([^\/\?#]+)/)?.[1] || company_name;
    let companyId = company_linkedin_id || null;
    if (!companyId) {
      try { const l = await lookupCompany(accounts[0].account_id, slug); companyId = l?.id || null; } catch(e) {}
    }
    const all = [];
    for (const acc of accounts) {
      try {
        // Use searchPeopleByCompany then filter DISTANCE_1 (searchFirstDegreeAtCompany
        // breaks when combined with currentCompany filter in Unipile Classic API)
        const allPeople = await searchPeopleByCompany(acc.account_id, companyId, company_name, [], 50);
        const people = allPeople.filter(p => !p.member_distance || p.member_distance === 'DISTANCE_1' || p.distance === 1 || p.distance === '1');
        for (const p of people) {
          const pid = p.public_identifier || p.identifier;
          if (!pid) continue;
          const url = 'https://www.linkedin.com/in/' + pid;
          const ex = all.find(c => c.li_profile_url === url);
          if (ex) { if (!ex.connected_via.find(v => v.account_id === acc.account_id)) ex.connected_via.push({account_id:acc.account_id, name:acc.display_name}); }
          else {
            let enriched = null;
            try { enriched = await enrichProfile(acc.account_id, url); } catch(_e) {}
            all.push({
              li_profile_url: url,
              public_identifier: pid,
              first_name: (enriched && enriched.first_name) || p.first_name || '',
              last_name: (enriched && enriched.last_name) || p.last_name || '',
              headline: (enriched && enriched.headline) || p.headline || '',
              company: (enriched && enriched.company) || '',
              profile_picture: (enriched && enriched.profile_picture) || p.profile_picture_url || null,
              provider_id: pid,
              connected_via: [{ account_id: acc.account_id, name: acc.display_name }]
            });
          }
        }
      } catch(e) {}
    }
    for (const c of all.slice(0,20)) {
      try {
        const { rows:ex } = await db.query('SELECT id FROM contacts WHERE workspace_id=$1 AND li_profile_url=$2 LIMIT 1',[workspace_id,c.li_profile_url]);
        if (!ex.length) {
          const { rows:ins } = await db.query('INSERT INTO contacts (workspace_id,first_name,last_name,title,company,li_profile_url,campaign_id) VALUES ($1,$2,$3,$4,$5,$6,NULL) ON CONFLICT DO NOTHING RETURNING id',[workspace_id,c.first_name,c.last_name,c.headline,company_name,c.li_profile_url]);
          if (ins[0]?.id) { const {enqueue}=require('../enrichment'); enqueue(ins[0].id,accounts[0].account_id,c.li_profile_url); }
        }
      } catch(e) {}
    }
    res.json({ company:company_name, company_linkedin_id:companyId, accounts_scanned:accounts.length, contacts:all });
  } catch(err) { res.status(500).json({error:err.message}); }
});

router.post('/send-dm', async (req, res) => {
  try {
    const { workspace_id, account_id, provider_id, li_profile_url, message } = req.body;
    if (!workspace_id || !account_id || !message) return res.status(400).json({ error: 'workspace_id, account_id, message required' });
    const target = provider_id || (li_profile_url || '').replace(/.*\/in\/([^\/\?#]+).*/,'$1');
    if (!target) return res.status(400).json({ error: 'provider_id or li_profile_url required' });
    const result = await startDirectMessage(account_id, target, message);
    res.json({ success: true, chat_id: (result && (result.id || result.chat_id)) || null });
  } catch(err) { res.status(500).json({ error: err.message }); }
});
// GET /cached-contacts - returns all opportunity contacts grouped by li_company_url
router.get('/cached-contacts', async (req, res) => {
  try {
    const { workspace_id } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });
    const { rows } = await db.query(
      `SELECT id, first_name, last_name, company, title, li_profile_url,
              li_company_url, provider_id, already_connected
       FROM contacts
       WHERE workspace_id = $1 AND campaign_id IS NULL
       AND li_company_url IS NOT NULL AND li_company_url != '' AND li_company_url LIKE '%/company/%'
       ORDER BY created_at DESC`,
      [workspace_id]
    );
    res.json({ contacts: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

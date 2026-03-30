/**
 * /api/opportunities
 *
 * Warm leads intelligence — companies from campaigns + manually-added companies (views/labels).
 *
 * Routes:
 *   GET  /                       – all companies (merged) + views + campaigns metadata
 *   GET  /views                  – list views with company counts
 *   POST /views                  – create a view (label)
 *   DELETE /views/:id            – delete a view (workspace_id required)
 *   POST /companies              – add custom companies to a view
 *   DELETE /companies/:id        – remove a custom company (workspace_id required)
 *   POST /attach-to-campaign     – search LinkedIn & add contacts to an automation campaign
 *   POST /send-message           – send a direct LinkedIn message to a contact
 */

const express  = require('express');
const router   = express.Router();
const db       = require('../db');
const { sendMessage, startDirectMessage, searchPeopleByCompany, lookupCompany } = require('../unipile');
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
      c.li_profile_url, c.li_company_url, c.email, c.chat_id, c.provider_id,
      c.campaign_id, c.msg_replied, c.invite_approved,
      c.invite_sent, c.already_connected, c.positive_reply,
      c.msgs_sent_count, c.engagement_level,
      camp.name   AS campaign_name,
      camp.status AS campaign_status,
      camp.account_id
    FROM contacts c
    JOIN campaigns camp ON camp.id = c.campaign_id
    WHERE c.workspace_id = $1
      AND (c.li_profile_url IS NOT NULL AND c.li_profile_url != '')
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

// DELETE /api/opportunities/views/:id  — workspace_id required
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

// DELETE /api/opportunities/companies/:id  — workspace_id required
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
              (campaign_id, workspace_id, first_name, last_name, company, title, li_profile_url)
            VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
          `, [campaign_id, workspace_id, p.first_name||'', p.last_name||'', companyName, p.headline||'', liUrl]);
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
      return res.status(400).json({ error: 'Contact not enriched — provider_id missing' });

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

module.exports = router;

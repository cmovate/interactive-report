const express  = require('express');
const router   = express.Router();
const db       = require('../db');
const { searchPeopleByCompany, lookupCompany } = require('../unipile');
const { enqueue, getStatus } = require('../enrichment');
const { countSentThisMonth } = require('../companyFollowSender');
const engagementScraper      = require('../engagementScraper');
const likeSender             = require('../likeSender');
const withdrawSender         = require('../withdrawSender');

const MAX_MSG_SLOTS = 20;

// ── Workspace isolation helper ────────────────────────────────────────────────
// Every route that touches a specific campaign MUST call this first.
// Returns the campaign row, or sends 403/404 and returns null.
async function requireCampaign(req, res, workspaceId) {
  if (!workspaceId) {
    res.status(400).json({ error: 'workspace_id required' });
    return null;
  }
  const campaignId = parseInt(req.params.id, 10);
  if (isNaN(campaignId)) {
    res.status(400).json({ error: 'Invalid campaign ID' });
    return null;
  }
  const { rows } = await db.query(
    'SELECT * FROM campaigns WHERE id = $1 AND workspace_id = $2',
    [campaignId, workspaceId]
  );
  if (!rows.length) {
    res.status(404).json({ error: 'Campaign not found or access denied' });
    return null;
  }
  return rows[0];
}

function extractCompanySlug(url) {
  const match = String(url).match(/linkedin\.com\/company\/([^/?#]+)/);
  return match ? match[1].replace(/\/$/, '').trim() : null;
}

function validateCompanyResults(people, companyId, companyName) {
  if (!people.length) return [];
  if (!companyId) { return people; }
  const nameParts = companyName.toLowerCase().split(/[\s\-_,&.]+/).filter(p => p.length > 2);
  const kept = [], dropped = [];
  for (const p of people) {
    const resultId = p.current_company_id || p.company_id || p.positions?.[0]?.company_id || p.position?.company_id || null;
    if (resultId && String(resultId) === String(companyId)) { kept.push(p); continue; }
    const headline = (p.headline || p.occupation || p.title || '').toLowerCase();
    if (nameParts.length > 0) {
      const matchCount = nameParts.filter(part => headline.includes(part)).length;
      if (matchCount >= Math.ceil(nameParts.length * 0.6)) { kept.push(p); continue; }
    }
    dropped.push(`${p.first_name || ''} ${p.last_name || ''} ("${p.headline || ''}")`).trimEnd();
  }
  if (dropped.length) console.log(`[Search] Dropped ${dropped.length} for "${companyName}":`, dropped);
  return kept;
}

// GET /api/campaigns?workspace_id=
router.get('/', async (req, res) => {
  try {
    const { workspace_id } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });
    const { rows } = await db.query(
      `SELECT c.*,
        (SELECT COUNT(*) FROM contacts WHERE campaign_id = c.id)                                         AS contact_count,
        (SELECT COUNT(*) FROM contacts WHERE campaign_id = c.id AND invite_sent = true)                  AS invites_sent,
        (SELECT COUNT(*) FROM contacts WHERE campaign_id = c.id AND invite_approved = true)              AS invites_approved,
        (SELECT COUNT(*) FROM contacts WHERE campaign_id = c.id AND msg_sent = true)                     AS messages_sent,
        (SELECT COUNT(*) FROM contacts WHERE campaign_id = c.id AND msg_replied = true)                  AS messages_replied,
        (SELECT COUNT(*) FROM contacts WHERE campaign_id = c.id AND positive_reply = true)               AS positive_replies,
        (SELECT COUNT(*) FROM contacts WHERE campaign_id = c.id AND company_follow_invited = true)       AS follow_invited,
        (SELECT COUNT(*) FROM contacts WHERE campaign_id = c.id AND company_follow_confirmed = true)     AS follow_confirmed,
        (SELECT COUNT(*) FROM contacts WHERE campaign_id = c.id AND last_profile_view_at IS NOT NULL)    AS profile_views,
        (SELECT COALESCE(SUM(post_likes_sent),0)    FROM contacts WHERE campaign_id = c.id)              AS total_post_likes,
        (SELECT COALESCE(SUM(comment_likes_sent),0) FROM contacts WHERE campaign_id = c.id)              AS total_comment_likes
       FROM campaigns c WHERE c.workspace_id = $1 ORDER BY c.created_at DESC`,
      [workspace_id]
    );
    res.json({ items: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/campaigns/enrichment-status
router.get('/enrichment-status', (_req, res) => res.json(getStatus()));

// GET /api/campaigns/company-follow-status?account_id=
router.get('/company-follow-status', async (req, res) => {
  try {
    const { account_id } = req.query;
    if (!account_id) return res.status(400).json({ error: 'account_id required' });
    const sent = await countSentThisMonth(account_id);
    res.json({ sent_this_month: sent, monthly_limit: 250, remaining: Math.max(0, 250 - sent) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/campaigns/:id/ab-analytics?workspace_id=
router.get('/:id/ab-analytics', async (req, res) => {
  try {
    const wsId = req.query.workspace_id;
    const camp = await requireCampaign(req, res, wsId);
    if (!camp) return;
    const campaignId = camp.id;
    const { rows: overallRows } = await db.query(`
      SELECT
        COUNT(*)                                           AS total_contacts,
        COUNT(*) FILTER (WHERE already_connected = true)  AS already_connected,
        COUNT(*) FILTER (WHERE invite_sent = true)        AS invites_sent,
        COUNT(*) FILTER (WHERE invite_approved = true)    AS invites_approved,
        COUNT(*) FILTER (WHERE msg_sent = true)           AS messages_sent,
        COUNT(*) FILTER (WHERE msg_replied = true)        AS messages_replied,
        COUNT(*) FILTER (WHERE positive_reply = true)     AS positive_replies,
        COALESCE(SUM(msgs_sent_count), 0)                 AS total_msgs_sent
      FROM contacts WHERE campaign_id = $1 AND workspace_id = $2
    `, [campaignId, wsId]);
    const rawSettings = camp.settings || {};
    const settings = typeof rawSettings === 'string' ? JSON.parse(rawSettings) : rawSettings;
    const messages = settings.messages || {};
    const steps = [];
    for (let i = 1; i <= MAX_MSG_SLOTS; i++) {
      const { rows } = await db.query(`
        SELECT COALESCE(msg_${i}_variant, 'A') AS variant, COUNT(*) AS sent,
          COUNT(*) FILTER (WHERE msg_replied = true) AS replied
        FROM contacts WHERE campaign_id = $1 AND workspace_id = $2 AND msg_${i}_text IS NOT NULL
        GROUP BY COALESCE(msg_${i}_variant, 'A') ORDER BY COALESCE(msg_${i}_variant, 'A')
      `, [campaignId, wsId]);
      if (rows.length > 0) {
        const allSeqs = [...(messages.new||[]),...(messages.existing_no_history||[]),...(messages.existing_with_history||[])];
        const stepCfg = allSeqs[i-1];
        steps.push({ step:i, delay:stepCfg?.delay, unit:stepCfg?.unit,
          variants: rows.map(r=>({ label:r.variant, sent:parseInt(r.sent), replied:parseInt(r.replied),
            rate: parseInt(r.sent)>0 ? Math.round(parseInt(r.replied)/parseInt(r.sent)*100) : 0 })) });
      }
    }
    res.json({ overall: overallRows[0], campaign_name: camp.name, steps });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/campaigns/:id/engagement-stats?workspace_id=
router.get('/:id/engagement-stats', async (req, res) => {
  try {
    const wsId = req.query.workspace_id;
    const camp = await requireCampaign(req, res, wsId);
    if (!camp) return;
    const { rows } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE engagement_level = 'un_engaged')     AS un_engaged,
         COUNT(*) FILTER (WHERE engagement_level = 'average_engaged') AS average_engaged,
         COUNT(*) FILTER (WHERE engagement_level = 'engaged')         AS engaged,
         COUNT(*) FILTER (WHERE engagement_level IN ('average_engaged','engaged')) AS with_content,
         COUNT(*) FILTER (WHERE engagement_level IS NULL AND provider_id IS NOT NULL) AS not_yet_scraped,
         COUNT(*) FILTER (WHERE provider_id IS NULL)                  AS not_enriched,
         COALESCE(SUM(post_likes_sent),0)                             AS total_post_likes,
         COALESCE(SUM(comment_likes_sent),0)                          AS total_comment_likes,
         COUNT(*) FILTER (WHERE post_likes_sent > 0 OR comment_likes_sent > 0) AS contacts_liked,
         COUNT(*)                                                      AS total
       FROM contacts WHERE campaign_id = $1 AND workspace_id = $2`,
      [camp.id, wsId]
    );
    res.json(rows[0]);
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
    const campaign = rows[0];
    const toEnrich = [];
    if (Array.isArray(contacts) && contacts.length > 0) {
      for (const c of contacts) {
        const { rows: ins } = await db.query(
          `INSERT INTO contacts (campaign_id, workspace_id, first_name, last_name, company, title,
             li_profile_url, li_company_url, email, website)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, li_profile_url`,
          [campaign.id, workspace_id, c.first_name||'', c.last_name||'', c.company||'', c.title||'',
           c.li_profile_url||c.linkedin_url||'', c.li_company_url||'', c.email||'', c.website||'']
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

// POST /api/campaigns/:id/scrape-engagement  (workspace_id in body or query)
router.post('/:id/scrape-engagement', async (req, res) => {
  try {
    const wsId = req.body?.workspace_id || req.query.workspace_id;
    const camp = await requireCampaign(req, res, wsId);
    if (!camp) return;
    if (req.body?.force) await db.query(
      'UPDATE contacts SET engagement_level=NULL,engagement_scraped_at=NULL,engagement_data=NULL WHERE campaign_id=$1 AND workspace_id=$2',
      [camp.id, wsId]
    );
    engagementScraper.run(camp.id).catch(e=>console.error('[API] Scrape error:',e.message));
    res.json({ status: 'started', campaign_id: camp.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/campaigns/:id/reclassify
router.post('/:id/reclassify', async (req, res) => {
  try {
    const wsId = req.body?.workspace_id || req.query.workspace_id;
    const camp = await requireCampaign(req, res, wsId);
    if (!camp) return;
    const result = await engagementScraper.reclassifyFromExistingData(camp.id);
    engagementScraper.run(camp.id).catch(e=>console.error('[API] Post-reclassify error:',e.message));
    res.json({ ...result, scrape_started: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/campaigns/:id/send-likes
router.post('/:id/send-likes', async (req, res) => {
  try {
    const wsId = req.body?.workspace_id || req.query.workspace_id;
    const camp = await requireCampaign(req, res, wsId);
    if (!camp) return;
    likeSender.run(camp.id, { force: !!req.body?.force }).catch(e=>console.error('[API] Likes error:',e.message));
    res.json({ status: 'started', campaign_id: camp.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/campaigns/:id/run-withdraw
router.post('/:id/run-withdraw', async (req, res) => {
  try {
    const wsId = req.body?.workspace_id || req.query.workspace_id;
    const camp = await requireCampaign(req, res, wsId);
    if (!camp) return;
    const result = await withdrawSender.run(camp.id);
    res.json({ campaign_id: camp.id, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/campaigns/:id/status
router.patch('/:id/status', async (req, res) => {
  try {
    const wsId = req.body?.workspace_id || req.query.workspace_id;
    const camp = await requireCampaign(req, res, wsId);
    if (!camp) return;
    const { status } = req.body;
    if (!['active','paused'].includes(status)) return res.status(400).json({ error: 'status must be active or paused' });
    const { rows } = await db.query(
      'UPDATE campaigns SET status=$1 WHERE id=$2 AND workspace_id=$3 RETURNING *',
      [status, camp.id, wsId]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/campaigns/:id/settings
router.patch('/:id/settings', async (req, res) => {
  try {
    const wsId = req.body?.workspace_id || req.query.workspace_id;
    const camp = await requireCampaign(req, res, wsId);
    if (!camp) return;
    const { settings } = req.body;
    if (!settings) return res.status(400).json({ error: 'settings required' });
    const { rows } = await db.query(
      'UPDATE campaigns SET settings=$1 WHERE id=$2 AND workspace_id=$3 RETURNING *',
      [JSON.stringify(settings), camp.id, wsId]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/campaigns/:id
router.delete('/:id', async (req, res) => {
  try {
    const wsId = req.query.workspace_id;
    const camp = await requireCampaign(req, res, wsId);
    if (!camp) return;
    await db.query('DELETE FROM campaigns WHERE id=$1 AND workspace_id=$2', [camp.id, wsId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/campaigns/search-people
router.post('/search-people', async (req, res) => {
  try {
    const { account_id, company_urls, titles } = req.body;
    const limit = Math.min(parseInt(req.body.limit, 10) || 10, 50);
    if (!account_id || !company_urls?.length) return res.status(400).json({ error: 'account_id and company_urls required' });
    const results = [], companiesMeta = [];
    for (const url of company_urls) {
      const slug = extractCompanySlug(url);
      if (!slug) { companiesMeta.push({ url, status: 'invalid_url', found: 0, kept: 0 }); continue; }
      try {
        const company     = await lookupCompany(account_id, slug);
        const companyId   = company?.id   || null;
        const companyName = company?.name || slug.replace(/-/g, ' ');
        const people    = await searchPeopleByCompany(account_id, companyId, companyName, titles || [], limit);
        const validated = validateCompanyResults(people, companyId, companyName);
        results.push(...validated);
        companiesMeta.push({ url, company_name: companyName, company_id: companyId, status: 'ok', found: people.length, kept: validated.length });
      } catch (err) {
        companiesMeta.push({ url, status: 'error', error: err.message, found: 0, kept: 0 });
      }
      await new Promise(r => setTimeout(r, 5000 + Math.random() * 5000));
    }
    res.json({ items: results, companies: companiesMeta });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Campaign detail / edit endpoints ─────────────────────────────────────────

// GET /api/campaigns/:id?workspace_id=
router.get('/:id', async (req, res) => {
  try {
    const wsId = req.query.workspace_id;
    const camp = await requireCampaign(req, res, wsId);
    if (!camp) return;
    // Augment with counts
    const { rows: cnt } = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM contacts           WHERE campaign_id=$1 AND workspace_id=$2) AS contact_count,
         (SELECT COUNT(*) FROM campaign_companies WHERE campaign_id=$1 AND workspace_id=$2) AS company_count`,
      [camp.id, wsId]
    );
    if (typeof camp.settings === 'string') camp.settings = JSON.parse(camp.settings);
    res.json({ ...camp, ...cnt[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/campaigns/:id/companies?workspace_id=
router.get('/:id/companies', async (req, res) => {
  try {
    const wsId = req.query.workspace_id;
    const camp = await requireCampaign(req, res, wsId);
    if (!camp) return;
    const { rows } = await db.query(
      `SELECT id, company_name, company_linkedin_id, li_company_url, contact_count, created_at
       FROM campaign_companies WHERE campaign_id=$1 AND workspace_id=$2 ORDER BY company_name`,
      [camp.id, wsId]);
    res.json({ items: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/campaigns/:id/contacts?workspace_id=&page=&limit=
router.get('/:id/contacts', async (req, res) => {
  try {
    const wsId = req.query.workspace_id;
    const camp = await requireCampaign(req, res, wsId);
    if (!camp) return;
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = (page - 1) * limit;
    const { rows: cnt } = await db.query(
      'SELECT COUNT(*) FROM contacts WHERE campaign_id=$1 AND workspace_id=$2',
      [camp.id, wsId]);
    const total = parseInt(cnt[0].count);
    const { rows } = await db.query(
      `SELECT id, first_name, last_name, company, title, li_profile_url,
              invite_sent, invite_approved, already_connected,
              msg_sent, msg_replied, positive_reply, created_at
       FROM contacts WHERE campaign_id=$1 AND workspace_id=$2
       ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
      [camp.id, wsId, limit, offset]);
    res.json({ items: rows, total, page, limit, pages: Math.ceil(total / limit) || 1 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/campaigns/:id/contacts
router.post('/:id/contacts', async (req, res) => {
  try {
    const wsId = req.body?.workspace_id || req.query.workspace_id;
    const camp = await requireCampaign(req, res, wsId);
    if (!camp) return;
    const { contacts } = req.body;
    if (!Array.isArray(contacts) || !contacts.length) return res.status(400).json({ error: 'contacts[] required' });
    let added = 0, skipped = 0;
    const toEnrich = [];
    for (const c of contacts) {
      const url = (c.li_profile_url || '').trim();
      if (!url.includes('linkedin.com/in/')) { skipped++; continue; }
      const { rows: dup } = await db.query(
        'SELECT id FROM contacts WHERE campaign_id=$1 AND workspace_id=$2 AND li_profile_url=$3 LIMIT 1',
        [camp.id, wsId, url]);
      if (dup.length) { skipped++; continue; }
      const { rows: ins } = await db.query(
        `INSERT INTO contacts (campaign_id, workspace_id, first_name, last_name, company, title, li_profile_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [camp.id, wsId, c.first_name||'', c.last_name||'', c.company||'', c.title||'', url]);
      added++;
      if (ins[0]?.id) toEnrich.push({ id: ins[0].id, li_profile_url: url });
    }
    for (const c of toEnrich) enqueue(c.id, camp.account_id, c.li_profile_url);
    res.json({ added, skipped, enrichment_queued: toEnrich.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/campaigns/:id/contacts/:contactId?workspace_id=
router.delete('/:id/contacts/:contactId', async (req, res) => {
  try {
    const wsId = req.query.workspace_id;
    const camp = await requireCampaign(req, res, wsId);
    if (!camp) return;
    const { rowCount } = await db.query(
      'DELETE FROM contacts WHERE id=$1 AND campaign_id=$2 AND workspace_id=$3',
      [req.params.contactId, camp.id, wsId]);
    if (!rowCount) return res.status(404).json({ error: 'Contact not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Background company fetch ──────────────────────────────────────────────────
async function runCompanyFetch(campaignId, workspaceId, accountId, companyUrls, titles, limit) {
  console.log(`[CompanyFetch] Campaign ${campaignId}: fetching ${companyUrls.length} companies`);
  let totalAdded = 0;
  for (const url of companyUrls) {
    try {
      const slug = extractCompanySlug(url);
      if (!slug) continue;
      const company     = await lookupCompany(accountId, slug);
      const companyId   = company?.id   || null;
      const companyName = company?.name || slug.replace(/-/g, ' ');
      const people    = await searchPeopleByCompany(accountId, companyId, companyName, titles || [], limit);
      const validated = validateCompanyResults(people, companyId, companyName);
      console.log(`[CompanyFetch] Campaign ${campaignId}: ${companyName} \u2192 ${validated.length} validated`);
      for (const p of validated) {
        const liUrl = p.public_profile_url || p.li_profile_url || '';
        if (!liUrl.includes('linkedin.com/in/')) continue;
        const { rows: dup } = await db.query(
          'SELECT id FROM contacts WHERE campaign_id=$1 AND workspace_id=$2 AND li_profile_url=$3 LIMIT 1',
          [campaignId, workspaceId, liUrl]);
        if (dup.length) continue;
        const { rows: ins } = await db.query(
          `INSERT INTO contacts (campaign_id, workspace_id, first_name, last_name, company, title, li_profile_url)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [campaignId, workspaceId, p.first_name||'', p.last_name||p.lastName||'',
           p.company||companyName, p.headline||p.title||'', liUrl]);
        if (ins[0]?.id) { totalAdded++; enqueue(ins[0].id, accountId, liUrl); }
      }
    } catch (e) {
      console.error(`[CompanyFetch] Campaign ${campaignId}: error for ${url}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 5000 + Math.random() * 5000));
  }
  console.log(`[CompanyFetch] Campaign ${campaignId}: complete \u2014 ${totalAdded} contacts added`);
}

// POST /api/campaigns/:id/fetch-all-companies
router.post('/:id/fetch-all-companies', async (req, res) => {
  try {
    const wsId = req.body?.workspace_id || req.query.workspace_id;
    const camp = await requireCampaign(req, res, wsId);
    if (!camp) return;
    const settings = typeof camp.settings === 'string' ? JSON.parse(camp.settings) : (camp.settings || {});
    const sc = settings.searchConfig || {};
    const { companyUrls = [], titles = [], maxPerCompany = 10, previewedCount = 0 } = sc;
    const urlsToFetch = companyUrls.slice(previewedCount);
    if (!urlsToFetch.length) return res.json({ status: 'nothing_to_fetch' });
    const estimatedMin = Math.max(2, Math.ceil(urlsToFetch.length * 0.8));
    runCompanyFetch(camp.id, camp.workspace_id, camp.account_id, urlsToFetch, titles, maxPerCompany)
      .catch(e => console.error(`[CompanyFetch] Campaign ${camp.id}:`, e.message));
    res.json({ status: 'started', companies_to_fetch: urlsToFetch.length, estimated_minutes: estimatedMin });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

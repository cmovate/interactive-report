const express  = require('express');
const router   = express.Router();
const db       = require('../db');
const { searchPeople }       = require('../unipile');
const { enqueue, getStatus } = require('../enrichment');
const { countSentThisMonth } = require('../companyFollowSender');
const engagementScraper      = require('../engagementScraper');
const likeSender             = require('../likeSender');
const withdrawSender         = require('../withdrawSender');

const MAX_MSG_SLOTS = 20; // must match messageSender.js

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

// GET /api/campaigns/:id/ab-analytics
router.get('/:id/ab-analytics', async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id, 10);
    if (isNaN(campaignId)) return res.status(400).json({ error: 'Invalid campaign ID' });

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
      FROM contacts WHERE campaign_id = $1
    `, [campaignId]);

    const { rows: campRows } = await db.query(
      'SELECT name, settings FROM campaigns WHERE id = $1', [campaignId]
    );
    const rawSettings = campRows[0]?.settings || {};
    const settings = typeof rawSettings === 'string' ? JSON.parse(rawSettings) : rawSettings;
    const messages = settings.messages || {};

    // Per-step A/B/C breakdown — columns 1-MAX_MSG_SLOTS are safe literals, not user input
    const steps = [];
    for (let i = 1; i <= MAX_MSG_SLOTS; i++) {
      const { rows } = await db.query(`
        SELECT
          COALESCE(msg_${i}_variant, 'A') AS variant,
          COUNT(*)                         AS sent,
          COUNT(*) FILTER (WHERE msg_replied = true) AS replied
        FROM contacts
        WHERE campaign_id = $1 AND msg_${i}_text IS NOT NULL
        GROUP BY COALESCE(msg_${i}_variant, 'A')
        ORDER BY COALESCE(msg_${i}_variant, 'A')
      `, [campaignId]);

      if (rows.length > 0) {
        const allSeqs = [
          ...(messages.new || []),
          ...(messages.existing_no_history || []),
          ...(messages.existing_with_history || []),
        ];
        const stepCfg = allSeqs[i - 1];
        steps.push({
          step: i,
          delay: stepCfg?.delay,
          unit: stepCfg?.unit,
          variants: rows.map(r => ({
            label: r.variant,
            sent: parseInt(r.sent),
            replied: parseInt(r.replied),
            rate: parseInt(r.sent) > 0
              ? Math.round(parseInt(r.replied) / parseInt(r.sent) * 100)
              : 0,
          })),
        });
      }
    }

    res.json({
      overall: overallRows[0],
      campaign_name: campRows[0]?.name || '',
      steps,
    });
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

// POST /api/campaigns/:id/scrape-engagement
router.post('/:id/scrape-engagement', async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id, 10);
    if (isNaN(campaignId)) return res.status(400).json({ error: 'Invalid campaign ID' });
    if (req.body?.force) {
      await db.query(
        'UPDATE contacts SET engagement_level = NULL, engagement_scraped_at = NULL, engagement_data = NULL WHERE campaign_id = $1',
        [campaignId]
      );
    }
    engagementScraper.run(campaignId)
      .then(r => console.log(`[API] Scrape done campaign ${campaignId}:`, JSON.stringify(r)))
      .catch(e => console.error(`[API] Scrape error:`, e.message));
    res.json({ status: 'started', campaign_id: campaignId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/campaigns/:id/reclassify
router.post('/:id/reclassify', async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id, 10);
    if (isNaN(campaignId)) return res.status(400).json({ error: 'Invalid campaign ID' });
    const result = await engagementScraper.reclassifyFromExistingData(campaignId);
    engagementScraper.run(campaignId)
      .then(r => console.log(`[API] Post-reclassify scrape done:`, JSON.stringify(r)))
      .catch(e => console.error(`[API] Post-reclassify scrape error:`, e.message));
    res.json({ ...result, scrape_started: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/campaigns/:id/send-likes
router.post('/:id/send-likes', async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id, 10);
    if (isNaN(campaignId)) return res.status(400).json({ error: 'Invalid campaign ID' });
    likeSender.run(campaignId, { force: !!req.body?.force })
      .then(r => console.log(`[API] Likes done campaign ${campaignId}:`, JSON.stringify(r)))
      .catch(e => console.error(`[API] Likes error:`, e.message));
    res.json({ status: 'started', campaign_id: campaignId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/campaigns/:id/run-withdraw
router.post('/:id/run-withdraw', async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id, 10);
    if (isNaN(campaignId)) return res.status(400).json({ error: 'Invalid campaign ID' });
    const result = await withdrawSender.run(campaignId);
    res.json({ campaign_id: campaignId, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/campaigns/:id/engagement-stats
router.get('/:id/engagement-stats', async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id, 10);
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
       FROM contacts WHERE campaign_id = $1`,
      [campaignId]
    );
    res.json(rows[0]);
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

// PATCH /api/campaigns/:id/settings
router.patch('/:id/settings', async (req, res) => {
  try {
    const { settings } = req.body;
    if (!settings) return res.status(400).json({ error: 'settings required' });
    const { rows } = await db.query(
      'UPDATE campaigns SET settings=$1 WHERE id=$2 RETURNING *',
      [JSON.stringify(settings), req.params.id]
    );
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

/**
 * Engagement Scraper
 *
 * Scrapes LinkedIn posts & comments for contacts in campaigns
 * that have like_posts or like_comments engagement actions enabled.
 *
 * Flow:
 *   1. Find active campaigns with like_posts or like_comments enabled
 *   2. For each campaign, get enriched contacts (those with provider_id)
 *   3. Shuffle randomly, process one by one
 *   4. For each contact: fetch posts + comments from last 14 days
 *   5. Classify into engagement level
 *   6. Save full raw data to DB as JSONB
 *   7. When 20 contacts are classified → trigger likeSender automatically
 *
 * Engagement levels:
 *   un_engaged       — 0 non-employer posts AND 0 non-employer comments in 14d
 *   average_engaged  — ≥1 non-employer post AND ≥1 non-employer comment in 14d
 *   engaged          — ≥2 non-employer posts AND ≥2 non-employer comments in 14d
 *
 * "Employer-related" = posted as company page, or parent post author matches company
 *
 * Scheduled: once daily at 06:00.
 */

const db      = require('./db');
const unipile = require('./unipile');

const DAYS_14           = 14 * 24 * 60 * 60 * 1000;
const TARGET_CLASSIFIED = 20;
const DELAY_BETWEEN_MS  = 3000 + Math.random() * 2000;

let isRunning = false;

function start() {
  console.log('[EngagementScraper] Started — runs daily at 06:00');
  scheduleDaily();
}

function scheduleDaily() {
  const now     = new Date();
  const next6am = new Date(now);
  next6am.setHours(6, 0, 0, 0);
  if (next6am <= now) next6am.setDate(next6am.getDate() + 1);
  const msUntil = next6am - now;
  console.log(`[EngagementScraper] Next run in ${Math.round(msUntil/3600000)}h`);
  setTimeout(() => { run(); setInterval(run, 24 * 60 * 60 * 1000); }, msUntil);
}

async function run(campaignId = null) {
  if (isRunning) {
    console.log('[EngagementScraper] Already running, skipping');
    return { skipped: true };
  }
  isRunning = true;
  console.log('[EngagementScraper] Starting run...');

  try {
    let query = `
      SELECT c.id, c.account_id, c.name, c.settings
      FROM campaigns c
      WHERE c.status = 'active'
        AND (
          (c.settings->'engagement'->>'like_posts')::boolean = true
          OR (c.settings->'engagement'->>'like_comments')::boolean = true
          OR (c.settings->'engagement'->>'company_like_posts')::boolean = true
          OR (c.settings->'engagement'->>'company_like_comments')::boolean = true
        )
    `;
    const queryParams = [];
    if (campaignId) {
      queryParams.push(campaignId);
      query += ` AND c.id = $${queryParams.length}`;
    }

    const { rows: campaigns } = await db.query(query, queryParams);
    if (!campaigns.length) {
      console.log('[EngagementScraper] No eligible campaigns');
      return { campaigns_processed: 0 };
    }

    const summary = [];
    for (const campaign of campaigns) {
      const result = await processCampaign(campaign);
      summary.push({ campaign_id: campaign.id, name: campaign.name, ...result });
    }

    console.log('[EngagementScraper] Done:', JSON.stringify(summary));
    return { campaigns_processed: campaigns.length, summary };
  } catch (err) {
    console.error('[EngagementScraper] Error in run():', err.message);
    return { error: err.message };
  } finally {
    isRunning = false;
  }
}

async function processCampaign(campaign) {
  console.log(`[EngagementScraper] Campaign ${campaign.id}: "${campaign.name}"`);

  const { rows: alreadyDone } = await db.query(
    `SELECT COUNT(*) AS cnt FROM contacts
     WHERE campaign_id = $1 AND engagement_level IS NOT NULL`,
    [campaign.id]
  );
  const alreadyClassified = parseInt(alreadyDone[0].cnt, 10);

  if (alreadyClassified >= TARGET_CLASSIFIED) {
    console.log(`[EngagementScraper] Campaign ${campaign.id}: already ${alreadyClassified} classified`);
    return { skipped: true, already_classified: alreadyClassified };
  }

  const remaining = TARGET_CLASSIFIED - alreadyClassified;

  const { rows: contacts } = await db.query(
    `SELECT id, first_name, last_name, company, provider_id
     FROM contacts
     WHERE campaign_id = $1
       AND provider_id IS NOT NULL
       AND provider_id != ''
       AND engagement_level IS NULL
     ORDER BY RANDOM()
     LIMIT 30`,
    [campaign.id]
  );

  if (!contacts.length) {
    console.log(`[EngagementScraper] Campaign ${campaign.id}: no unscraped enriched contacts`);
    return { contacts_scraped: 0 };
  }

  let scraped    = 0;
  let classified = 0;

  for (const contact of contacts) {
    if (classified >= remaining) break;
    try {
      const result = await scrapeContact(contact, campaign.account_id);
      if (result) { scraped++; classified++; }
    } catch (err) {
      console.error(`[EngagementScraper] ✗ contact ${contact.id}: ${err.message}`);
    }
    if (scraped < contacts.length) await sleep(DELAY_BETWEEN_MS);
  }

  // Check if we've now reached 20 — if so, trigger likeSender automatically
  const { rows: totalNow } = await db.query(
    `SELECT COUNT(*) AS cnt FROM contacts
     WHERE campaign_id = $1 AND engagement_level IS NOT NULL`,
    [campaign.id]
  );
  const totalClassified = parseInt(totalNow[0].cnt, 10);

  if (totalClassified >= TARGET_CLASSIFIED) {
    console.log(`[EngagementScraper] Campaign ${campaign.id}: reached ${totalClassified} classified — triggering LikeSender`);
    // Import here to avoid circular dep at startup
    const likeSender = require('./likeSender');
    likeSender.run(campaign.id).then(r => {
      console.log(`[EngagementScraper] LikeSender result for campaign ${campaign.id}:`, JSON.stringify(r));
    }).catch(err => {
      console.error(`[EngagementScraper] LikeSender error:`, err.message);
    });
  }

  return { contacts_scraped: scraped, contacts_classified: classified, total_classified: totalClassified };
}

async function scrapeContact(contact, accountId) {
  const cutoff         = new Date(Date.now() - DAYS_14);
  const contactCompany = (contact.company || '').toLowerCase().trim();

  let rawPosts    = [];
  let rawComments = [];

  try { rawPosts    = await unipile.getUserPosts(accountId, contact.provider_id, 100); }
  catch (err) { console.warn(`[Scraper] Posts failed ${contact.provider_id}: ${err.message}`); }

  try { rawComments = await unipile.getUserComments(accountId, contact.provider_id, 100); }
  catch (err) { console.warn(`[Scraper] Comments failed ${contact.provider_id}: ${err.message}`); }

  const posts14d    = rawPosts.filter(p => isWithin14Days(p, cutoff));
  const comments14d = rawComments.filter(c => isWithin14Days(c, cutoff));

  const nonEmployerPosts    = posts14d.filter(p => !isEmployerRelated(p, contactCompany, 'post'));
  const nonEmployerComments = comments14d.filter(c => !isEmployerRelated(c, contactCompany, 'comment'));

  const level = classifyEngagement(nonEmployerPosts.length, nonEmployerComments.length);

  const engagementData = {
    scraped_at:                     new Date().toISOString(),
    posts_total:                    rawPosts.length,
    comments_total:                 rawComments.length,
    posts_14d:                      posts14d.length,
    comments_14d:                   comments14d.length,
    non_employer_posts_14d:         nonEmployerPosts.length,
    non_employer_comments_14d:      nonEmployerComments.length,
    engagement_level:               level,
    contact_company:                contact.company || '',
    posts:                          rawPosts,
    comments:                       rawComments,
    posts_14d_data:                 posts14d,
    comments_14d_data:              comments14d,
    non_employer_posts_14d_data:    nonEmployerPosts,
    non_employer_comments_14d_data: nonEmployerComments,
  };

  await db.query(
    `UPDATE contacts
     SET engagement_level      = $1,
         engagement_scraped_at = NOW(),
         engagement_data       = $2
     WHERE id = $3`,
    [level, JSON.stringify(engagementData), contact.id]
  );

  console.log(`[EngagementScraper] ✓ ${contact.first_name} ${contact.last_name} → ${level}`);
  return { engagement_level: level };
}

function classifyEngagement(nonEmployerPosts, nonEmployerComments) {
  if (nonEmployerPosts >= 2 && nonEmployerComments >= 2) return 'engaged';
  if (nonEmployerPosts >= 1 && nonEmployerComments >= 1) return 'average_engaged';
  return 'un_engaged';
}

function isWithin14Days(item, cutoff) {
  const ts = item.created_at || item.date || item.published_at || item.timestamp;
  if (!ts) return false;
  const d = new Date(typeof ts === 'number' ? ts * 1000 : ts);
  return !isNaN(d.getTime()) && d >= cutoff;
}

function isEmployerRelated(item, company, type) {
  if (!company) return false;
  if (type === 'post') {
    if (item.as_organization) return true;
    const headline = (item.author?.headline || item.author_headline || '').toLowerCase();
    const co       = (item.author?.company  || item.author_company  || '').toLowerCase();
    if (co && co.includes(company))       return true;
    if (headline && headline.includes(company)) return true;
    const reshared = (item.reshared?.author?.name || item.reshared_from || '').toLowerCase();
    if (reshared && reshared.includes(company)) return true;
  }
  if (type === 'comment') {
    if (item.post?.as_organization || item.parent_post?.as_organization) return true;
    const postHeadline = (item.post?.author?.headline || item.parent_post?.author?.headline || item.post_author_headline || '').toLowerCase();
    const postCo       = (item.post?.author?.company  || item.parent_post?.author?.company  || item.post_author_company  || '').toLowerCase();
    if (postCo && postCo.includes(company))           return true;
    if (postHeadline && postHeadline.includes(company)) return true;
  }
  return false;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { start, run, scrapeContact };

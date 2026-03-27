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
 *   7. When 20 contacts with content (non un_engaged) found → trigger likeSender
 *
 * Engagement levels (OR logic):
 *   un_engaged       — 0 non-employer posts AND 0 non-employer comments in 14d
 *   average_engaged  — ≥1 non-employer post OR ≥1 non-employer comment in 14d
 *   engaged          — ≥2 non-employer posts OR ≥2 non-employer comments in 14d
 *
 * Target: 20 contacts with average_engaged or engaged (has content in last 14 days).
 * un_engaged contacts do NOT count toward the target — keep scanning.
 *
 * "Employer-related" = posted as company page, or parent post author matches company
 *
 * Scheduled: once daily at 06:00.
 */

const db      = require('./db');
const unipile = require('./unipile');

const DAYS_14                = 14 * 24 * 60 * 60 * 1000;
const TARGET_WITH_CONTENT    = 20;   // Need 20 contacts with actual content (not un_engaged)
const BATCH_SIZE             = 30;   // Contacts to process per run
const DELAY_BETWEEN_MS       = 3000 + Math.random() * 2000;

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

  // Count contacts WITH content (average_engaged or engaged) — these are the target
  const { rows: withContent } = await db.query(
    `SELECT COUNT(*) AS cnt FROM contacts
     WHERE campaign_id = $1
       AND engagement_level IN ('average_engaged', 'engaged')`,
    [campaign.id]
  );
  const contentCount = parseInt(withContent[0].cnt, 10);

  if (contentCount >= TARGET_WITH_CONTENT) {
    console.log(`[EngagementScraper] Campaign ${campaign.id}: already has ${contentCount} contacts with content — triggering LikeSender`);
    const likeSender = require('./likeSender');
    likeSender.run(campaign.id).catch(err => console.error('[EngagementScraper] LikeSender error:', err.message));
    return { skipped: true, content_count: contentCount };
  }

  const remaining = TARGET_WITH_CONTENT - contentCount;
  console.log(`[EngagementScraper] Campaign ${campaign.id}: need ${remaining} more contacts with content`);

  // Get unscraped enriched contacts (no engagement_level yet)
  const { rows: contacts } = await db.query(
    `SELECT id, first_name, last_name, company, provider_id
     FROM contacts
     WHERE campaign_id = $1
       AND provider_id IS NOT NULL
       AND provider_id != ''
       AND engagement_level IS NULL
     ORDER BY RANDOM()
     LIMIT $2`,
    [campaign.id, BATCH_SIZE]
  );

  if (!contacts.length) {
    console.log(`[EngagementScraper] Campaign ${campaign.id}: no more unscraped enriched contacts`);
    return { contacts_scraped: 0 };
  }

  let scraped      = 0;
  let foundContent = 0;

  for (const contact of contacts) {
    try {
      const result = await scrapeContact(contact, campaign.account_id);
      scraped++;
      if (result && result.engagement_level !== 'un_engaged') {
        foundContent++;
      }
    } catch (err) {
      console.error(`[EngagementScraper] ✗ contact ${contact.id}: ${err.message}`);
    }
    if (scraped < contacts.length) await sleep(DELAY_BETWEEN_MS);
  }

  // Re-check total with content after this batch
  const { rows: totalNow } = await db.query(
    `SELECT COUNT(*) AS cnt FROM contacts
     WHERE campaign_id = $1
       AND engagement_level IN ('average_engaged', 'engaged')`,
    [campaign.id]
  );
  const totalWithContent = parseInt(totalNow[0].cnt, 10);

  console.log(`[EngagementScraper] Campaign ${campaign.id}: ${totalWithContent}/${TARGET_WITH_CONTENT} contacts with content`);

  if (totalWithContent >= TARGET_WITH_CONTENT) {
    console.log(`[EngagementScraper] Campaign ${campaign.id}: reached target — triggering LikeSender`);
    const likeSender = require('./likeSender');
    likeSender.run(campaign.id)
      .then(r => console.log(`[LikeSender] done:`, JSON.stringify(r)))
      .catch(err => console.error('[LikeSender] error:', err.message));
  }

  return { contacts_scraped: scraped, found_with_content: foundContent, total_with_content: totalWithContent };
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

  console.log(`[EngagementScraper] ✓ ${contact.first_name} ${contact.last_name} → ${level} (posts_14d=${nonEmployerPosts.length} comments_14d=${nonEmployerComments.length})`);
  return { engagement_level: level };
}

/**
 * Re-classify contacts from existing engagement_data in DB.
 * No API calls — just re-applies the classification logic.
 * Used after fixing the classification logic without losing scraped data.
 */
async function reclassifyFromExistingData(campaignId) {
  const { rows } = await db.query(
    `SELECT id, first_name, last_name, engagement_data
     FROM contacts
     WHERE campaign_id = $1
       AND engagement_data IS NOT NULL
       AND engagement_level IS NOT NULL`,
    [campaignId]
  );

  console.log(`[Reclassify] ${rows.length} contacts to reclassify for campaign ${campaignId}`);
  let updated = 0;

  for (const row of rows) {
    const d = typeof row.engagement_data === 'string'
      ? JSON.parse(row.engagement_data)
      : row.engagement_data;

    const nep = d.non_employer_posts_14d    || 0;
    const nec = d.non_employer_comments_14d || 0;
    const newLevel = classifyEngagement(nep, nec);
    const oldLevel = d.engagement_level;

    // Update the level in engagement_data too
    d.engagement_level = newLevel;

    await db.query(
      `UPDATE contacts SET engagement_level = $1, engagement_data = $2 WHERE id = $3`,
      [newLevel, JSON.stringify(d), row.id]
    );

    if (newLevel !== oldLevel) {
      console.log(`[Reclassify] ${row.first_name} ${row.last_name}: ${oldLevel} → ${newLevel} (posts=${nep} comments=${nec})`);
    }
    updated++;
  }

  return { reclassified: updated };
}

// ── Classification (OR logic) ────────────────────────────────────────────────────────
/**
 * OR-based classification:
 *   engaged         = ≥2 non-employer posts OR ≥2 non-employer comments
 *   average_engaged = ≥1 non-employer post  OR ≥1 non-employer comment
 *   un_engaged      = 0 posts AND 0 comments in last 14 days
 */
function classifyEngagement(nonEmployerPosts, nonEmployerComments) {
  if (nonEmployerPosts >= 2 || nonEmployerComments >= 2) return 'engaged';
  if (nonEmployerPosts >= 1 || nonEmployerComments >= 1) return 'average_engaged';
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
    if (co && co.includes(company))             return true;
    if (headline && headline.includes(company)) return true;
    const reshared = (item.reshared?.author?.name || item.reshared_from || '').toLowerCase();
    if (reshared && reshared.includes(company)) return true;
  }
  if (type === 'comment') {
    if (item.post?.as_organization || item.parent_post?.as_organization) return true;
    const postHeadline = (item.post?.author?.headline || item.parent_post?.author?.headline || '').toLowerCase();
    const postCo       = (item.post?.author?.company  || item.parent_post?.author?.company  || '').toLowerCase();
    if (postCo && postCo.includes(company))             return true;
    if (postHeadline && postHeadline.includes(company)) return true;
  }
  return false;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { start, run, scrapeContact, reclassifyFromExistingData };

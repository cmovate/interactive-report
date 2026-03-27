/**
 * Engagement Scraper
 *
 * Scrapes LinkedIn posts & comments for contacts in campaigns
 * that have like_posts or like_comments engagement actions enabled.
 *
 * Flow:
 *   1. Find active campaigns with like_posts or like_comments enabled
 *   2. For each campaign, get all enriched contacts (those with provider_id)
 *   3. Shuffle randomly, process one by one
 *   4. For each contact: fetch posts + comments from last 14 days via Unipile API
 *   5. Classify into engagement level
 *   6. Save full raw data to DB as JSONB
 *   7. Stop when 20 contacts in the campaign have been classified
 *
 * Engagement levels:
 *   un_engaged       — 0 posts AND 0 non-employer comments in 14 days
 *   average_engaged  — ≥1 post AND ≥1 non-employer comment in 14 days
 *   engaged          — ≥2 posts AND ≥2 non-employer comments in 14 days
 *
 * "Employer-related" detection:
 *   A post/comment is employer-related if:
 *   - It was posted AS a company page (as_organization field is set)
 *   - The parent post's author headline/company matches the contact's company name
 *
 * Scheduled: once daily.
 */

const db      = require('./db');
const unipile = require('./unipile');

const DAYS_14         = 14 * 24 * 60 * 60 * 1000;
const TARGET_CLASSIFIED = 20;  // Stop per-campaign once this many are classified
const DELAY_BETWEEN_MS  = 3000 + Math.random() * 2000; // 3-5s between contacts

let isRunning = false;

function start() {
  console.log('[EngagementScraper] Started — runs daily at 06:00');
  scheduleDaily();
}

function scheduleDaily() {
  const now      = new Date();
  const next6am  = new Date(now);
  next6am.setHours(6, 0, 0, 0);
  if (next6am <= now) next6am.setDate(next6am.getDate() + 1);
  const msUntil = next6am - now;
  console.log(`[EngagementScraper] Next run in ${Math.round(msUntil/3600000)}h`);
  setTimeout(() => { run(); setInterval(run, 24 * 60 * 60 * 1000); }, msUntil);
}

/**
 * Main entry point — also callable manually via API.
 * @param {number|null} campaignId - Scrape only this campaign (null = all eligible)
 */
async function run(campaignId = null) {
  if (isRunning) {
    console.log('[EngagementScraper] Already running, skipping');
    return { skipped: true };
  }
  isRunning = true;
  console.log('[EngagementScraper] Starting run...');

  try {
    // Find campaigns with like_posts or like_comments enabled
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

  // Count how many contacts are already classified in this campaign
  const { rows: alreadyDone } = await db.query(
    `SELECT COUNT(*) AS cnt FROM contacts
     WHERE campaign_id = $1 AND engagement_level IS NOT NULL`,
    [campaign.id]
  );
  const alreadyClassified = parseInt(alreadyDone[0].cnt, 10);

  if (alreadyClassified >= TARGET_CLASSIFIED) {
    console.log(`[EngagementScraper] Campaign ${campaign.id}: already has ${alreadyClassified} classified, skipping`);
    return { skipped: true, already_classified: alreadyClassified };
  }

  const remaining = TARGET_CLASSIFIED - alreadyClassified;
  console.log(`[EngagementScraper] Campaign ${campaign.id}: need ${remaining} more classified`);

  // Get all unscraped enriched contacts (those with provider_id, not yet classified)
  const { rows: contacts } = await db.query(
    `SELECT id, first_name, last_name, company, provider_id, member_urn, li_profile_url
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

  console.log(`[EngagementScraper] Campaign ${campaign.id}: processing ${contacts.length} contacts`);

  let scraped = 0;
  let classified = 0;

  for (const contact of contacts) {
    if (classified >= remaining) break;

    try {
      const result = await scrapeContact(contact, campaign.account_id);
      if (result) {
        scraped++;
        classified++;
        console.log(`[EngagementScraper] ✓ ${contact.first_name} ${contact.last_name} → ${result.engagement_level}`);
      }
    } catch (err) {
      console.error(`[EngagementScraper] ✗ contact ${contact.id}: ${err.message}`);
    }

    // Polite delay between contacts
    if (scraped < contacts.length) {
      await sleep(DELAY_BETWEEN_MS);
    }
  }

  return { contacts_scraped: scraped, contacts_classified: classified };
}

/**
 * Scrape posts + comments for a single contact, classify, and save.
 */
async function scrapeContact(contact, accountId) {
  const cutoff = new Date(Date.now() - DAYS_14);
  const contactCompany = (contact.company || '').toLowerCase().trim();

  // Fetch posts (last 14 days)
  let rawPosts = [];
  try {
    rawPosts = await unipile.getUserPosts(accountId, contact.provider_id, 100);
  } catch (err) {
    console.warn(`[EngagementScraper] Could not fetch posts for ${contact.provider_id}: ${err.message}`);
  }

  // Fetch comments (last 14 days)
  let rawComments = [];
  try {
    rawComments = await unipile.getUserComments(accountId, contact.provider_id, 100);
  } catch (err) {
    console.warn(`[EngagementScraper] Could not fetch comments for ${contact.provider_id}: ${err.message}`);
  }

  // Filter to last 14 days
  const posts14d    = rawPosts.filter(p => isWithin14Days(p, cutoff));
  const comments14d = rawComments.filter(c => isWithin14Days(c, cutoff));

  // Classify posts — employer-related detection
  const nonEmployerPosts = posts14d.filter(p => !isEmployerRelated(p, contactCompany, 'post'));

  // Classify comments — employer-related detection
  const nonEmployerComments = comments14d.filter(c => !isEmployerRelated(c, contactCompany, 'comment'));

  // Determine engagement level
  const level = classifyEngagement(nonEmployerPosts.length, nonEmployerComments.length);

  // Build the full engagement_data JSON to store
  const engagementData = {
    scraped_at:                  new Date().toISOString(),
    posts_total:                 rawPosts.length,
    comments_total:              rawComments.length,
    posts_14d:                   posts14d.length,
    comments_14d:                comments14d.length,
    non_employer_posts_14d:      nonEmployerPosts.length,
    non_employer_comments_14d:   nonEmployerComments.length,
    engagement_level:            level,
    contact_company:             contact.company || '',
    // Full raw data
    posts:    rawPosts,
    comments: rawComments,
    // 14-day filtered data (for quick access)
    posts_14d_data:                 posts14d,
    comments_14d_data:              comments14d,
    non_employer_posts_14d_data:    nonEmployerPosts,
    non_employer_comments_14d_data: nonEmployerComments,
  };

  // Save to DB
  await db.query(
    `UPDATE contacts
     SET engagement_level     = $1,
         engagement_scraped_at = NOW(),
         engagement_data       = $2
     WHERE id = $3`,
    [level, JSON.stringify(engagementData), contact.id]
  );

  return { engagement_level: level, engagementData };
}

// ── Classification helpers ──────────────────────────────────────────────────

/**
 * Determine the engagement level.
 * engaged         = 2+ non-employer posts AND 2+ non-employer comments
 * average_engaged = 1+ non-employer post  AND 1+ non-employer comment
 * un_engaged      = everything else (including no activity)
 */
function classifyEngagement(nonEmployerPosts, nonEmployerComments) {
  if (nonEmployerPosts >= 2 && nonEmployerComments >= 2) return 'engaged';
  if (nonEmployerPosts >= 1 && nonEmployerComments >= 1) return 'average_engaged';
  return 'un_engaged';
}

/**
 * Check if a post/comment item falls within the last 14 days.
 * Unipile uses different date fields depending on item type.
 */
function isWithin14Days(item, cutoff) {
  const ts = item.created_at || item.date || item.published_at || item.timestamp;
  if (!ts) return false;
  const d = new Date(typeof ts === 'number' ? ts * 1000 : ts);
  return !isNaN(d.getTime()) && d >= cutoff;
}

/**
 * Detect if a post or comment is employer-related.
 *
 * A post is employer-related if:
 *   - It was published AS a company/organization (as_organization is set)
 *   - The post author's company matches the contact's company
 *
 * A comment is employer-related if:
 *   - The parent post's author headline or company matches the contact's company
 *   - The parent post was posted by a company page that matches
 *
 * @param {object} item          - Post or comment object from Unipile API
 * @param {string} company       - Contact's company name (lowercase, trimmed)
 * @param {'post'|'comment'} type
 */
function isEmployerRelated(item, company, type) {
  if (!company) return false; // Can't determine without company info

  if (type === 'post') {
    // Posted as a company/organization page
    if (item.as_organization) return true;

    // Check if post author context mentions their company
    const authorHeadline = (item.author?.headline || item.author_headline || '').toLowerCase();
    const authorCompany  = (item.author?.company  || item.author_company  || '').toLowerCase();
    const authorName     = (item.author?.name      || item.author_name      || '').toLowerCase();

    if (authorCompany  && authorCompany.includes(company))  return true;
    if (authorHeadline && authorHeadline.includes(company)) return true;

    // Check if reshared from company page
    const resharedFrom = (item.reshared?.author?.name || item.reshared_from || '').toLowerCase();
    if (resharedFrom && resharedFrom.includes(company)) return true;
  }

  if (type === 'comment') {
    // Check parent post author
    const postAuthorHeadline = (
      item.post?.author?.headline ||
      item.parent_post?.author?.headline ||
      item.post_author_headline || ''
    ).toLowerCase();
    const postAuthorCompany = (
      item.post?.author?.company ||
      item.parent_post?.author?.company ||
      item.post_author_company || ''
    ).toLowerCase();
    const postAuthorName = (
      item.post?.author?.name ||
      item.parent_post?.author?.name ||
      item.post_author_name || ''
    ).toLowerCase();

    if (postAuthorCompany  && postAuthorCompany.includes(company))  return true;
    if (postAuthorHeadline && postAuthorHeadline.includes(company)) return true;

    // Check if parent post was posted as organization matching their company
    const postAsOrg = item.post?.as_organization || item.parent_post?.as_organization;
    if (postAsOrg) return true;
  }

  return false;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { start, run, scrapeContact };

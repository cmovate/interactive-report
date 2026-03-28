/**
 * Company Engagement Scraper
 *
 * Runs daily for ALL active campaigns regardless of settings.
 * Scrapes company posts (last 14 days) for every company in
 * campaign_companies and saves full data as JSONB to DB.
 *
 * Whether to LIKE is a separate decision controlled by campaign
 * settings (like_company_posts or like_posts). Scraping always happens.
 *
 * Key differences from contact scraper:
 *   - Only POSTS (companies don't write comments)
 *   - No employer-related filtering needed
 *   - isCompany=true in getUserPosts
 *   - Only post_likes_sent (no comment_likes_sent)
 *
 * Engagement levels (company posts only):
 *   engaged         = ≥2 posts in last 14 days
 *   average_engaged = ≥1 post  in last 14 days
 *   un_engaged      = 0 posts  in last 14 days
 *
 * Cooldown: 3 days between re-liking (scraping always happens regardless)
 * Dedup: liked_ids tracks post social_ids already liked
 *
 * Scheduled: once daily at 06:30.
 */

const db      = require('./db');
const unipile = require('./unipile');

const DAYS_14       = 14 * 24 * 60 * 60 * 1000;
const MAX_LIKES     = 3;
const COOLDOWN_DAYS = 3;
const BATCH_SIZE    = 20;

const rand  = (min, max) => min + Math.random() * (max - min);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let isRunning = false;

function start() {
  console.log('[CompanyScraper] Started — runs daily at 06:30');
  scheduleDaily();
}

function scheduleDaily() {
  const now  = new Date();
  const next = new Date(now);
  next.setHours(6, 30, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const msUntil = next - now;
  console.log(`[CompanyScraper] Next run in ${Math.round(msUntil / 3600000)}h`);
  setTimeout(() => { run(); setInterval(run, 24 * 60 * 60 * 1000); }, msUntil);
}

async function run(campaignId = null) {
  if (isRunning) { console.log('[CompanyScraper] Already running, skipping'); return { skipped: true }; }
  isRunning = true;
  console.log('[CompanyScraper] Starting run...');

  try {
    // ALL active campaigns with companies — scraping is unconditional
    let query = `
      SELECT DISTINCT c.id, c.account_id, c.name, c.settings
      FROM campaigns c
      JOIN campaign_companies cc ON cc.campaign_id = c.id
      WHERE c.status = 'active'
        AND cc.company_linkedin_id IS NOT NULL
    `;
    const qp = [];
    if (campaignId) { qp.push(campaignId); query += ` AND c.id = $${qp.length}`; }

    const { rows: campaigns } = await db.query(query, qp);
    if (!campaigns.length) { console.log('[CompanyScraper] No eligible campaigns'); return { campaigns_processed: 0 }; }

    const summary = [];
    for (const campaign of campaigns) {
      const result = await processCampaign(campaign);
      summary.push({ campaign_id: campaign.id, name: campaign.name, ...result });
    }

    console.log('[CompanyScraper] Done:', JSON.stringify(summary));
    return { campaigns_processed: campaigns.length, summary };
  } catch (err) {
    console.error('[CompanyScraper] Error:', err.message);
    return { error: err.message };
  } finally {
    isRunning = false;
  }
}

async function processCampaign(campaign) {
  console.log(`[CompanyScraper] Campaign ${campaign.id}: "${campaign.name}"`);

  // Liking is optional — controlled by campaign settings
  const eng = campaign.settings?.engagement || {};
  const canLike = !!(eng.like_company_posts || eng.like_posts);

  // Get unscraped companies (no engagement_level yet)
  // Cooldown only applies to liking, not to scraping.
  // But we skip re-scraping companies already classified to avoid wasting API calls.
  const { rows: companies } = await db.query(
    `SELECT id, company_name, company_linkedin_id,
            post_likes_sent, liked_ids, likes_sent_at
     FROM campaign_companies
     WHERE campaign_id = $1
       AND company_linkedin_id IS NOT NULL
       AND company_linkedin_id != ''
       AND engagement_level IS NULL
     ORDER BY RANDOM()
     LIMIT $2`,
    [campaign.id, BATCH_SIZE]
  );

  if (!companies.length) {
    console.log(`[CompanyScraper] Campaign ${campaign.id}: no companies left to scrape`);
    return { companies_scraped: 0 };
  }

  console.log(`[CompanyScraper] Campaign ${campaign.id}: processing ${companies.length} companies`);

  let scraped = 0, withContent = 0, totalLiked = 0;

  for (const company of companies) {
    try {
      // Step 1-3: Always scrape and save
      const result = await scrapeCompany(company, campaign.account_id);
      scraped++;

      // Step 4: Like only if campaign settings allow it AND company has posts
      if (result && result.engagement_level !== 'un_engaged') {
        withContent++;
        if (canLike) {
          // Check cooldown before liking
          const COOLDOWN_MS = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
          const lastLiked   = company.likes_sent_at ? new Date(company.likes_sent_at).getTime() : 0;
          const onCooldown  = (Date.now() - lastLiked) < COOLDOWN_MS;
          if (!onCooldown) {
            await sleep(rand(2000, 5000));
            const liked = await likeCompanyPosts(company, result.posts14d, campaign.account_id);
            totalLiked += liked;
          }
        }
      }
    } catch (err) {
      console.error(`[CompanyScraper] ✗ company ${company.id} (${company.company_name}): ${err.message}`);
    }

    // Random delay between companies: 10-25s
    if (scraped < companies.length) await sleep(rand(10000, 25000));
  }

  const { rows: stats } = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE engagement_level IN ('average_engaged','engaged')) AS with_content,
       COUNT(*) FILTER (WHERE engagement_level = 'un_engaged')                   AS un_engaged,
       COUNT(*) FILTER (WHERE engagement_level IS NULL)                          AS pending
     FROM campaign_companies WHERE campaign_id = $1`,
    [campaign.id]
  );
  const s = stats[0];
  console.log(`[CompanyScraper] Campaign ${campaign.id}: with_content=${s.with_content} un_engaged=${s.un_engaged} pending=${s.pending}`);

  return { companies_scraped: scraped, with_content: withContent, total_liked: totalLiked };
}

// ── Scrape a single company ───────────────────────────────────────────────────
async function scrapeCompany(company, accountId) {
  const cutoff = new Date(Date.now() - DAYS_14);

  let rawPosts = [];
  try {
    rawPosts = await unipile.getUserPosts(accountId, company.company_linkedin_id, 100, true);
  } catch (err) {
    console.warn(`[CompanyScraper] Posts failed for ${company.company_name}: ${err.message}`);
  }

  const posts14d = rawPosts.filter(p => isWithin14Days(p, cutoff));
  const level    = classifyEngagement(posts14d.length);

  const engagementData = {
    scraped_at:     new Date().toISOString(),
    posts_total:    rawPosts.length,
    posts_14d:      posts14d.length,
    engagement_level: level,
    // Full raw data stored as JSONB
    posts:          rawPosts,
    posts_14d_data: posts14d,
  };

  await db.query(
    `UPDATE campaign_companies
     SET engagement_level      = $1,
         engagement_scraped_at = NOW(),
         engagement_data       = $2
     WHERE id = $3`,
    [level, JSON.stringify(engagementData), company.id]
  );

  console.log(`[CompanyScraper] ✓ ${company.company_name} → ${level} (posts_14d=${posts14d.length})`);
  return { engagement_level: level, posts14d };
}

// ── Like company posts (only when campaign settings allow) ────────────────────
async function likeCompanyPosts(company, posts14d, accountId) {
  const { rows } = await db.query(
    'SELECT liked_ids, post_likes_sent FROM campaign_companies WHERE id = $1',
    [company.id]
  );
  const alreadyLiked = new Set(Array.isArray(rows[0]?.liked_ids) ? rows[0].liked_ids : []);
  const alreadySent  = rows[0]?.post_likes_sent || 0;
  const remaining    = MAX_LIKES - alreadySent;
  if (remaining <= 0) return 0;

  const newPosts = posts14d.filter(p => {
    const sid = String(p.social_id || p.id || p.post_id || '');
    return sid && !alreadyLiked.has(sid);
  });

  if (!newPosts.length) { console.log(`[CompanyScraper] ${company.company_name}: no new posts to like`); return 0; }

  let liked = 0;
  const newLikedIds = [];

  for (const post of newPosts) {
    if (liked >= remaining) break;
    const sid = String(post.social_id || post.id || post.post_id || '');
    if (!sid) continue;
    try {
      await unipile.likePost(accountId, sid);
      newLikedIds.push(sid);
      liked++;
      console.log(`[CompanyScraper] 👍 Liked post for ${company.company_name}`);
      if (liked < remaining && liked < newPosts.length) await sleep(rand(5000, 15000));
    } catch (err) {
      console.error(`[CompanyScraper] ✗ Like failed for ${company.company_name}: ${err.message}`);
    }
  }

  if (liked > 0) {
    const merged = [...alreadyLiked, ...newLikedIds];
    await db.query(
      `UPDATE campaign_companies
       SET post_likes_sent = COALESCE(post_likes_sent, 0) + $1,
           likes_sent_at   = NOW(),
           liked_ids       = $2::jsonb
       WHERE id = $3`,
      [liked, JSON.stringify(merged), company.id]
    );
  }

  return liked;
}

// ── Re-classify from existing data (no API calls) ─────────────────────────────
async function reclassifyFromExistingData(campaignId) {
  const { rows } = await db.query(
    `SELECT id, company_name, engagement_data FROM campaign_companies
     WHERE campaign_id = $1 AND engagement_data IS NOT NULL AND engagement_level IS NOT NULL`,
    [campaignId]
  );
  let updated = 0;
  for (const row of rows) {
    const d = typeof row.engagement_data === 'string' ? JSON.parse(row.engagement_data) : row.engagement_data;
    const newLevel = classifyEngagement(d.posts_14d || 0);
    const oldLevel = d.engagement_level;
    d.engagement_level = newLevel;
    await db.query('UPDATE campaign_companies SET engagement_level = $1, engagement_data = $2 WHERE id = $3', [newLevel, JSON.stringify(d), row.id]);
    if (newLevel !== oldLevel) console.log(`[CompanyScraper reclassify] ${row.company_name}: ${oldLevel} → ${newLevel}`);
    updated++;
  }
  return { reclassified: updated };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Company classification — posts only: engaged=≥2, average_engaged=≥1, un_engaged=0 */
function classifyEngagement(posts14dCount) {
  if (posts14dCount >= 2) return 'engaged';
  if (posts14dCount >= 1) return 'average_engaged';
  return 'un_engaged';
}

function isWithin14Days(item, cutoff) {
  const ts = item.created_at || item.date || item.published_at || item.timestamp;
  if (!ts) return false;
  const d = new Date(typeof ts === 'number' ? ts * 1000 : ts);
  return !isNaN(d.getTime()) && d >= cutoff;
}

module.exports = { start, run, reclassifyFromExistingData };

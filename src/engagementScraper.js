/**
 * Engagement Scraper
 *
 * Flow (parallel — like immediately after scraping):
 *   For each contact:
 *     1. Fetch posts + comments (last 14 days)
 *     2. Classify engagement level & save to DB
 *     3. If has content → like up to 3 NEW items immediately
 *     4. Random delay → next contact
 *
 * Rules:
 *   - Skip contacts liked in last 3 days (likes_sent_at > NOW() - 3d)
 *   - Never like the same post/comment twice (tracked in liked_ids JSONB)
 *   - All API calls use random delays
 *
 * Engagement levels (OR logic):
 *   un_engaged       — 0 posts AND 0 comments in 14d
 *   average_engaged  — ≥1 post OR ≥1 comment in 14d
 *   engaged          — ≥2 posts OR ≥2 comments in 14d
 *
 * Scheduled: once daily at 06:00.
 */

const db      = require('./db');
const unipile = require('./unipile');

const DAYS_14         = 14 * 24 * 60 * 60 * 1000;
const COOLDOWN_DAYS   = 3;   // Days to wait before re-scraping a liked contact
const MAX_LIKES       = 3;   // Max likes per contact per run
const BATCH_SIZE      = 30;

const rand  = (min, max) => min + Math.random() * (max - min);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let isRunning = false;

function start() {
  console.log('[EngagementScraper] Started — runs daily at 06:00');
  scheduleDaily();
}

function scheduleDaily() {
  const now = new Date();
  const next6am = new Date(now);
  next6am.setHours(6, 0, 0, 0);
  if (next6am <= now) next6am.setDate(next6am.getDate() + 1);
  const msUntil = next6am - now;
  console.log(`[EngagementScraper] Next run in ${Math.round(msUntil / 3600000)}h`);
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
    const qp = [];
    if (campaignId) { qp.push(campaignId); query += ` AND c.id = $${qp.length}`; }

    const { rows: campaigns } = await db.query(query, qp);
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

  // Load account settings for company page URN
  const { rows: accRows } = await db.query(
    'SELECT settings FROM unipile_accounts WHERE account_id = $1',
    [campaign.account_id]
  );
  const companyPageUrn = accRows[0]?.settings?.company_page_urn || null;

  const eng = campaign.settings?.engagement || {};
  const likeFlags = {
    doLikePosts:           !!eng.like_posts,
    doLikeComments:        !!eng.like_comments,
    doCompanyLikePosts:    !!eng.company_like_posts   && !!companyPageUrn,
    doCompanyLikeComments: !!eng.company_like_comments && !!companyPageUrn,
  };
  const canLike = Object.values(likeFlags).some(Boolean);

  // Get unscraped enriched contacts
  // RULE: Skip contacts liked in last COOLDOWN_DAYS days
  const cooldownCutoff = new Date(Date.now() - COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { rows: contacts } = await db.query(
    `SELECT id, first_name, last_name, company, provider_id,
            liked_ids, post_likes_sent, comment_likes_sent
     FROM contacts
     WHERE campaign_id = $1
       AND provider_id IS NOT NULL AND provider_id != ''
       AND engagement_level IS NULL
       AND (
         likes_sent_at IS NULL
         OR likes_sent_at < $2
       )
     ORDER BY RANDOM()
     LIMIT $3`,
    [campaign.id, cooldownCutoff, BATCH_SIZE]
  );

  if (!contacts.length) {
    console.log(`[EngagementScraper] Campaign ${campaign.id}: no eligible unscraped contacts`);
    return { contacts_scraped: 0 };
  }

  console.log(`[EngagementScraper] Campaign ${campaign.id}: processing ${contacts.length} contacts`);

  let scraped = 0, foundContent = 0, totalLiked = 0;

  for (const contact of contacts) {
    try {
      // Step 1: Scrape & classify
      const scrapeResult = await scrapeContact(contact, campaign.account_id);
      scraped++;

      // Step 2: If has content → like immediately
      if (scrapeResult && scrapeResult.engagement_level !== 'un_engaged' && canLike) {
        foundContent++;
        await sleep(rand(2000, 5000)); // Short pause between scrape and like
        const likeResult = await likeContactFromData(
          contact, scrapeResult.engagementData,
          campaign.account_id, companyPageUrn, likeFlags
        );
        totalLiked += likeResult.postLikes + likeResult.commentLikes;
      }
    } catch (err) {
      console.error(`[EngagementScraper] ✗ contact ${contact.id}: ${err.message}`);
    }

    // Random delay between contacts: 8-20s
    if (scraped < contacts.length) await sleep(rand(8000, 20000));
  }

  const { rows: statsRows } = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE engagement_level IN ('average_engaged','engaged')) AS with_content,
       COUNT(*) FILTER (WHERE engagement_level = 'un_engaged')                   AS un_engaged,
       COUNT(*) FILTER (WHERE engagement_level IS NULL AND provider_id IS NOT NULL) AS pending
     FROM contacts WHERE campaign_id = $1`,
    [campaign.id]
  );
  const stats = statsRows[0];
  console.log(`[EngagementScraper] Campaign ${campaign.id}: with_content=${stats.with_content} un_engaged=${stats.un_engaged} pending=${stats.pending}`);

  return {
    contacts_scraped:         scraped,
    found_with_content:       foundContent,
    total_likes_sent:         totalLiked,
    cumulative_with_content:  parseInt(stats.with_content, 10),
  };
}

// ── Scrape a single contact ───────────────────────────────────────────────────
async function scrapeContact(contact, accountId) {
  const cutoff = new Date(Date.now() - DAYS_14);
  const contactCompany = (contact.company || '').toLowerCase().trim();

  let rawPosts = [], rawComments = [];

  try { rawPosts = await unipile.getUserPosts(accountId, contact.provider_id, 100); }
  catch (err) { console.warn(`[Scraper] Posts failed ${contact.provider_id}: ${err.message}`); }

  await sleep(rand(3000, 8000)); // Random delay between posts & comments API calls

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

  console.log(
    `[EngagementScraper] ✓ ${contact.first_name} ${contact.last_name} → ${level}` +
    ` (posts=${nonEmployerPosts.length} comments=${nonEmployerComments.length})`
  );

  return { engagement_level: level, engagementData };
}

// ── Like up to MAX_LIKES new items immediately after scraping ─────────────────
async function likeContactFromData(contact, engData, accountId, companyPageUrn, flags) {
  // Load current liked_ids from DB (IDs we've already liked for this contact)
  const { rows } = await db.query('SELECT liked_ids FROM contacts WHERE id = $1', [contact.id]);
  const alreadyLiked = new Set(
    Array.isArray(rows[0]?.liked_ids) ? rows[0].liked_ids : []
  );

  const items = [];

  // Collect likeable posts (not already liked)
  if (flags.doLikePosts || flags.doCompanyLikePosts) {
    const posts = engData.non_employer_posts_14d_data || engData.posts_14d_data || [];
    for (const p of posts) {
      const sid = String(p.social_id || p.id || p.post_id || '');
      if (sid && !alreadyLiked.has(sid)) {
        items.push({ type: 'post', social_id: sid });
      }
    }
  }

  // Collect likeable comments (not already liked)
  if (flags.doLikeComments || flags.doCompanyLikeComments) {
    const comments = engData.non_employer_comments_14d_data || engData.comments_14d_data || [];
    for (const c of comments) {
      const postSid = String(c.post?.social_id || c.post_id || c.parent_post_id || '');
      const cid     = String(c.id || c.comment_id || '');
      const likeKey = `comment:${cid}`;
      if (postSid && cid && !alreadyLiked.has(likeKey)) {
        items.push({ type: 'comment', social_id: postSid, comment_id: cid, likeKey });
      }
    }
  }

  if (!items.length) {
    console.log(`[EngagementScraper] ${contact.first_name} ${contact.last_name}: no new items to like`);
    return { postLikes: 0, commentLikes: 0 };
  }

  let postLikes = 0, commentLikes = 0, sent = 0;
  const asOrgId = companyPageUrn?.match(/(\d+)$/)?.[1] || null;
  const newLikedIds = [];

  for (const item of items) {
    if (sent >= MAX_LIKES) break;

    const useCompany  = (item.type === 'post'    && flags.doCompanyLikePosts) ||
                        (item.type === 'comment'  && flags.doCompanyLikeComments);
    const usePersonal = (item.type === 'post'    && flags.doLikePosts) ||
                        (item.type === 'comment'  && flags.doLikeComments);
    if (!useCompany && !usePersonal) continue;

    try {
      await unipile.likePost(
        accountId,
        item.social_id,
        item.type === 'comment' ? item.comment_id : undefined,
        (useCompany && asOrgId) ? asOrgId : undefined
      );

      if (item.type === 'post')    { postLikes++;    newLikedIds.push(item.social_id); }
      if (item.type === 'comment') { commentLikes++; newLikedIds.push(item.likeKey); }
      sent++;

      console.log(
        `[EngagementScraper] 👍 Liked ${item.type} for ${contact.first_name} ${contact.last_name}` +
        (useCompany ? ' (company)' : '')
      );

      // Random delay between individual likes: 5-15s
      if (sent < MAX_LIKES) await sleep(rand(5000, 15000));
    } catch (err) {
      console.error(`[EngagementScraper] ✗ like failed contact ${contact.id}: ${err.message}`);
    }
  }

  // Save results to DB
  if (postLikes > 0 || commentLikes > 0) {
    // Merge new liked IDs with existing ones
    const mergedIds = [...alreadyLiked, ...newLikedIds];
    await db.query(
      `UPDATE contacts
       SET post_likes_sent    = COALESCE(post_likes_sent, 0)    + $1,
           comment_likes_sent = COALESCE(comment_likes_sent, 0) + $2,
           likes_sent_at      = NOW(),
           liked_ids          = $3::jsonb
       WHERE id = $4`,
      [postLikes, commentLikes, JSON.stringify(mergedIds), contact.id]
    );
  }

  return { postLikes, commentLikes };
}

// ── Re-classify from existing data (no API calls) ─────────────────────────────
async function reclassifyFromExistingData(campaignId) {
  const { rows } = await db.query(
    `SELECT id, first_name, last_name, engagement_data
     FROM contacts
     WHERE campaign_id = $1
       AND engagement_data IS NOT NULL
       AND engagement_level IS NOT NULL`,
    [campaignId]
  );

  console.log(`[Reclassify] ${rows.length} contacts for campaign ${campaignId}`);
  let updated = 0;

  for (const row of rows) {
    const d = typeof row.engagement_data === 'string'
      ? JSON.parse(row.engagement_data) : row.engagement_data;
    const nep = d.non_employer_posts_14d    || 0;
    const nec = d.non_employer_comments_14d || 0;
    const newLevel = classifyEngagement(nep, nec);
    const oldLevel = d.engagement_level;
    d.engagement_level = newLevel;

    await db.query(
      'UPDATE contacts SET engagement_level = $1, engagement_data = $2 WHERE id = $3',
      [newLevel, JSON.stringify(d), row.id]
    );
    if (newLevel !== oldLevel)
      console.log(`[Reclassify] ${row.first_name} ${row.last_name}: ${oldLevel} → ${newLevel}`);
    updated++;
  }

  return { reclassified: updated };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * OR-based:
 *   engaged         = ≥2 posts OR ≥2 comments
 *   average_engaged = ≥1 post  OR ≥1 comment
 *   un_engaged      = 0 posts AND 0 comments
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
    const ph = (item.post?.author?.headline || item.parent_post?.author?.headline || '').toLowerCase();
    const pc = (item.post?.author?.company  || item.parent_post?.author?.company  || '').toLowerCase();
    if (pc && pc.includes(company)) return true;
    if (ph && ph.includes(company)) return true;
  }
  return false;
}

module.exports = { start, run, scrapeContact, reclassifyFromExistingData };

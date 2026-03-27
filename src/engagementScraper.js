/**
 * Engagement Scraper + Like Sender
 *
 * Flow per campaign:
 *   1. Find contacts with provider_id, not yet classified
 *   2. Fetch posts + comments from last 14 days
 *   3. Classify: un_engaged / average_engaged / engaged
 *   4. If contact has content (avg or engaged): like up to 3 items (posts or comments)
 *   5. Save engagement_data (full JSONB) + like counters to DB
 *   6. Stop when 20 contacts are classified
 *
 * Engagement levels:
 *   un_engaged       — no qualifying posts/comments in 14 days
 *   average_engaged  — ≥1 non-employer post AND ≥1 non-employer comment
 *   engaged          — ≥2 non-employer posts AND ≥2 non-employer comments
 *
 * Like logic:
 *   - Pool = nonEmployerPosts + nonEmployerComments (combined, up to 3 total)
 *   - Prioritize posts first, then comments
 *   - Respects campaign.settings.engagement: like_posts, like_comments,
 *     company_like_posts, company_like_comments
 *   - un_engaged contacts are NOT liked (no content to like)
 */

const db      = require('./db');
const unipile = require('./unipile');

const DAYS_14           = 14 * 24 * 60 * 60 * 1000;
const TARGET_CLASSIFIED = 20;
const MAX_LIKES_PER_CONTACT = 3;
const DELAY_BETWEEN_CONTACTS_MS = 4000;
const DELAY_BETWEEN_LIKES_MS    = 2000;

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
  console.log(`[EngagementScraper] Next run in ${Math.round(msUntil / 3600000)}h`);
  setTimeout(() => { run(); setInterval(run, 24 * 60 * 60 * 1000); }, msUntil);
}

/** Main entry point — callable manually via POST /api/campaigns/:id/scrape-engagement */
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

  const eng    = campaign.settings?.engagement || {};
  const likePosts          = !!(eng.like_posts);
  const likeComments       = !!(eng.like_comments);
  const companyLikePosts   = !!(eng.company_like_posts);
  const companyLikeComments = !!(eng.company_like_comments);
  const companyPageUrn     = campaign.settings?.company_page_urn || null;

  // Read company_page_urn from account settings if not in campaign settings
  let companyOrgId = null;
  if (companyLikePosts || companyLikeComments) {
    try {
      const { rows: accRows } = await db.query(
        'SELECT settings FROM unipile_accounts WHERE account_id = $1',
        [campaign.account_id]
      );
      const urn = accRows[0]?.settings?.company_page_urn || '';
      const match = urn.match(/(\d+)$/);
      if (match) companyOrgId = match[1];
    } catch (_) {}
  }

  // Count already classified
  const { rows: done } = await db.query(
    'SELECT COUNT(*) AS cnt FROM contacts WHERE campaign_id = $1 AND engagement_level IS NOT NULL',
    [campaign.id]
  );
  const alreadyClassified = parseInt(done[0].cnt, 10);

  if (alreadyClassified >= TARGET_CLASSIFIED) {
    console.log(`[EngagementScraper] Campaign ${campaign.id}: already ${alreadyClassified} classified, skipping`);
    return { skipped: true, already_classified: alreadyClassified };
  }

  const remaining = TARGET_CLASSIFIED - alreadyClassified;
  console.log(`[EngagementScraper] Campaign ${campaign.id}: need ${remaining} more`);

  const { rows: contacts } = await db.query(
    `SELECT id, first_name, last_name, company, provider_id, member_urn, li_profile_url
     FROM contacts
     WHERE campaign_id = $1
       AND provider_id IS NOT NULL AND provider_id != ''
       AND engagement_level IS NULL
     ORDER BY RANDOM()
     LIMIT 30`,
    [campaign.id]
  );

  if (!contacts.length) {
    console.log(`[EngagementScraper] Campaign ${campaign.id}: no unscraped enriched contacts`);
    return { contacts_scraped: 0 };
  }

  let scraped = 0, classified = 0;

  for (const contact of contacts) {
    if (classified >= remaining) break;

    try {
      const result = await scrapeAndLikeContact(contact, campaign.account_id, {
        likePosts, likeComments, companyLikePosts, companyLikeComments, companyOrgId,
      });
      if (result) {
        scraped++;
        classified++;
        console.log(
          `[EngagementScraper] ✓ ${contact.first_name} ${contact.last_name}` +
          ` → ${result.engagement_level}` +
          ` | post_likes=${result.post_likes_sent} comment_likes=${result.comment_likes_sent}`
        );
      }
    } catch (err) {
      console.error(`[EngagementScraper] ✗ contact ${contact.id}: ${err.message}`);
    }

    if (scraped < contacts.length) await sleep(DELAY_BETWEEN_CONTACTS_MS);
  }

  return { contacts_scraped: scraped, contacts_classified: classified };
}

/**
 * Scrape + classify + like a single contact.
 */
async function scrapeAndLikeContact(contact, accountId, likeConfig) {
  const cutoff = new Date(Date.now() - DAYS_14);
  const contactCompany = (contact.company || '').toLowerCase().trim();

  // ── 1. Fetch posts & comments ──────────────────────────────────────────────
  let rawPosts = [];
  try { rawPosts = await unipile.getUserPosts(accountId, contact.provider_id, 100); }
  catch (err) { console.warn(`[EngagementScraper] posts fetch failed for ${contact.provider_id}: ${err.message}`); }

  let rawComments = [];
  try { rawComments = await unipile.getUserComments(accountId, contact.provider_id, 100); }
  catch (err) { console.warn(`[EngagementScraper] comments fetch failed for ${contact.provider_id}: ${err.message}`); }

  // ── 2. Filter to 14 days & classify ──────────────────────────────────────
  const posts14d        = rawPosts.filter(p => isWithin14Days(p, cutoff));
  const comments14d     = rawComments.filter(c => isWithin14Days(c, cutoff));
  const nonEmpPosts     = posts14d.filter(p => !isEmployerRelated(p, contactCompany, 'post'));
  const nonEmpComments  = comments14d.filter(c => !isEmployerRelated(c, contactCompany, 'comment'));
  const level           = classifyEngagement(nonEmpPosts.length, nonEmpComments.length);

  // ── 3. Like up to 3 items (only if content exists) ──────────────────────────
  let postLikesSent    = 0;
  let commentLikesSent = 0;

  if (level !== 'un_engaged') {
    const likeResults = await sendLikes(contact, accountId, nonEmpPosts, nonEmpComments, likeConfig);
    postLikesSent    = likeResults.postLikesSent;
    commentLikesSent = likeResults.commentLikesSent;
  }

  // ── 4. Save to DB ──────────────────────────────────────────────────────────
  const engagementData = {
    scraped_at:                      new Date().toISOString(),
    posts_total:                     rawPosts.length,
    comments_total:                  rawComments.length,
    posts_14d:                       posts14d.length,
    comments_14d:                    comments14d.length,
    non_employer_posts_14d:          nonEmpPosts.length,
    non_employer_comments_14d:       nonEmpComments.length,
    engagement_level:                level,
    contact_company:                 contact.company || '',
    post_likes_sent:                 postLikesSent,
    comment_likes_sent:              commentLikesSent,
    // Full raw data
    posts:                           rawPosts,
    comments:                        rawComments,
    posts_14d_data:                  posts14d,
    comments_14d_data:               comments14d,
    non_employer_posts_14d_data:     nonEmpPosts,
    non_employer_comments_14d_data:  nonEmpComments,
  };

  await db.query(
    `UPDATE contacts
     SET engagement_level      = $1,
         engagement_scraped_at = NOW(),
         engagement_data       = $2,
         post_likes_sent       = COALESCE(post_likes_sent, 0) + $3,
         comment_likes_sent    = COALESCE(comment_likes_sent, 0) + $4
     WHERE id = $5`,
    [level, JSON.stringify(engagementData), postLikesSent, commentLikesSent, contact.id]
  );

  return { engagement_level: level, post_likes_sent: postLikesSent, comment_likes_sent: commentLikesSent };
}

/**
 * Send up to MAX_LIKES_PER_CONTACT likes to a contact's posts and/or comments.
 * Returns { postLikesSent, commentLikesSent }.
 */
async function sendLikes(contact, accountId, nonEmpPosts, nonEmpComments, likeConfig) {
  const { likePosts, likeComments, companyLikePosts, companyLikeComments, companyOrgId } = likeConfig;
  let postLikesSent = 0;
  let commentLikesSent = 0;
  let totalSent = 0;

  // Build like candidates
  // Each item: { type: 'post'|'comment', postSocialId, commentId }
  const candidates = [];

  // Posts first
  if (likePosts || companyLikePosts) {
    for (const post of nonEmpPosts) {
      const socialId = post.social_id || post.id || post.post_id;
      if (socialId) candidates.push({ type: 'post', postSocialId: socialId, commentId: null });
    }
  }

  // Comments second
  if (likeComments || companyLikeComments) {
    for (const comment of nonEmpComments) {
      const commentId   = comment.id || comment.comment_id;
      const postSocialId = comment.post?.social_id || comment.parent_post_id ||
                           comment.post_social_id  || comment.social_id;
      if (commentId && postSocialId) {
        candidates.push({ type: 'comment', postSocialId, commentId });
      }
    }
  }

  if (!candidates.length) {
    console.log(`[EngagementScraper] No likeable items for contact ${contact.id}`);
    return { postLikesSent: 0, commentLikesSent: 0 };
  }

  // Pick up to 3
  const tolike = candidates.slice(0, MAX_LIKES_PER_CONTACT);

  for (const item of tolike) {
    if (totalSent >= MAX_LIKES_PER_CONTACT) break;

    try {
      // Personal like
      if (item.type === 'post' && likePosts) {
        await unipile.likePost(accountId, item.postSocialId, null, null, 'like');
        postLikesSent++;
        totalSent++;
        console.log(`[EngagementScraper] 👍 Post liked for contact ${contact.id}: ${item.postSocialId}`);
      } else if (item.type === 'comment' && likeComments) {
        await unipile.likePost(accountId, item.postSocialId, item.commentId, null, 'like');
        commentLikesSent++;
        totalSent++;
        console.log(`[EngagementScraper] 👍 Comment liked for contact ${contact.id}: ${item.commentId}`);
      }

      // Company page like (if enabled and we have org ID)
      if (companyOrgId && totalSent < MAX_LIKES_PER_CONTACT) {
        if (item.type === 'post' && companyLikePosts) {
          await unipile.likePost(accountId, item.postSocialId, null, companyOrgId, 'like');
          postLikesSent++;
          totalSent++;
          console.log(`[EngagementScraper] 🏢 Post liked (company) for contact ${contact.id}`);
        } else if (item.type === 'comment' && companyLikeComments) {
          await unipile.likePost(accountId, item.postSocialId, item.commentId, companyOrgId, 'like');
          commentLikesSent++;
          totalSent++;
          console.log(`[EngagementScraper] 🏢 Comment liked (company) for contact ${contact.id}`);
        }
      }

      await sleep(DELAY_BETWEEN_LIKES_MS);
    } catch (err) {
      console.error(`[EngagementScraper] Like failed for contact ${contact.id}: ${err.message}`);
    }
  }

  return { postLikesSent, commentLikesSent };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function classifyEngagement(nonEmpPosts, nonEmpComments) {
  if (nonEmpPosts >= 2 && nonEmpComments >= 2) return 'engaged';
  if (nonEmpPosts >= 1 && nonEmpComments >= 1) return 'average_engaged';
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
    const hl = (item.author?.headline || item.author_headline || '').toLowerCase();
    const co = (item.author?.company  || item.author_company  || '').toLowerCase();
    if (co && co.includes(company))  return true;
    if (hl && hl.includes(company))  return true;
    const rs = (item.reshared?.author?.name || item.reshared_from || '').toLowerCase();
    if (rs && rs.includes(company))  return true;
  }
  if (type === 'comment') {
    if (item.post?.as_organization || item.parent_post?.as_organization) return true;
    const phl = (item.post?.author?.headline || item.parent_post?.author?.headline || item.post_author_headline || '').toLowerCase();
    const pco = (item.post?.author?.company  || item.parent_post?.author?.company  || item.post_author_company  || '').toLowerCase();
    if (pco && pco.includes(company)) return true;
    if (phl && phl.includes(company)) return true;
  }
  return false;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { start, run };

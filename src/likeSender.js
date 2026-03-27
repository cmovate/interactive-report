/**
 * Like Sender
 *
 * Triggered automatically after engagement scraping finds 20 classified contacts
 * in a campaign. Sends up to 3 likes per contact (posts or comments, whichever
 * are available — no preference between the two).
 *
 * Rules:
 *   - Only contacts with engagement_level != 'un_engaged' get likes
 *     (un_engaged = no content in last 14 days, nothing to like)
 *   - Up to MAX_LIKES_PER_CONTACT total likes per contact
 *   - Uses engagement_data JSONB to find post/comment IDs scraped earlier
 *   - Tracks per-contact: likes_sent_posts, likes_sent_comments
 *   - Respects campaign settings: like_posts, like_comments,
 *     company_like_posts, company_like_comments
 *   - as_organization = company page URN from account settings (if enabled)
 *   - 10-30s random delay between individual likes to avoid rate limits
 *
 * Called by: engagementScraper.js after it reaches 20 classified contacts
 * Also callable via POST /api/campaigns/:id/send-likes
 */

const db      = require('./db');
const unipile = require('./unipile');

const MAX_LIKES_PER_CONTACT = 3;
const DELAY_MIN_MS = 10000;
const DELAY_MAX_MS = 30000;

let isRunning = false;

/**
 * Main entry point.
 * @param {number} campaignId
 * @param {object} [options]
 * @param {boolean} [options.force] - Re-like even if already liked
 */
async function run(campaignId, options = {}) {
  if (isRunning) {
    console.log('[LikeSender] Already running, skipping');
    return { skipped: true };
  }
  isRunning = true;
  console.log(`[LikeSender] Starting for campaign ${campaignId}...`);

  try {
    // Load campaign settings
    const { rows: campRows } = await db.query(
      'SELECT id, account_id, settings FROM campaigns WHERE id = $1',
      [campaignId]
    );
    if (!campRows.length) return { error: 'Campaign not found' };
    const campaign  = campRows[0];
    const settings  = campaign.settings || {};
    const engagement = settings.engagement || {};

    const doLikePosts          = !!engagement.like_posts;
    const doLikeComments       = !!engagement.like_comments;
    const doCompanyLikePosts   = !!engagement.company_like_posts;
    const doCompanyLikeComments= !!engagement.company_like_comments;

    if (!doLikePosts && !doLikeComments && !doCompanyLikePosts && !doCompanyLikeComments) {
      console.log('[LikeSender] No like actions enabled in campaign settings');
      return { skipped: true, reason: 'no_like_actions_enabled' };
    }

    // Get company page URN if needed
    let companyPageUrn = null;
    if (doCompanyLikePosts || doCompanyLikeComments) {
      const { rows: accRows } = await db.query(
        'SELECT settings FROM unipile_accounts WHERE account_id = $1',
        [campaign.account_id]
      );
      companyPageUrn = accRows[0]?.settings?.company_page_urn || null;
      if (!companyPageUrn) {
        console.warn('[LikeSender] company_like enabled but no company_page_urn in account settings');
      }
    }

    // Get contacts that:
    //   - are classified (engagement_level != null)
    //   - have content (not un_engaged)
    //   - have not been fully liked yet (or force=true)
    const likedFilter = options.force ? '' : `AND (likes_sent_posts + likes_sent_comments) < ${MAX_LIKES_PER_CONTACT}`;
    const { rows: contacts } = await db.query(
      `SELECT id, first_name, last_name, provider_id, engagement_level,
              engagement_data, likes_sent_posts, likes_sent_comments
       FROM contacts
       WHERE campaign_id = $1
         AND engagement_level IS NOT NULL
         AND engagement_level != 'un_engaged'
         AND provider_id IS NOT NULL
         ${likedFilter}
       ORDER BY
         CASE engagement_level WHEN 'engaged' THEN 0 WHEN 'average_engaged' THEN 1 ELSE 2 END,
         id ASC
       LIMIT 20`,
      [campaignId]
    );

    if (!contacts.length) {
      console.log('[LikeSender] No eligible contacts to like');
      return { liked_contacts: 0 };
    }

    console.log(`[LikeSender] ${contacts.length} contacts to process`);

    let totalPostLikes    = 0;
    let totalCommentLikes = 0;
    let processedContacts = 0;

    for (const contact of contacts) {
      const result = await likeContact(
        contact, campaign.account_id, companyPageUrn,
        { doLikePosts, doLikeComments, doCompanyLikePosts, doCompanyLikeComments }
      );
      totalPostLikes    += result.postLikes;
      totalCommentLikes += result.commentLikes;
      if (result.postLikes + result.commentLikes > 0) processedContacts++;

      // Delay between contacts
      await sleep(DELAY_MIN_MS + Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS));
    }

    const summary = {
      contacts_processed: processedContacts,
      total_post_likes:    totalPostLikes,
      total_comment_likes: totalCommentLikes,
    };
    console.log('[LikeSender] Done:', JSON.stringify(summary));
    return summary;

  } catch (err) {
    console.error('[LikeSender] Error:', err.message);
    return { error: err.message };
  } finally {
    isRunning = false;
  }
}

/**
 * Like up to MAX_LIKES_PER_CONTACT items for a single contact.
 * Mixes posts and comments — takes whichever are available first.
 */
async function likeContact(contact, accountId, companyPageUrn, flags) {
  const engData = contact.engagement_data || {};
  const alreadyLiked = (contact.likes_sent_posts || 0) + (contact.likes_sent_comments || 0);
  const remaining   = MAX_LIKES_PER_CONTACT - alreadyLiked;

  if (remaining <= 0) return { postLikes: 0, commentLikes: 0 };

  // Build a flat list of likeable items from scraped data
  // Format: { type: 'post'|'comment', social_id, comment_id? }
  const items = [];

  // Posts (from non_employer_posts_14d_data or posts_14d_data)
  if (flags.doLikePosts || flags.doCompanyLikePosts) {
    const posts = engData.non_employer_posts_14d_data || engData.posts_14d_data || [];
    for (const p of posts) {
      const socialId = p.social_id || p.id || p.post_id;
      if (socialId) items.push({ type: 'post', social_id: socialId });
    }
  }

  // Comments (from non_employer_comments_14d_data or comments_14d_data)
  if (flags.doLikeComments || flags.doCompanyLikeComments) {
    const comments = engData.non_employer_comments_14d_data || engData.comments_14d_data || [];
    for (const c of comments) {
      // Comments need the parent post's social_id + the comment's own id
      const postSocialId = c.post?.social_id || c.post_id || c.parent_post_id;
      const commentId    = c.id || c.comment_id;
      if (postSocialId && commentId) {
        items.push({ type: 'comment', social_id: postSocialId, comment_id: commentId });
      }
    }
  }

  if (!items.length) {
    console.log(`[LikeSender] ${contact.first_name} ${contact.last_name}: no likeable items in scraped data`);
    return { postLikes: 0, commentLikes: 0 };
  }

  let postLikes    = 0;
  let commentLikes = 0;
  let sent         = 0;

  for (const item of items) {
    if (sent >= remaining) break;

    try {
      const isPersonalPost    = item.type === 'post'    && flags.doLikePosts;
      const isPersonalComment = item.type === 'comment' && flags.doLikeComments;
      const isCompanyPost     = item.type === 'post'    && flags.doCompanyLikePosts    && companyPageUrn;
      const isCompanyComment  = item.type === 'comment' && flags.doCompanyLikeComments && companyPageUrn;

      if (!isPersonalPost && !isPersonalComment && !isCompanyPost && !isCompanyComment) continue;

      // Determine as_organization (company page ID) if liking as company
      const asOrg = (isCompanyPost || isCompanyComment)
        ? (companyPageUrn.match(/(\d+)$/)?.[1] || null)
        : null;

      await unipile.likePost(
        accountId,
        item.social_id,
        item.type === 'comment' ? item.comment_id : undefined,
        asOrg || undefined
      );

      if (item.type === 'post')    postLikes++;
      if (item.type === 'comment') commentLikes++;
      sent++;

      console.log(
        `[LikeSender] ✓ Liked ${item.type} for ${contact.first_name} ${contact.last_name}` +
        (asOrg ? ' (as company)' : '')
      );

      // Short delay between likes for same contact
      if (sent < remaining && sent < items.length) {
        await sleep(3000 + Math.random() * 5000);
      }

    } catch (err) {
      console.error(
        `[LikeSender] ✗ Failed ${item.type} for contact ${contact.id}: ${err.message}`
      );
    }
  }

  // Save to DB
  if (postLikes > 0 || commentLikes > 0) {
    await db.query(
      `UPDATE contacts
       SET likes_sent_posts    = COALESCE(likes_sent_posts, 0)    + $1,
           likes_sent_comments = COALESCE(likes_sent_comments, 0) + $2,
           likes_sent_at       = NOW()
       WHERE id = $3`,
      [postLikes, commentLikes, contact.id]
    );
  }

  return { postLikes, commentLikes };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { run };

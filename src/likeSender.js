/**
 * Like Sender
 *
 * Triggered after engagement scraping finds 20 classified contacts.
 * Sends up to 3 likes per contact (posts or comments, whichever available).
 *
 * Rules:
 *   - Only contacts with engagement_level != 'un_engaged' get likes
 *   - Up to MAX_LIKES_PER_CONTACT total per contact
 *   - Uses engagement_data JSONB to find post/comment IDs from scraping
 *   - Tracks per-contact: post_likes_sent, comment_likes_sent
 *   - 10-30s delay between individual likes
 */

const db      = require('./db');
const unipile = require('./unipile');

const MAX_LIKES_PER_CONTACT = 3;
const DELAY_MIN_MS = 10000;
const DELAY_MAX_MS = 30000;

let isRunning = false;

async function run(campaignId, options = {}) {
  if (isRunning) { console.log('[LikeSender] Already running, skipping'); return { skipped: true }; }
  isRunning = true;
  console.log(`[LikeSender] Starting for campaign ${campaignId}...`);

  try {
    const { rows: campRows } = await db.query(
      'SELECT id, account_id, settings FROM campaigns WHERE id = $1', [campaignId]
    );
    if (!campRows.length) return { error: 'Campaign not found' };

    const campaign  = campRows[0];
    const eng       = campaign.settings?.engagement || {};
    const doLikePosts           = !!eng.like_posts;
    const doLikeComments        = !!eng.like_comments;
    const doCompanyLikePosts    = !!eng.company_like_posts;
    const doCompanyLikeComments = !!eng.company_like_comments;

    if (!doLikePosts && !doLikeComments && !doCompanyLikePosts && !doCompanyLikeComments) {
      return { skipped: true, reason: 'no_like_actions_enabled' };
    }

    let companyPageUrn = null;
    if (doCompanyLikePosts || doCompanyLikeComments) {
      const { rows: accRows } = await db.query(
        'SELECT settings FROM unipile_accounts WHERE account_id = $1', [campaign.account_id]
      );
      companyPageUrn = accRows[0]?.settings?.company_page_urn || null;
    }

    // Get eligible contacts: classified, not un_engaged, not yet fully liked
    const likedFilter = options.force
      ? ''
      : `AND (COALESCE(post_likes_sent,0) + COALESCE(comment_likes_sent,0)) < ${MAX_LIKES_PER_CONTACT}`;

    const { rows: contacts } = await db.query(
      `SELECT id, first_name, last_name, provider_id, engagement_level,
              engagement_data, post_likes_sent, comment_likes_sent
       FROM contacts
       WHERE campaign_id = $1
         AND engagement_level IS NOT NULL
         AND engagement_level != 'un_engaged'
         AND provider_id IS NOT NULL
         ${likedFilter}
       ORDER BY CASE engagement_level WHEN 'engaged' THEN 0 WHEN 'average_engaged' THEN 1 ELSE 2 END, id ASC
       LIMIT 20`,
      [campaignId]
    );

    if (!contacts.length) { console.log('[LikeSender] No eligible contacts'); return { liked_contacts: 0 }; }

    console.log(`[LikeSender] Processing ${contacts.length} contacts`);

    let totalPostLikes = 0, totalCommentLikes = 0, processedContacts = 0;

    for (const contact of contacts) {
      const result = await likeContact(
        contact, campaign.account_id, companyPageUrn,
        { doLikePosts, doLikeComments, doCompanyLikePosts, doCompanyLikeComments }
      );
      totalPostLikes    += result.postLikes;
      totalCommentLikes += result.commentLikes;
      if (result.postLikes + result.commentLikes > 0) processedContacts++;
      await sleep(DELAY_MIN_MS + Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS));
    }

    const summary = { contacts_processed: processedContacts, total_post_likes: totalPostLikes, total_comment_likes: totalCommentLikes };
    console.log('[LikeSender] Done:', JSON.stringify(summary));
    return summary;

  } catch (err) {
    console.error('[LikeSender] Error:', err.message);
    return { error: err.message };
  } finally {
    isRunning = false;
  }
}

async function likeContact(contact, accountId, companyPageUrn, flags) {
  const engData      = contact.engagement_data || {};
  const alreadyLiked = (contact.post_likes_sent || 0) + (contact.comment_likes_sent || 0);
  const remaining    = MAX_LIKES_PER_CONTACT - alreadyLiked;
  if (remaining <= 0) return { postLikes: 0, commentLikes: 0 };

  // Build flat list of likeable items
  const items = [];

  if (flags.doLikePosts || flags.doCompanyLikePosts) {
    const posts = engData.non_employer_posts_14d_data || engData.posts_14d_data || [];
    for (const p of posts) {
      const socialId = p.social_id || p.id || p.post_id;
      if (socialId) items.push({ type: 'post', social_id: String(socialId) });
    }
  }

  if (flags.doLikeComments || flags.doCompanyLikeComments) {
    const comments = engData.non_employer_comments_14d_data || engData.comments_14d_data || [];
    for (const c of comments) {
      const postSocialId = c.post?.social_id || c.post_id || c.parent_post_id;
      const commentId    = c.id || c.comment_id;
      if (postSocialId && commentId) {
        items.push({ type: 'comment', social_id: String(postSocialId), comment_id: String(commentId) });
      }
    }
  }

  if (!items.length) {
    console.log(`[LikeSender] ${contact.first_name} ${contact.last_name}: no likeable items in scraped data`);
    return { postLikes: 0, commentLikes: 0 };
  }

  let postLikes = 0, commentLikes = 0, sent = 0;

  for (const item of items) {
    if (sent >= remaining) break;

    const isPersonalPost    = item.type === 'post'    && flags.doLikePosts;
    const isPersonalComment = item.type === 'comment' && flags.doLikeComments;
    const isCompanyPost     = item.type === 'post'    && flags.doCompanyLikePosts    && companyPageUrn;
    const isCompanyComment  = item.type === 'comment' && flags.doCompanyLikeComments && companyPageUrn;

    if (!isPersonalPost && !isPersonalComment && !isCompanyPost && !isCompanyComment) continue;

    try {
      const asOrg = (isCompanyPost || isCompanyComment)
        ? (companyPageUrn?.match(/(\d+)$/)?.[1] || null)
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

      console.log(`[LikeSender] \u2713 Liked ${item.type} for ${contact.first_name} ${contact.last_name}${asOrg ? ' (company)' : ''}`);

      if (sent < remaining) await sleep(3000 + Math.random() * 5000);
    } catch (err) {
      console.error(`[LikeSender] \u2717 ${item.type} contact ${contact.id}: ${err.message}`);
    }
  }

  if (postLikes > 0 || commentLikes > 0) {
    await db.query(
      `UPDATE contacts
       SET post_likes_sent    = COALESCE(post_likes_sent, 0)    + $1,
           comment_likes_sent = COALESCE(comment_likes_sent, 0) + $2
       WHERE id = $3`,
      [postLikes, commentLikes, contact.id]
    );
  }

  return { postLikes, commentLikes };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { run };

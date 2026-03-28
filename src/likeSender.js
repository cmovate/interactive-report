/**
 * Like Sender
 *
 * Sends up to 3 likes per contact (posts or comments).
 *
 * Rules:
 *   - Only contacts with engagement_level != 'un_engaged'
 *   - Skip contacts liked in last 3 days (likes_sent_at cooldown)
 *   - Never like the same post/comment twice (tracked in liked_ids JSONB)
 *   - Up to 3 total new likes per contact per run
 *   - Random delays: 10-30s between contacts, 5-15s between individual likes
 */

const db      = require('./db');
const unipile = require('./unipile');

const MAX_LIKES    = 3;
const COOLDOWN_MS  = 3 * 24 * 60 * 60 * 1000; // 3 days
const rand  = (min, max) => min + Math.random() * (max - min);
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

    const campaign = campRows[0];
    const eng      = campaign.settings?.engagement || {};
    const flags = {
      doLikePosts:           !!eng.like_posts,
      doLikeComments:        !!eng.like_comments,
      doCompanyLikePosts:    !!eng.company_like_posts,
      doCompanyLikeComments: !!eng.company_like_comments,
    };

    if (!Object.values(flags).some(Boolean)) {
      return { skipped: true, reason: 'no_like_actions_enabled' };
    }

    let companyPageUrn = null;
    if (flags.doCompanyLikePosts || flags.doCompanyLikeComments) {
      const { rows: accRows } = await db.query(
        'SELECT settings FROM unipile_accounts WHERE account_id = $1', [campaign.account_id]
      );
      companyPageUrn = accRows[0]?.settings?.company_page_urn || null;
    }

    // 3-day cooldown cutoff
    const cooldownCutoff = new Date(Date.now() - COOLDOWN_MS).toISOString();

    // Get eligible contacts — fetch engagement_data + liked_ids from DB
    const likedFilter = options.force
      ? ''
      : `AND (COALESCE(post_likes_sent,0) + COALESCE(comment_likes_sent,0)) < ${MAX_LIKES}`;

    const { rows: contacts } = await db.query(
      `SELECT id, first_name, last_name, provider_id, engagement_level,
              engagement_data, post_likes_sent, comment_likes_sent,
              liked_ids, likes_sent_at
       FROM contacts
       WHERE campaign_id = $1
         AND engagement_level IS NOT NULL
         AND engagement_level != 'un_engaged'
         AND provider_id IS NOT NULL
         AND (likes_sent_at IS NULL OR likes_sent_at < $2)
         ${likedFilter}
       ORDER BY CASE engagement_level WHEN 'engaged' THEN 0 WHEN 'average_engaged' THEN 1 ELSE 2 END, id ASC
       LIMIT 20`,
      [campaignId, cooldownCutoff]
    );

    if (!contacts.length) {
      console.log('[LikeSender] No eligible contacts (all on cooldown or fully liked)');
      return { liked_contacts: 0 };
    }

    console.log(`[LikeSender] Processing ${contacts.length} contacts`);

    let totalPostLikes = 0, totalCommentLikes = 0, processedContacts = 0;

    for (const contact of contacts) {
      const result = await likeContact(contact, campaign.account_id, companyPageUrn, flags);
      totalPostLikes    += result.postLikes;
      totalCommentLikes += result.commentLikes;
      if (result.postLikes + result.commentLikes > 0) processedContacts++;

      // Random delay between contacts: 10-30s
      if (processedContacts < contacts.length) {
        await sleep(rand(10000, 30000));
      }
    }

    const summary = {
      contacts_processed:   processedContacts,
      total_post_likes:     totalPostLikes,
      total_comment_likes:  totalCommentLikes,
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

async function likeContact(contact, accountId, companyPageUrn, flags) {
  const engData = contact.engagement_data || {};

  // Already-liked IDs (deduplication)
  const alreadyLiked = new Set(
    Array.isArray(contact.liked_ids) ? contact.liked_ids : []
  );

  // How many more can we send?
  const alreadySent = (contact.post_likes_sent || 0) + (contact.comment_likes_sent || 0);
  const remaining   = MAX_LIKES - alreadySent;
  if (remaining <= 0) return { postLikes: 0, commentLikes: 0 };

  // Build list of new, not-yet-liked items
  const items = [];

  if (flags.doLikePosts || flags.doCompanyLikePosts) {
    const posts = engData.non_employer_posts_14d_data || engData.posts_14d_data || [];
    for (const p of posts) {
      const sid = String(p.social_id || p.id || p.post_id || '');
      if (sid && !alreadyLiked.has(sid)) {
        items.push({ type: 'post', social_id: sid, key: sid });
      }
    }
  }

  if (flags.doLikeComments || flags.doCompanyLikeComments) {
    const comments = engData.non_employer_comments_14d_data || engData.comments_14d_data || [];
    for (const c of comments) {
      const postSid = String(c.post?.social_id || c.post_id || c.parent_post_id || '');
      const cid     = String(c.id || c.comment_id || '');
      const key     = `comment:${cid}`;
      if (postSid && cid && !alreadyLiked.has(key)) {
        items.push({ type: 'comment', social_id: postSid, comment_id: cid, key });
      }
    }
  }

  if (!items.length) {
    console.log(`[LikeSender] ${contact.first_name} ${contact.last_name}: no new items to like`);
    return { postLikes: 0, commentLikes: 0 };
  }

  let postLikes = 0, commentLikes = 0, sent = 0;
  const asOrgId = companyPageUrn?.match(/(\d+)$/)?.[1] || null;
  const newLikedKeys = [];

  for (const item of items) {
    if (sent >= remaining) break;

    const usePersonal = (item.type === 'post' && flags.doLikePosts) ||
                        (item.type === 'comment' && flags.doLikeComments);
    const useCompany  = (item.type === 'post' && flags.doCompanyLikePosts && asOrgId) ||
                        (item.type === 'comment' && flags.doCompanyLikeComments && asOrgId);
    if (!usePersonal && !useCompany) continue;

    try {
      await unipile.likePost(
        accountId,
        item.social_id,
        item.type === 'comment' ? item.comment_id : undefined,
        (useCompany && asOrgId) ? asOrgId : undefined
      );

      if (item.type === 'post')    postLikes++;
      if (item.type === 'comment') commentLikes++;
      newLikedKeys.push(item.key);
      sent++;

      console.log(
        `[LikeSender] 👍 ${item.type} → ${contact.first_name} ${contact.last_name}` +
        (useCompany ? ' (company)' : '')
      );

      // Random delay between individual likes: 5-15s
      if (sent < remaining && sent < items.length) {
        await sleep(rand(5000, 15000));
      }
    } catch (err) {
      console.error(`[LikeSender] ✗ ${item.type} contact ${contact.id}: ${err.message}`);
    }
  }

  // Persist to DB
  if (postLikes > 0 || commentLikes > 0) {
    const mergedIds = [...alreadyLiked, ...newLikedKeys];
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

module.exports = { run };

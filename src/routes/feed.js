const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { getUserPosts, getUserComments } = require('../unipile');

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractAvatar(obj) {
  return obj?.picture || obj?.avatar || obj?.profile_picture_url ||
         obj?.author?.picture || obj?.author?.avatar || null;
}

function normalisePost(item, contact) {
  const authorName = [
    item.author?.first_name || item.first_name || contact?.first_name || '',
    item.author?.last_name  || item.last_name  || contact?.last_name  || '',
  ].join(' ').trim() || item.author?.name || 'Unknown';
  return {
    post_urn:           item.id || item.social_id || item.urn || item.post_id || null,
    author_name:        authorName,
    author_title:       item.author?.headline || item.headline || contact?.title || null,
    author_profile_url: item.author?.public_identifier
                          ? 'https://www.linkedin.com/in/' + item.author.public_identifier
                          : (contact?.li_profile_url || null),
    author_avatar_url:  extractAvatar(item) || contact?.avatar_url || null,
    content:            item.text || item.commentary || item.content || null,
    likes_count:        item.likes_count || item.num_likes || item.reaction_count || 0,
    comments_count:     item.comments_count || item.num_comments || 0,
    shares_count:       item.shares_count || item.num_shares || 0,
    posted_at:          item.created_at || item.published_at || item.timestamp || null,
  };
}

function normaliseComment(item) {
  const authorName = [
    item.author?.first_name || item.first_name || '',
    item.author?.last_name  || item.last_name  || '',
  ].join(' ').trim() || item.author?.name || 'Unknown';
  return {
    comment_urn:        item.id || item.comment_id || item.urn || null,
    parent_comment_urn: item.parent_comment_id || item.parent_id || null,
    post_urn:           item.post_id || item.social_id || null,
    author_name:        authorName,
    author_title:       item.author?.headline || null,
    author_profile_url: item.author?.public_identifier
                          ? 'https://www.linkedin.com/in/' + item.author.public_identifier
                          : null,
    author_avatar_url:  extractAvatar(item),
    content:            item.text || item.commentary || item.content || null,
    likes_count:        item.likes_count || item.num_likes || 0,
    commented_at:       item.created_at || item.timestamp || null,
  };
}

// ── Background scrape ─────────────────────────────────────────────────────────
// Only fetches posts from the last 14 days

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

async function scrapeContactFeed(campaignId, workspaceId, accountId) {
  console.log('[Feed] Starting scrape for campaign ' + campaignId);
  const cutoff = new Date(Date.now() - FOURTEEN_DAYS_MS);

  const { rows: contacts } = await db.query(
    `SELECT id, provider_id, first_name, last_name, title, li_profile_url,
            profile_data->>'picture' AS avatar_url
     FROM contacts
     WHERE campaign_id = $1 AND workspace_id = $2
       AND provider_id IS NOT NULL AND provider_id != ''
     LIMIT 200`,
    [campaignId, workspaceId]
  );

  let postsUpserted = 0, commentsUpserted = 0;

  for (const contact of contacts) {
    try {
      const rawPosts = await getUserPosts(accountId, contact.provider_id, 20);

      for (const raw of rawPosts.slice(0, 20)) {
        const p = normalisePost(raw, contact);
        if (!p.post_urn) continue;

        // Skip posts older than 14 days
        if (p.posted_at) {
          const postDate = new Date(p.posted_at);
          if (!isNaN(postDate) && postDate < cutoff) continue;
        }

        const { rows: postRows } = await db.query(
          `INSERT INTO linkedin_posts
             (campaign_id, workspace_id, contact_id, post_urn,
              author_name, author_title, author_profile_url, author_avatar_url,
              content, likes_count, comments_count, shares_count, posted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (post_urn) DO UPDATE SET
             likes_count    = EXCLUDED.likes_count,
             comments_count = EXCLUDED.comments_count,
             shares_count   = EXCLUDED.shares_count,
             fetched_at     = NOW()
           RETURNING id`,
          [campaignId, workspaceId, contact.id, p.post_urn,
           p.author_name, p.author_title, p.author_profile_url, p.author_avatar_url,
           p.content, p.likes_count, p.comments_count, p.shares_count, p.posted_at]
        );
        postsUpserted++;
        const postDbId = postRows[0]?.id;
        if (!postDbId) continue;

        try {
          const rawComments = await getUserComments(accountId, p.post_urn, 10);
          for (const rc of rawComments.slice(0, 10)) {
            const c = normaliseComment(rc);
            if (!c.comment_urn) continue;

            // Resolve parent_comment_id
            let parentDbId = null;
            if (c.parent_comment_urn) {
              const { rows: par } = await db.query(
                'SELECT id FROM linkedin_comments WHERE comment_urn = $1 LIMIT 1',
                [c.parent_comment_urn]
              );
              parentDbId = par[0]?.id || null;
            }

            await db.query(
              `INSERT INTO linkedin_comments
                 (post_id, parent_comment_id, comment_urn,
                  author_name, author_title, author_profile_url, author_avatar_url,
                  content, likes_count, commented_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
               ON CONFLICT (comment_urn) DO UPDATE SET
                 likes_count = EXCLUDED.likes_count,
                 fetched_at  = NOW()`,
              [postDbId, parentDbId, c.comment_urn,
               c.author_name, c.author_title, c.author_profile_url, c.author_avatar_url,
               c.content, c.likes_count, c.commented_at]
            );
            commentsUpserted++;
          }
        } catch (ce) {
          console.warn('[Feed] Comments failed for post ' + p.post_urn + ': ' + ce.message);
        }
        await new Promise(r => setTimeout(r, 1200));
      }
    } catch (err) {
      console.warn('[Feed] Posts failed for contact ' + contact.id + ': ' + err.message);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('[Feed] Campaign ' + campaignId + ' done: ' + postsUpserted + ' posts, ' + commentsUpserted + ' comments');
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/feed?workspace_id=&campaign_id=&page=&limit=
 * Returns posts from the last 14 days with nested comments.
 */
router.get('/', async (req, res) => {
  try {
    const { workspace_id, campaign_id } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });

    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(50, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const cutoff = new Date(Date.now() - FOURTEEN_DAYS_MS).toISOString();

    const conditions = ['p.workspace_id = $1', "p.posted_at >= $2"];
    const params     = [workspace_id, cutoff];
    if (campaign_id) { conditions.push('p.campaign_id = $' + (params.length + 1)); params.push(campaign_id); }

    const where = conditions.join(' AND ');

    const { rows: totalRows } = await db.query(
      'SELECT COUNT(*) FROM linkedin_posts p WHERE ' + where, params
    );
    const total = parseInt(totalRows[0].count);

    const { rows: posts } = await db.query(
      `SELECT p.*,
              c.li_profile_url AS contact_li_url,
              c.first_name || ' ' || COALESCE(c.last_name,'') AS contact_full_name
       FROM linkedin_posts p
       LEFT JOIN contacts c ON c.id = p.contact_id
       WHERE ${where}
       ORDER BY p.posted_at DESC NULLS LAST
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    if (!posts.length) {
      return res.json({ items: [], total, page, limit, pages: Math.ceil(total / limit) || 1 });
    }

    const postIds = posts.map(p => p.id);
    const { rows: allComments } = await db.query(
      `SELECT * FROM linkedin_comments
       WHERE post_id = ANY($1::int[])
       ORDER BY post_id, parent_comment_id NULLS FIRST, commented_at ASC`,
      [postIds]
    );

    const commentsByPost = {};
    const commentById    = {};
    for (const c of allComments) commentById[c.id] = { ...c, replies: [] };
    for (const c of allComments) {
      if (!commentsByPost[c.post_id]) commentsByPost[c.post_id] = [];
      if (c.parent_comment_id && commentById[c.parent_comment_id]) {
        commentById[c.parent_comment_id].replies.push(commentById[c.id]);
      } else {
        commentsByPost[c.post_id].push(commentById[c.id]);
      }
    }

    const items = posts.map(p => ({ ...p, comments: commentsByPost[p.id] || [] }));
    res.json({ items, total, page, limit, pages: Math.ceil(total / limit) || 1 });
  } catch (err) {
    console.error('[Feed] GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/feed/fetch
 */
router.post('/fetch', async (req, res) => {
  try {
    const workspace_id = req.body?.workspace_id || req.query.workspace_id;
    const campaign_id  = req.body?.campaign_id  || req.query.campaign_id;
    if (!workspace_id || !campaign_id)
      return res.status(400).json({ error: 'workspace_id and campaign_id required' });

    const { rows } = await db.query(
      'SELECT account_id FROM campaigns WHERE id = $1 AND workspace_id = $2',
      [campaign_id, workspace_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
    const { account_id } = rows[0];
    if (!account_id) return res.status(400).json({ error: 'Campaign has no account_id' });

    scrapeContactFeed(campaign_id, workspace_id, account_id)
      .catch(err => console.error('[Feed] scrape error:', err.message));

    res.json({ status: 'started', campaign_id, account_id });
  } catch (err) {
    console.error('[Feed] POST /fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

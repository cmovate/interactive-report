/**
 * Engagement Scraper — Contacts
 *
 * Runs daily for ALL active campaigns regardless of settings.
 * Three distinct phases per campaign:
 *
 *   Phase 1 — Scrape (unconditional)
 *     Fetches posts + comments for unscraped contacts, saves JSONB to DB.
 *
 *   Phase 2 — Personal account likes (if enabled in campaign settings)
 *     Selects up to 20 contacts with content.
 *     Rule: skips contacts the company page already liked TODAY.
 *     Tracks in: likes_sent_at, liked_ids, post_likes_sent, comment_likes_sent
 *
 *   Phase 3 — Company page likes (if enabled in campaign settings)
 *     Selects up to 20 DIFFERENT contacts with content.
 *     Rule: skips contacts the personal account liked TODAY (including Phase 2).
 *     Tracks in: company_likes_sent_at, company_liked_ids,
 *                company_post_likes_sent, company_comment_likes_sent
 *
 * ABSOLUTE ISOLATION RULE:
 *   On any calendar day, a contact can only be liked by ONE identity
 *   (personal OR company page). Never both on the same day. No exceptions.
 *
 * Engagement levels (OR logic):
 *   un_engaged       — 0 non-employer posts AND 0 non-employer comments in 14d
 *   average_engaged  — ≥1 non-employer post OR ≥1 non-employer comment in 14d
 *   engaged          — ≥2 non-employer posts OR ≥2 non-employer comments in 14d
 *
 * Cooldown: 3 days before re-liking the same contact (per identity)
 * Dedup: liked_ids / company_liked_ids track IDs already liked
 *
 * Scheduled: once daily at 06:00.
 */

const db      = require('./db');
const unipile = require('./unipile');

const DAYS_14       = 14 * 24 * 60 * 60 * 1000;
const MAX_LIKES     = 3;
const COOLDOWN_DAYS = 3;
const BATCH_SIZE    = 30;
const SCRAPE_LIMIT  = 50;
const LIKE_BATCH    = 20;   // max contacts liked per identity per run

const rand  = (min, max) => min + Math.random() * (max - min);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let isRunning = false;

function start() {
  console.log('[EngagementScraper] Started — runs daily at 06:00');
  scheduleDaily();
}

function scheduleDaily() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(6, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const ms = next - now;
  console.log(`[EngagementScraper] Next run in ${Math.round(ms / 3600000)}h`);
  setTimeout(() => { run(); setInterval(run, 24 * 60 * 60 * 1000); }, ms);
}

async function run(campaignId = null) {
  if (isRunning) { console.log('[EngagementScraper] Already running, skipping'); return { skipped: true }; }
  isRunning = true;
  console.log('[EngagementScraper] Starting run...');

  try {
    let query = `SELECT c.id, c.account_id, c.name, c.settings FROM campaigns c WHERE c.status = 'active'`;
    const qp = [];
    if (campaignId) { qp.push(campaignId); query += ` AND c.id = $${qp.length}`; }

    const { rows: campaigns } = await db.query(query, qp);
    if (!campaigns.length) { console.log('[EngagementScraper] No active campaigns'); return { campaigns_processed: 0 }; }

    const summary = [];
    for (const campaign of campaigns) {
      const result = await processCampaign(campaign);
      summary.push({ campaign_id: campaign.id, name: campaign.name, ...result });
    }

    console.log('[EngagementScraper] Done:', JSON.stringify(summary));
    return { campaigns_processed: campaigns.length, summary };
  } catch (err) {
    console.error('[EngagementScraper] Error:', err.message);
    return { error: err.message };
  } finally {
    isRunning = false;
  }
}

// ──────────────────────────────────────────────────────────────────
async function processCampaign(campaign) {
  console.log(`[EngagementScraper] Campaign ${campaign.id}: "${campaign.name}"`);

  // Load company page URN and org ID
  const { rows: accRows } = await db.query(
    'SELECT settings FROM unipile_accounts WHERE account_id = $1',
    [campaign.account_id]
  );
  const companyPageUrn = accRows[0]?.settings?.company_page_urn || null;
  const asOrgId        = companyPageUrn?.match(/(\d+)$/)?.[1] || null;

  // What's enabled in campaign settings
  const eng = campaign.settings?.engagement || {};
  const personalFlags = {
    doLikePosts:    !!eng.like_posts,
    doLikeComments: !!eng.like_comments,
  };
  const companyFlags = {
    doLikePosts:    !!eng.company_like_posts    && !!asOrgId,
    doLikeComments: !!eng.company_like_comments && !!asOrgId,
  };
  const canLikePersonal = personalFlags.doLikePosts || personalFlags.doLikeComments;
  const canLikeCompany  = companyFlags.doLikePosts  || companyFlags.doLikeComments;

  // ── Phase 1: Scrape new contacts (unconditional) ──────────────────────
  const scrapedCount = await scrapeNewContacts(campaign);

  // ── Phase 2: Personal account likes ─────────────────────────────
  // Returns IDs of contacts liked in this run (to exclude from Phase 3)
  let personalLikedIds = [];
  if (canLikePersonal) {
    personalLikedIds = await runPersonalLikes(
      campaign.id, campaign.account_id, companyPageUrn, personalFlags
    );
  }

  // ── Phase 3: Company page likes ──────────────────────────────
  // Excludes personalLikedIds + contacts personal liked today
  let companyLikedCount = 0;
  if (canLikeCompany) {
    companyLikedCount = await runCompanyLikes(
      campaign.id, campaign.account_id, asOrgId, companyFlags, personalLikedIds
    );
  }

  const { rows: statsRows } = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE engagement_level IN ('average_engaged','engaged')) AS with_content,
       COUNT(*) FILTER (WHERE engagement_level = 'un_engaged')                   AS un_engaged,
       COUNT(*) FILTER (WHERE engagement_level IS NULL AND provider_id IS NOT NULL) AS pending
     FROM contacts WHERE campaign_id = $1`,
    [campaign.id]
  );
  const s = statsRows[0];
  console.log(`[EngagementScraper] Campaign ${campaign.id}: with_content=${s.with_content} un_engaged=${s.un_engaged} pending=${s.pending}`);

  return {
    contacts_scraped:     scrapedCount,
    personal_liked:       personalLikedIds.length,
    company_liked:        companyLikedCount,
  };
}

// ── Phase 1: Scrape new contacts ──────────────────────────────────────
async function scrapeNewContacts(campaign) {
  const cooldownCutoff = new Date(Date.now() - COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { rows: contacts } = await db.query(
    `SELECT id, first_name, last_name, company, provider_id
     FROM contacts
     WHERE campaign_id = $1
       AND provider_id IS NOT NULL AND provider_id != ''
       AND engagement_level IS NULL
       AND engagement_data IS NULL
       AND (likes_sent_at IS NULL OR likes_sent_at < $2)
     ORDER BY RANDOM()
     LIMIT $3`,
    [campaign.id, cooldownCutoff, BATCH_SIZE]
  );

  if (!contacts.length) return 0;
  console.log(`[EngagementScraper] Campaign ${campaign.id}: scraping ${contacts.length} contacts`);

  let scraped = 0;
  for (const contact of contacts) {
    try {
      await scrapeContact(contact, campaign.account_id);
      scraped++;
    } catch (err) {
      console.error(`[EngagementScraper] ✗ scrape contact ${contact.id}: ${err.message}`);
    }
    if (scraped < contacts.length) await sleep(rand(8000, 20000));
  }
  return scraped;
}

// ── Phase 2: Personal account likes (up to LIKE_BATCH contacts) ────────────
// Returns array of contact IDs that were liked in this run.
async function runPersonalLikes(campaignId, accountId, companyPageUrn, flags) {
  const cooldownCutoff = new Date(Date.now() - COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { rows: contacts } = await db.query(
    `SELECT id, first_name, last_name, engagement_data,
            liked_ids, post_likes_sent, comment_likes_sent
     FROM contacts
     WHERE campaign_id = $1
       AND engagement_level IN ('engaged', 'average_engaged')
       AND engagement_data IS NOT NULL
       AND (likes_sent_at IS NULL OR likes_sent_at < $2)
       AND (
         company_likes_sent_at IS NULL
         OR DATE(company_likes_sent_at AT TIME ZONE 'UTC') < CURRENT_DATE
       )
     ORDER BY CASE engagement_level WHEN 'engaged' THEN 0 ELSE 1 END, RANDOM()
     LIMIT $3`,
    [campaignId, cooldownCutoff, LIKE_BATCH]
  );

  if (!contacts.length) {
    console.log(`[EngagementScraper] Personal likes: no eligible contacts`);
    return [];
  }

  console.log(`[EngagementScraper] Personal likes: processing ${contacts.length} contacts`);
  const asOrgId = companyPageUrn?.match(/(\d+)$/)?.[1] || null;
  const likedContactIds = [];

  for (const contact of contacts) {
    try {
      const liked = await likeContactPersonal(contact, accountId, asOrgId, flags);
      if (liked > 0) likedContactIds.push(contact.id);
    } catch (err) {
      console.error(`[EngagementScraper] ✗ personal like contact ${contact.id}: ${err.message}`);
    }
    await sleep(rand(5000, 15000));
  }

  return likedContactIds;
}

// ── Phase 3: Company page likes (up to LIKE_BATCH DIFFERENT contacts) ───────
// Excludes: contacts liked personally today + contacts just liked in Phase 2.
async function runCompanyLikes(campaignId, accountId, asOrgId, flags, excludeContactIds) {
  const cooldownCutoff = new Date(Date.now() - COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Use [-1] as dummy when no exclusions to keep the query valid
  const excludeArr = excludeContactIds.length > 0 ? excludeContactIds : [-1];

  const { rows: contacts } = await db.query(
    `SELECT id, first_name, last_name, engagement_data,
            company_liked_ids, company_post_likes_sent, company_comment_likes_sent
     FROM contacts
     WHERE campaign_id = $1
       AND engagement_level IN ('engaged', 'average_engaged')
       AND engagement_data IS NOT NULL
       AND (company_likes_sent_at IS NULL OR company_likes_sent_at < $2)
       AND (
         likes_sent_at IS NULL
         OR DATE(likes_sent_at AT TIME ZONE 'UTC') < CURRENT_DATE
       )
       AND id != ALL($3)
     ORDER BY CASE engagement_level WHEN 'engaged' THEN 0 ELSE 1 END, RANDOM()
     LIMIT $4`,
    [campaignId, cooldownCutoff, excludeArr, LIKE_BATCH]
  );

  if (!contacts.length) {
    console.log(`[EngagementScraper] Company likes: no eligible contacts`);
    return 0;
  }

  console.log(`[EngagementScraper] Company likes: processing ${contacts.length} contacts`);
  let likedCount = 0;

  for (const contact of contacts) {
    try {
      const liked = await likeContactAsCompany(contact, accountId, asOrgId, flags);
      if (liked > 0) likedCount++;
    } catch (err) {
      console.error(`[EngagementScraper] ✗ company like contact ${contact.id}: ${err.message}`);
    }
    await sleep(rand(5000, 15000));
  }

  return likedCount;
}

// ── Scrape one contact and save JSONB ──────────────────────────────────────
async function scrapeContact(contact, accountId) {
  const cutoff = new Date(Date.now() - DAYS_14);
  const contactCompany = (contact.company || '').toLowerCase().trim();

  let rawPosts = [], rawComments = [];

  try { rawPosts = await unipile.getUserPosts(accountId, contact.provider_id, SCRAPE_LIMIT); }
  catch (err) { console.warn(`[Scraper] Posts failed ${contact.provider_id}: ${err.message}`); }

  await sleep(rand(3000, 8000));

  try { rawComments = await unipile.getUserComments(accountId, contact.provider_id, SCRAPE_LIMIT); }
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

// ── Like as personal account ───────────────────────────────────────────────
async function likeContactPersonal(contact, accountId, asOrgId, flags) {
  const { rows } = await db.query('SELECT liked_ids FROM contacts WHERE id = $1', [contact.id]);
  const alreadyLiked = new Set(Array.isArray(rows[0]?.liked_ids) ? rows[0].liked_ids : []);

  const engData = typeof contact.engagement_data === 'string'
    ? JSON.parse(contact.engagement_data) : (contact.engagement_data || {});

  const items = buildLikeItems(engData, alreadyLiked, flags, false);
  if (!items.length) return 0;

  let sent = 0;
  const newKeys = [];
  let postLikes = 0, commentLikes = 0;

  for (const item of items) {
    if (sent >= MAX_LIKES) break;
    try {
      await unipile.likePost(accountId, item.social_id, item.comment_id, undefined);
      newKeys.push(item.key);
      if (item.type === 'post')    postLikes++;
      if (item.type === 'comment') commentLikes++;
      sent++;
      console.log(`[EngagementScraper] 👍 Personal: ${item.type} → ${contact.first_name} ${contact.last_name}`);
      if (sent < MAX_LIKES) await sleep(rand(5000, 15000));
    } catch (err) {
      console.error(`[EngagementScraper] ✗ personal like ${contact.id}: ${err.message}`);
    }
  }

  if (sent > 0) {
    const merged = [...alreadyLiked, ...newKeys];
    await db.query(
      `UPDATE contacts
       SET post_likes_sent    = COALESCE(post_likes_sent, 0)    + $1,
           comment_likes_sent = COALESCE(comment_likes_sent, 0) + $2,
           likes_sent_at      = NOW(),
           liked_ids          = $3::jsonb
       WHERE id = $4`,
      [postLikes, commentLikes, JSON.stringify(merged), contact.id]
    );
  }

  return sent;
}

// ── Like as company page ────────────────────────────────────────────────
async function likeContactAsCompany(contact, accountId, asOrgId, flags) {
  if (!asOrgId) return 0;

  const { rows } = await db.query('SELECT company_liked_ids FROM contacts WHERE id = $1', [contact.id]);
  const alreadyLiked = new Set(Array.isArray(rows[0]?.company_liked_ids) ? rows[0].company_liked_ids : []);

  const engData = typeof contact.engagement_data === 'string'
    ? JSON.parse(contact.engagement_data) : (contact.engagement_data || {});

  const items = buildLikeItems(engData, alreadyLiked, flags, true);
  if (!items.length) return 0;

  let sent = 0;
  const newKeys = [];
  let postLikes = 0, commentLikes = 0;

  for (const item of items) {
    if (sent >= MAX_LIKES) break;
    try {
      await unipile.likePost(accountId, item.social_id, item.comment_id, asOrgId);
      newKeys.push(item.key);
      if (item.type === 'post')    postLikes++;
      if (item.type === 'comment') commentLikes++;
      sent++;
      console.log(`[EngagementScraper] 👍 Company page: ${item.type} → ${contact.first_name} ${contact.last_name}`);
      if (sent < MAX_LIKES) await sleep(rand(5000, 15000));
    } catch (err) {
      console.error(`[EngagementScraper] ✗ company like ${contact.id}: ${err.message}`);
    }
  }

  if (sent > 0) {
    const merged = [...alreadyLiked, ...newKeys];
    await db.query(
      `UPDATE contacts
       SET company_post_likes_sent    = COALESCE(company_post_likes_sent, 0)    + $1,
           company_comment_likes_sent = COALESCE(company_comment_likes_sent, 0) + $2,
           company_likes_sent_at      = NOW(),
           company_liked_ids          = $3::jsonb
       WHERE id = $4`,
      [postLikes, commentLikes, JSON.stringify(merged), contact.id]
    );
  }

  return sent;
}

// ── Build list of likeable items not yet liked ─────────────────────────────
// isCompany=true: use doLikePosts/doLikeComments from company flags (same field names)
function buildLikeItems(engData, alreadyLiked, flags, isCompany) {
  const items = [];

  if (flags.doLikePosts) {
    const posts = engData.non_employer_posts_14d_data || engData.posts_14d_data || [];
    for (const p of posts) {
      const sid = String(p.social_id || p.id || p.post_id || '');
      if (sid && !alreadyLiked.has(sid))
        items.push({ type: 'post', social_id: sid, comment_id: undefined, key: sid });
    }
  }

  if (flags.doLikeComments) {
    const comments = engData.non_employer_comments_14d_data || engData.comments_14d_data || [];
    for (const c of comments) {
      const postSid = String(c.post?.social_id || c.post_id || c.parent_post_id || '');
      const cid     = String(c.id || c.comment_id || '');
      const key     = `comment:${cid}`;
      if (postSid && cid && !alreadyLiked.has(key))
        items.push({ type: 'comment', social_id: postSid, comment_id: cid, key });
    }
  }

  return items;
}

// ── Re-classify from existing data (no API calls) ─────────────────────────────
async function reclassifyFromExistingData(campaignId) {
  const { rows } = await db.query(
    `SELECT id, first_name, last_name, engagement_data FROM contacts
     WHERE campaign_id = $1 AND engagement_data IS NOT NULL AND engagement_level IS NOT NULL`,
    [campaignId]
  );
  let updated = 0;
  for (const row of rows) {
    const d = typeof row.engagement_data === 'string' ? JSON.parse(row.engagement_data) : row.engagement_data;
    const newLevel = classifyEngagement(d.non_employer_posts_14d || 0, d.non_employer_comments_14d || 0);
    const oldLevel = d.engagement_level;
    d.engagement_level = newLevel;
    await db.query('UPDATE contacts SET engagement_level = $1, engagement_data = $2 WHERE id = $3', [newLevel, JSON.stringify(d), row.id]);
    if (newLevel !== oldLevel) console.log(`[Reclassify] ${row.first_name} ${row.last_name}: ${oldLevel} → ${newLevel}`);
    updated++;
  }
  return { reclassified: updated };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

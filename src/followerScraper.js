/**
 * Company Followers Scraper
 *
 * Scrapes ALL followers of the company LinkedIn page via Unipile,
 * stores them in the `company_followers` table, then cross-references
 * with contacts that were invited to follow — marking confirmed followers.
 *
 * Endpoint:  GET /api/v1/users/followers
 * Params:    account_id, user_id (numeric company ID), limit (max 100), cursor
 *
 * How to use:
 *   - Manual trigger via API:  POST /api/followers/scrape
 *   - Auto-scheduled:          runs once/day via setInterval
 *
 * After scraping:
 *   - contacts with company_follow_invited = true whose profile_url
 *     matches a scraped follower get company_follow_confirmed = true
 */

const db = require('./db');

const UNIPILE_DSN     = process.env.UNIPILE_DSN;
const UNIPILE_API_KEY = process.env.UNIPILE_API_KEY;
const COMPANY_ID      = '93249487'; // CMO'vate LinkedIn company numeric ID
const BATCH_LIMIT     = 100;        // Max per Unipile page
const DELAY_MS        = 3000 + Math.random() * 2000; // 3-5s between pages

let isScraping = false;
let lastScrapeResult = null;

// ── Public API ────────────────────────────────────────────────────────────────

function start() {
  console.log('[FollowerScraper] Scheduled — runs once per day');
  runScrape(); // Run immediately on startup
  setInterval(runScrape, 24 * 60 * 60 * 1000);
}

function getStatus() {
  return { is_scraping: isScraping, last_result: lastScrapeResult };
}

async function runScrape(accountId) {
  if (isScraping) {
    console.log('[FollowerScraper] Already running, skipping');
    return { skipped: true };
  }

  isScraping = true;
  const startTime = Date.now();
  console.log('[FollowerScraper] Starting scrape for company', COMPANY_ID);

  try {
    // Use the provided accountId or find one from DB
    if (!accountId) {
      const { rows } = await db.query(
        `SELECT account_id FROM unipile_accounts
         WHERE settings->>'company_page_urn' IS NOT NULL
         LIMIT 1`
      );
      accountId = rows[0]?.account_id;
    }

    if (!accountId) {
      throw new Error('No account with company_page_urn configured');
    }

    console.log(`[FollowerScraper] Using account: ${accountId}`);

    // 1. Paginate through all followers
    const followers = [];
    let cursor = null;
    let page = 0;

    do {
      page++;
      const params = new URLSearchParams({
        account_id: accountId,
        user_id: COMPANY_ID,
        limit: BATCH_LIMIT,
      });
      if (cursor) params.set('cursor', cursor);

      const res = await fetch(
        `${UNIPILE_DSN}/api/v1/users/followers?${params}`,
        { headers: { 'X-API-KEY': UNIPILE_API_KEY, 'accept': 'application/json' } }
      );

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Unipile ${res.status}: ${text}`);
      }

      const data = await res.json();
      const items = Array.isArray(data.items) ? data.items : [];
      followers.push(...items);

      console.log(`[FollowerScraper] Page ${page}: got ${items.length} followers (total so far: ${followers.length})`);

      // Get next cursor
      cursor = null;
      if (data.cursor) {
        // cursor can be { value: '...' } or a raw string
        cursor = typeof data.cursor === 'object' ? data.cursor.value : data.cursor;
      }

      if (cursor && items.length > 0) {
        await sleep(DELAY_MS);
      }
    } while (cursor && followers.length < 5000); // safety cap

    console.log(`[FollowerScraper] Total followers scraped: ${followers.length}`);

    // 2. Upsert all followers into company_followers table
    let upserted = 0;
    for (const f of followers) {
      const profileUrl = normalizeUrl(f.profile_url || '');
      const followerId = f.id || f.urn || null;

      if (!followerId && !profileUrl) continue;

      await db.query(
        `INSERT INTO company_followers
           (account_id, follower_id, follower_urn, name, headline, profile_url, scraped_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (account_id, follower_id)
         DO UPDATE SET
           name        = EXCLUDED.name,
           headline    = EXCLUDED.headline,
           profile_url = EXCLUDED.profile_url,
           scraped_at  = NOW()`,
        [accountId, followerId, f.urn || null, f.name || '', f.headline || '', profileUrl]
      );
      upserted++;
    }

    // 3. Cross-reference: mark contacts who are now following
    const { rowCount: confirmed } = await db.query(
      `UPDATE contacts c
       SET company_follow_confirmed = true
       FROM campaigns camp
       JOIN company_followers cf
         ON cf.account_id = camp.account_id
         AND (
           lower(cf.profile_url) = lower(c.li_profile_url)
           OR cf.profile_url ILIKE '%' || split_part(c.li_profile_url, '/in/', 2) || '%'
         )
       WHERE camp.id = c.campaign_id
         AND c.company_follow_invited = true
         AND (c.company_follow_confirmed = false OR c.company_follow_confirmed IS NULL)`
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    lastScrapeResult = {
      scraped_at:   new Date().toISOString(),
      total_followers: followers.length,
      upserted,
      newly_confirmed: confirmed,
      elapsed_seconds: parseFloat(elapsed),
    };

    console.log(`[FollowerScraper] Done in ${elapsed}s — ${followers.length} followers, ${confirmed} contacts confirmed`);
    return lastScrapeResult;

  } catch (err) {
    console.error('[FollowerScraper] Error:', err.message);
    lastScrapeResult = { error: err.message, scraped_at: new Date().toISOString() };
    return lastScrapeResult;
  } finally {
    isScraping = false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeUrl(url) {
  if (!url) return '';
  return url.replace(/\/$/, '').toLowerCase().trim();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { start, runScrape, getStatus };

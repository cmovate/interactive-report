/**
 * Company Followers Scraper
 *
 * ═══ SCRAPE MODES ═══════════════════════════════════════════════════════════
 *
 * LEARNING (days 0–7):
 *   - Full scrape 3× per day (every 8 hours)
 *   - Records each follower's position when first seen (first_seen_position)
 *   - After 7 days: analyses whether new followers consistently appear at the
 *     top of the list (position < INCREMENTAL_THRESHOLD)
 *     → YES → switches to INCREMENTAL mode
 *     → NO  → stays in FULL mode (once/day)
 *
 * INCREMENTAL (after learning, if ordering confirmed):
 *   - Only fetches the first N pages (INCREMENTAL_PAGES)
 *   - Stops early if all items on a page are already known (first_seen_at exists)
 *   - Runs once/day
 *
 * FULL (fallback, or forced):
 *   - Fetches all followers every time
 *   - Runs once/day
 *
 * Scrape mode is stored in unipile_accounts.settings:
 *   cf_scrape_mode:           'learning' | 'full' | 'incremental'
 *   cf_scrape_learning_start: ISO timestamp
 *   cf_scrape_last_run:       ISO timestamp
 *
 * ═══ COMPANY ID ════════════════════════════════════════════════════════════
 *   Read from unipile_accounts.settings.company_page_urn
 *   e.g. "urn:li:fsd_company:93249487"  →  user_id = 93249487
 *
 * ═══ AFTER EVERY SCRAPE ════════════════════════════════════════════════════
 *   - Upserts followers into company_followers (with first_seen_at on insert)
 *   - Cross-references contacts with company_follow_invited=true
 *     → marks company_follow_confirmed=true for matches
 */

const db = require('./db');

const UNIPILE_DSN     = process.env.UNIPILE_DSN;
const UNIPILE_API_KEY = process.env.UNIPILE_API_KEY;

const BATCH_LIMIT           = 100;   // Max per Unipile page (API cap)
const PAGE_DELAY_MS         = 4000;  // Delay between pages (human-like)
const LEARNING_DAYS         = 7;     // Days to stay in learning mode
const LEARNING_INTERVAL_MS  = 8 * 60 * 60 * 1000;   // 3× per day = every 8h
const FULL_INTERVAL_MS      = 24 * 60 * 60 * 1000;  // Once per day
const INCREMENTAL_PAGES     = 3;     // Pages to fetch in incremental mode
const INCREMENTAL_THRESHOLD = 50;    // New followers must be in top 50 positions

let isScraping = false;
let lastScrapeResult = null;
let scheduleTimer = null;

// ── Public API ────────────────────────────────────────────────────────────────

async function start() {
  console.log('[FollowerScraper] Starting...');
  await runScrape();
  scheduleNext();
}

function getStatus() {
  return { is_scraping: isScraping, last_result: lastScrapeResult };
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

async function scheduleNext() {
  clearTimeout(scheduleTimer);

  let intervalMs = LEARNING_INTERVAL_MS;
  try {
    const { rows } = await db.query(
      `SELECT settings FROM unipile_accounts
       WHERE settings->>'company_page_urn' IS NOT NULL LIMIT 1`
    );
    const mode = rows[0]?.settings?.cf_scrape_mode || 'learning';
    intervalMs = mode === 'learning' ? LEARNING_INTERVAL_MS : FULL_INTERVAL_MS;
  } catch (_) {}

  console.log(`[FollowerScraper] Next scrape in ${(intervalMs / 3600000).toFixed(1)}h`);
  scheduleTimer = setTimeout(async () => { await runScrape(); scheduleNext(); }, intervalMs);
}

// ── Main runner ───────────────────────────────────────────────────────────────

async function runScrape(forcedAccountId) {
  if (isScraping) {
    console.log('[FollowerScraper] Already running, skipping');
    return { skipped: true };
  }

  isScraping = true;
  const startTime = Date.now();

  try {
    // Find account with company_page_urn configured
    let accountId = forcedAccountId;
    let accountSettings = {};

    if (!accountId) {
      const { rows } = await db.query(
        `SELECT account_id, settings FROM unipile_accounts
         WHERE settings->>'company_page_urn' IS NOT NULL
           AND settings->>'company_page_urn' != ''
         LIMIT 1`
      );
      if (!rows.length) {
        console.log('[FollowerScraper] No account with company_page_urn configured — skipping');
        isScraping = false;
        return { skipped: true, reason: 'no_company_page_urn' };
      }
      accountId       = rows[0].account_id;
      accountSettings = rows[0].settings || {};
    } else {
      const { rows } = await db.query(
        'SELECT settings FROM unipile_accounts WHERE account_id = $1',
        [accountId]
      );
      accountSettings = rows[0]?.settings || {};
    }

    // ── FIX: Extract company numeric ID from company_page_urn ────────────────
    // company_page_urn = "urn:li:fsd_company:93249487"
    const companyPageUrn = accountSettings.company_page_urn || '';
    const companyIdMatch = companyPageUrn.match(/(\d+)$/);
    if (!companyIdMatch) {
      throw new Error(`Cannot extract company ID from company_page_urn: "${companyPageUrn}"`);
    }
    const COMPANY_ID = companyIdMatch[1];
    console.log(`[FollowerScraper] Company ID: ${COMPANY_ID}, account: ${accountId}`);

    // Determine mode
    let mode = accountSettings.cf_scrape_mode || 'learning';
    const learningStart = accountSettings.cf_scrape_learning_start
      ? new Date(accountSettings.cf_scrape_learning_start)
      : null;

    // Initialise learning mode on first run
    if (!learningStart) {
      mode = 'learning';
      await patchSettings(accountId, {
        cf_scrape_mode: 'learning',
        cf_scrape_learning_start: new Date().toISOString(),
      });
    }

    // After 7 days in learning mode — evaluate ordering
    if (mode === 'learning' && learningStart) {
      const daysSinceLearning = (Date.now() - learningStart) / (1000 * 60 * 60 * 24);
      if (daysSinceLearning >= LEARNING_DAYS) {
        mode = await evaluateAndSwitchMode(accountId, learningStart);
      }
    }

    console.log(`[FollowerScraper] Mode: ${mode}`);

    // ── Fetch followers ──────────────────────────────────────────────────────
    const followers = await fetchFollowers(accountId, COMPANY_ID, mode);

    // ── Upsert into DB ───────────────────────────────────────────────────────
    let newFollowers = 0;
    for (let i = 0; i < followers.length; i++) {
      const f = followers[i];
      const profileUrl = normalizeUrl(f.profile_url || '');
      const followerId = f.id || f.urn || null;
      if (!followerId) continue;

      const res = await db.query(
        `INSERT INTO company_followers
           (account_id, follower_id, follower_urn, name, headline, profile_url,
            first_seen_at, first_seen_position, scraped_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, NOW())
         ON CONFLICT (account_id, follower_id) DO UPDATE SET
           name               = EXCLUDED.name,
           headline           = EXCLUDED.headline,
           profile_url        = EXCLUDED.profile_url,
           scraped_at         = NOW()
         RETURNING (xmax = 0) AS inserted`,
        [accountId, followerId, f.urn || null, f.name || '', f.headline || '',
         profileUrl, i]
      );
      if (res.rows[0]?.inserted) newFollowers++;
    }

    // ── Cross-reference with invited contacts ────────────────────────────────
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

    // Update last run timestamp
    await patchSettings(accountId, { cf_scrape_last_run: new Date().toISOString() });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    lastScrapeResult = {
      scraped_at:      new Date().toISOString(),
      mode,
      company_id:      COMPANY_ID,
      total_fetched:   followers.length,
      new_followers:   newFollowers,
      newly_confirmed: confirmed,
      elapsed_seconds: parseFloat(elapsed),
    };

    console.log(
      `[FollowerScraper] Done (${mode}) in ${elapsed}s — ` +
      `${followers.length} fetched, ${newFollowers} new, ${confirmed} contacts confirmed`
    );
    return lastScrapeResult;

  } catch (err) {
    console.error('[FollowerScraper] Error:', err.message);
    lastScrapeResult = { error: err.message, scraped_at: new Date().toISOString() };
    return lastScrapeResult;
  } finally {
    isScraping = false;
  }
}

// ── Fetch followers (full or incremental) ─────────────────────────────────────

async function fetchFollowers(accountId, companyId, mode) {
  const isIncremental = mode === 'incremental';
  const maxPages = isIncremental ? INCREMENTAL_PAGES : Infinity;

  const followers = [];
  let cursor = null;
  let page = 0;

  do {
    page++;
    const params = new URLSearchParams({
      account_id: accountId,
      user_id:    companyId,
      limit:      BATCH_LIMIT,
    });
    if (cursor) params.set('cursor', cursor);

    const res = await fetch(
      `${UNIPILE_DSN}/api/v1/users/followers?${params}`,
      { headers: { 'X-API-KEY': UNIPILE_API_KEY, accept: 'application/json' } }
    );
    if (!res.ok) throw new Error(`Unipile ${res.status}: ${await res.text()}`);

    const data  = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];
    followers.push(...items);

    console.log(
      `[FollowerScraper] Page ${page}: ${items.length} followers` +
      (isIncremental ? ` (incremental, max ${maxPages} pages)` : '')
    );

    // In incremental mode — stop early if all items on this page already exist
    if (isIncremental && items.length > 0) {
      const ids = items.map(f => f.id || f.urn).filter(Boolean);
      if (ids.length > 0) {
        const { rows } = await db.query(
          `SELECT COUNT(*) AS cnt FROM company_followers
           WHERE account_id = $1 AND follower_id = ANY($2)`,
          [accountId, ids]
        );
        const alreadyKnown = parseInt(rows[0].cnt, 10);
        if (alreadyKnown === ids.length) {
          console.log('[FollowerScraper] All items on page already known — stopping early');
          break;
        }
      }
    }

    cursor = null;
    if (data.cursor) {
      cursor = typeof data.cursor === 'object' ? data.cursor.value : data.cursor;
    }

    if (cursor && items.length > 0 && page < maxPages) {
      await sleep(PAGE_DELAY_MS);
    }
  } while (cursor && page < maxPages && followers.length < 10000);

  return followers;
}

// ── Evaluate ordering after learning phase ────────────────────────────────────

async function evaluateAndSwitchMode(accountId, learningStart) {
  console.log('[FollowerScraper] Evaluating ordering after learning phase...');

  const { rows: newOnes } = await db.query(
    `SELECT first_seen_position FROM company_followers
     WHERE account_id = $1
       AND first_seen_at > $2
       AND first_seen_position IS NOT NULL
     ORDER BY first_seen_at ASC`,
    [accountId, learningStart.toISOString()]
  );

  if (newOnes.length < 5) {
    console.log('[FollowerScraper] Not enough new followers to evaluate — staying in full mode');
    await patchSettings(accountId, { cf_scrape_mode: 'full' });
    return 'full';
  }

  const positions   = newOnes.map(r => parseInt(r.first_seen_position, 10));
  const allNearTop  = positions.every(p => p < INCREMENTAL_THRESHOLD);
  const avgPosition = positions.reduce((a, b) => a + b, 0) / positions.length;

  console.log(
    `[FollowerScraper] ${newOnes.length} new followers since learning. ` +
    `Avg position: ${avgPosition.toFixed(1)}. All near top (<${INCREMENTAL_THRESHOLD}): ${allNearTop}`
  );

  if (allNearTop) {
    console.log('[FollowerScraper] ✓ Ordering confirmed — switching to INCREMENTAL mode');
    await patchSettings(accountId, { cf_scrape_mode: 'incremental' });
    return 'incremental';
  } else {
    console.log('[FollowerScraper] ✗ Ordering NOT consistent — staying in FULL mode');
    await patchSettings(accountId, { cf_scrape_mode: 'full' });
    return 'full';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Safe patch of settings JSONB using parameterized query.
 * Converts patch object to jsonb_build_object with proper $N parameters.
 */
async function patchSettings(accountId, patch) {
  const entries = Object.entries(patch);
  if (!entries.length) return;

  // Build: jsonb_build_object($2, $3, $4, $5, ...)
  const args   = [accountId];
  const parts  = [];
  for (const [k, v] of entries) {
    args.push(k, v);
    parts.push(`$${args.length - 1}, $${args.length}`);
  }

  await db.query(
    `UPDATE unipile_accounts
     SET settings = settings || jsonb_build_object(${parts.join(', ')})
     WHERE account_id = $1`,
    args
  );
}

function normalizeUrl(url) {
  return (url || '').replace(/\/$/, '').toLowerCase().trim();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { start, runScrape, getStatus };

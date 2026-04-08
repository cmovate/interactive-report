/**
 * src/profileViewScraper.js
 *
 * Runs 3× per day (08:00, 14:00, 20:00 server time).
 * For every workspace × every unipile account:
 *   1. Fetches last 5 LinkedIn profile viewers via Voyager API
 *   2. ANONYMOUS viewer  → records in profile_view_events + increments daily analytics
 *   3. IDENTIFIED viewer → same as above, PLUS:
 *       a. Found in any list   → marks viewed_our_profile=true on list_contacts row
 *       b. NOT found anywhere  → adds to workspace's default "Profile Viewers" list
 *
 * Table created here: profile_view_events
 */

const db = require('./db');

const VOYAGER_URL =
  'https://www.linkedin.com/voyager/api/graphql' +
  '?variables=(start:0,query:(),analyticsEntityUrn:(activityUrn:urn%3Ali%3Adummy%3A-1),surfaceType:WVMP)' +
  '&queryId=voyagerPremiumDashAnalyticsObject.c31102e906e7098910f44e0cecaa5b5c';

// Fire at 08:00, 14:00, 20:00 — check every minute
const FIRE_HOURS   = [8, 14, 20];
const STARTUP_DELAY_MS = 3 * 60 * 1000; // 3 min after boot

// ── Ensure DB table exists ────────────────────────────────────────────────────

async function ensureTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS profile_view_events (
      id            SERIAL PRIMARY KEY,
      workspace_id  INTEGER NOT NULL,
      account_id    VARCHAR(255) NOT NULL,
      viewed_at     TIMESTAMP,
      scraped_at    TIMESTAMP DEFAULT NOW(),
      is_anonymous  BOOLEAN DEFAULT TRUE,
      viewer_name   TEXT,
      viewer_title  TEXT,
      viewer_provider_id  VARCHAR(255),
      viewer_li_url TEXT,
      contact_id    INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
      raw_caption   TEXT
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_pve_ws    ON profile_view_events(workspace_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_pve_acct  ON profile_view_events(account_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_pve_time  ON profile_view_events(scraped_at)`);

  // Add viewed_our_profile column to list_contacts if missing
  await db.query(`ALTER TABLE list_contacts ADD COLUMN IF NOT EXISTS viewed_our_profile BOOLEAN DEFAULT FALSE`);
  await db.query(`ALTER TABLE list_contacts ADD COLUMN IF NOT EXISTS viewed_our_profile_at TIMESTAMP`);
}

// ── Voyager API call ──────────────────────────────────────────────────────────

async function fetchProfileViewers(accountId, limit = 5) {
  const UNIPILE_DSN     = process.env.UNIPILE_DSN;
  const UNIPILE_API_KEY = process.env.UNIPILE_API_KEY;

  const res = await fetch(`${UNIPILE_DSN}/api/v1/linkedin`, {
    method: 'POST',
    headers: {
      'X-API-KEY':     UNIPILE_API_KEY,
      'accept':        'application/json',
      'content-type':  'application/json',
    },
    body: JSON.stringify({
      account_id:  accountId,
      method:      'GET',
      request_url: VOYAGER_URL,
      encoding:    false,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Voyager ${res.status}: ${text.substring(0, 120)}`);
  }

  const data = await res.json();
  const elems = data?.data?.data?.premiumDashAnalyticsObjectByAnalyticsEntity?.elements || [];
  return elems.slice(0, limit);
}

// ── Parse a single element ────────────────────────────────────────────────────

function parseViewer(elem) {
  const lockup = elem?.content?.analyticsEntityLockup?.entityLockup;
  if (!lockup) return null;

  const name    = lockup?.title?.text?.trim() || '';
  const title   = lockup?.subtitle?.text?.trim() || '';
  const caption = lockup?.caption?.text?.trim() || ''; // "Viewed 3h ago"

  // publicIdentifier is stored in the image URL path
  const rawJson = JSON.stringify(elem);
  const pidMatch = rawJson.match(/"publicIdentifier":"([^"]+)"/);
  const publicIdentifier = pidMatch?.[1] || null;

  // Provider ID is the ACoAAA... key in the image URL path
  const provIdMatch = rawJson.match(/linkedin\.com\/in\/(ACoA[A-Za-z0-9_-]+)/);
  const providerId = provIdMatch?.[1] || null;

  const liUrl = publicIdentifier
    ? `https://www.linkedin.com/in/${publicIdentifier}`
    : null;

  // Parse "Viewed 3h ago" / "Viewed 1d ago" / "Viewed 15h ago"
  let viewedAt = null;
  if (caption) {
    const hMatch = caption.match(/(\d+)\s*h/i);
    const dMatch = caption.match(/(\d+)\s*d/i);
    const mMatch = caption.match(/(\d+)\s*m/i);
    const now = Date.now();
    if      (hMatch) viewedAt = new Date(now - parseInt(hMatch[1]) * 3600000);
    else if (dMatch) viewedAt = new Date(now - parseInt(dMatch[1]) * 86400000);
    else if (mMatch) viewedAt = new Date(now - parseInt(mMatch[1]) * 60000);
    else              viewedAt = new Date();
  }

  // Anonymous: name looks like "Someone at X" or "Founder in..."
  const isAnonymous = !publicIdentifier && !providerId;

  return { name, title, caption, publicIdentifier, providerId, liUrl, viewedAt, isAnonymous };
}

// ── Find or create "Profile Viewers" list for workspace ───────────────────────

async function getOrCreateViewersList(workspaceId) {
  const { rows } = await db.query(
    `SELECT id FROM lists WHERE workspace_id=$1 AND name='Profile Viewers' LIMIT 1`,
    [workspaceId]
  );
  if (rows.length) return rows[0].id;

  const { rows: created } = await db.query(
    `INSERT INTO lists (workspace_id, name, description, created_at)
     VALUES ($1, 'Profile Viewers', 'Auto-created: people who viewed our profiles', NOW())
     RETURNING id`,
    [workspaceId]
  );
  console.log(`[ProfileViewScraper] Created "Profile Viewers" list for ws=${workspaceId}`);
  return created[0].id;
}

// ── Process one account ───────────────────────────────────────────────────────

async function processAccount(workspaceId, accountId) {
  let viewers;
  try {
    viewers = await fetchProfileViewers(accountId, 5);
  } catch (e) {
    console.warn(`[ProfileViewScraper] ws=${workspaceId} acc=${accountId}: ${e.message}`);
    return { total: 0, identified: 0, added: 0 };
  }

  let identified = 0, added = 0;

  for (const elem of viewers) {
    const v = parseViewer(elem);
    if (!v) continue;

    // ── Dedup: skip if we already recorded this viewer in last 12h ────────────
    if (!v.isAnonymous && v.liUrl) {
      const { rows: dup } = await db.query(
        `SELECT id FROM profile_view_events
         WHERE workspace_id=$1 AND viewer_li_url=$2 AND scraped_at > NOW() - INTERVAL '12 hours'
         LIMIT 1`,
        [workspaceId, v.liUrl]
      );
      if (dup.length) continue; // already recorded recently
    }

    // ── Try to match to existing contact ─────────────────────────────────────
    let contactId = null;
    if (!v.isAnonymous && v.liUrl) {
      const { rows: cRows } = await db.query(
        `SELECT id FROM contacts
         WHERE workspace_id=$1 AND (li_profile_url=$2 OR provider_id=$3)
         LIMIT 1`,
        [workspaceId, v.liUrl, v.providerId || '']
      );
      contactId = cRows[0]?.id || null;
    }

    // ── Record in profile_view_events ─────────────────────────────────────────
    await db.query(
      `INSERT INTO profile_view_events
         (workspace_id, account_id, viewed_at, is_anonymous, viewer_name, viewer_title,
          viewer_provider_id, viewer_li_url, contact_id, raw_caption)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [workspaceId, accountId, v.viewedAt, v.isAnonymous,
       v.name, v.title, v.providerId, v.liUrl, contactId, v.caption]
    );

    if (v.isAnonymous) continue; // rest is only for identified viewers

    identified++;

    // ── Mark contact in list_contacts if they're in a list ────────────────────
    if (contactId) {
      await db.query(
        `UPDATE list_contacts
         SET viewed_our_profile=true, viewed_our_profile_at=COALESCE(viewed_our_profile_at,$1)
         WHERE contact_id=$2`,
        [v.viewedAt || new Date(), contactId]
      );

      // Also update contacts.last_profile_view_at if we viewed THEM (different concept —
      // this is THEY viewed US, so we store on profile_view_events only; we do NOT
      // overwrite last_profile_view_at which tracks when WE viewed THEM)
    } else {
      // ── Not in any list — create contact and add to "Profile Viewers" list ──
      const listId = await getOrCreateViewersList(workspaceId);

      // Insert contact
      const { rows: newC } = await db.query(
        `INSERT INTO contacts
           (workspace_id, first_name, last_name, li_profile_url, provider_id, title)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (workspace_id, li_profile_url) DO UPDATE
           SET provider_id = COALESCE(EXCLUDED.provider_id, contacts.provider_id),
               title       = COALESCE(EXCLUDED.title, contacts.title)
         RETURNING id`,
        [workspaceId,
         v.name.split(' ')[0] || '',
         v.name.split(' ').slice(1).join(' ') || '',
         v.liUrl,
         v.providerId,
         v.title || null]
      );

      const newContactId = newC[0]?.id;
      if (newContactId) {
        await db.query(
          `INSERT INTO list_contacts (list_id, contact_id, viewed_our_profile, viewed_our_profile_at)
           VALUES ($1,$2,true,$3)
           ON CONFLICT (list_id, contact_id) DO UPDATE
             SET viewed_our_profile=true,
                 viewed_our_profile_at=COALESCE(list_contacts.viewed_our_profile_at,$3)`,
          [listId, newContactId, v.viewedAt || new Date()]
        );

        // Update event with resolved contact_id
        await db.query(
          `UPDATE profile_view_events SET contact_id=$1
           WHERE workspace_id=$2 AND account_id=$3 AND viewer_li_url=$4
             AND scraped_at > NOW() - INTERVAL '1 minute'`,
          [newContactId, workspaceId, accountId, v.liUrl]
        );

        added++;
        console.log(`[ProfileViewScraper] ✅ ws=${workspaceId} NEW viewer: ${v.name} (${v.liUrl}) → list ${listId}`);
      }
    }
  }

  return { total: viewers.length, identified, added };
}

// ── Daily analytics snapshot ──────────────────────────────────────────────────

async function updateDailyAnalytics(workspaceId) {
  // Count today's views per workspace
  const { rows } = await db.query(
    `SELECT
       COUNT(*) AS total_views,
       COUNT(*) FILTER (WHERE is_anonymous = false) AS identified_views
     FROM profile_view_events
     WHERE workspace_id=$1 AND scraped_at >= CURRENT_DATE`,
    [workspaceId]
  );
  const { total_views, identified_views } = rows[0] || {};

  // Upsert into campaign_daily_stats for workspace-level tracking
  // We use campaign_id=NULL for workspace-level rows where applicable
  // For now we just log; the stats snapshotter picks it up hourly
  console.log(`[ProfileViewScraper] ws=${workspaceId} today: ${total_views} views (${identified_views} identified)`);
}

// ── Main run ──────────────────────────────────────────────────────────────────

async function runAllWorkspaces() {
  console.log('[ProfileViewScraper] Starting scrape cycle...');
  try {
    const { rows: accounts } = await db.query(
      `SELECT DISTINCT ua.workspace_id, ua.account_id
       FROM unipile_accounts ua`
    );

    const wsSummary = {};
    for (const { workspace_id, account_id } of accounts) {
      try {
        const result = await processAccount(workspace_id, account_id);
        if (!wsSummary[workspace_id]) wsSummary[workspace_id] = { total:0, identified:0, added:0 };
        wsSummary[workspace_id].total      += result.total;
        wsSummary[workspace_id].identified += result.identified;
        wsSummary[workspace_id].added      += result.added;
        await new Promise(r => setTimeout(r, 1500)); // rate limit
      } catch (e) {
        console.error(`[ProfileViewScraper] acc ${account_id}:`, e.message);
      }
    }

    for (const [wsId, s] of Object.entries(wsSummary)) {
      if (s.total > 0)
        console.log(`[ProfileViewScraper] ws=${wsId}: ${s.total} viewers scraped | ${s.identified} identified | ${s.added} new contacts added`);
      await updateDailyAnalytics(parseInt(wsId));
    }

    console.log('[ProfileViewScraper] Scrape cycle complete.');
  } catch (e) {
    console.error('[ProfileViewScraper] runAllWorkspaces error:', e.message);
  }
}

// ── Scheduler: fire at 08:00, 14:00, 20:00 ───────────────────────────────────

let _lastFiredHour = -1;

function start() {
  ensureTable().catch(e => console.error('[ProfileViewScraper] ensureTable error:', e.message));

  setTimeout(() => {
    // Check every minute if it's time to fire
    setInterval(() => {
      const now  = new Date();
      const hour = now.getHours();
      const min  = now.getMinutes();

      if (FIRE_HOURS.includes(hour) && min === 0 && _lastFiredHour !== hour) {
        _lastFiredHour = hour;
        runAllWorkspaces().catch(e => console.error('[ProfileViewScraper] scheduled run error:', e.message));
      }
    }, 60 * 1000); // check every minute

    console.log(`[ProfileViewScraper] Started — fires daily at ${FIRE_HOURS.join(':00, ')}:00`);
  }, STARTUP_DELAY_MS);
}

module.exports = { start, runAllWorkspaces, processAccount };

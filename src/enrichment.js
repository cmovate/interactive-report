/**
 * Background enrichment queue.
 *
 * After a campaign is created, contacts are added here.
 * The queue processes ONE contact at a time with a random 5–10 s delay
 * between calls to stay within LinkedIn / Unipile rate limits.
 *
 * No external dependencies (no Redis / BullMQ) — fully in-process.
 */

const db           = require('./db');
const { enrichProfile } = require('./unipile');

// ── Queue state ───────────────────────────────────────────────────────────────
/** @type {{ contactId: number, accountId: string, li_profile_url: string }[]} */
const queue = [];
let isRunning  = false;
let processed  = 0;   // lifetime counter (for status endpoint)
let errors     = 0;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Add one contact to the enrichment queue.
 * Kicks off processing if the queue is currently idle.
 */
function enqueue(contactId, accountId, li_profile_url) {
  if (!li_profile_url || !li_profile_url.includes('linkedin.com/in/')) {
    console.log(`[Enrichment] Skipping contact ${contactId} — no valid LinkedIn URL`);
    return;
  }
  queue.push({ contactId, accountId, li_profile_url });
  console.log(`[Enrichment] Queued contact ${contactId}. Queue length: ${queue.length}`);
  if (!isRunning) processNext();
}

/** Status snapshot for the /api/enrichment/status endpoint */
function getStatus() {
  return {
    queued:    queue.length,
    running:   isRunning,
    processed,
    errors,
  };
}

// ── Internal ──────────────────────────────────────────────────────────────────

function randomDelay() {
  return 5000 + Math.random() * 5000; // 5 000 – 10 000 ms
}

async function processNext() {
  if (queue.length === 0) {
    isRunning = false;
    console.log('[Enrichment] Queue empty — idle.');
    return;
  }

  isRunning = true;
  const item = queue.shift();

  console.log(`[Enrichment] Processing contact ${item.contactId} — ${item.li_profile_url}`);

  try {
    const profile = await enrichProfile(item.accountId, item.li_profile_url);

    // ── Extract fields from Unipile profile response ──────────────────────
    const firstName = profile.first_name  || '';
    const lastName  = profile.last_name   || '';
    const headline  = profile.headline    || '';
    const location  = profile.location    || '';

    // Email — from contact_info
    const email = profile.contact_info?.emails?.[0] || '';

    // Website — from contact_info socials or websites array
    const website =
      profile.websites?.[0] ||
      profile.contact_info?.socials?.find(s => s.type === 'website' || s.type === 'Website')?.name ||
      '';

    // Company — latest experience entry
    const latestExp = profile.experience?.[0] || profile.experiences?.[0];
    const company   = latestExp?.company_name || latestExp?.company || '';
    const title     = latestExp?.title || headline;

    // LinkedIn company URL — from latest experience
    const liCompanyUrl = latestExp?.company_linkedin_url ||
                         latestExp?.linkedin_url ||
                         '';

    await db.query(
      `UPDATE contacts SET
         first_name      = CASE WHEN first_name  = '' OR first_name  IS NULL THEN $1 ELSE first_name  END,
         last_name       = CASE WHEN last_name   = '' OR last_name   IS NULL THEN $2 ELSE last_name   END,
         title           = CASE WHEN title       = '' OR title       IS NULL THEN $3 ELSE title       END,
         company         = CASE WHEN company     = '' OR company     IS NULL THEN $4 ELSE company     END,
         location        = CASE WHEN location    = '' OR location    IS NULL THEN $5 ELSE location    END,
         email           = CASE WHEN email       = '' OR email       IS NULL THEN $6 ELSE email       END,
         website         = CASE WHEN website     = '' OR website     IS NULL THEN $7 ELSE website     END,
         li_company_url  = CASE WHEN li_company_url = '' OR li_company_url IS NULL THEN $8 ELSE li_company_url END,
         profile_data    = $9
       WHERE id = $10`,
      [
        firstName, lastName, title, company,
        location, email, website, liCompanyUrl,
        JSON.stringify(profile),
        item.contactId,
      ]
    );

    processed++;
    console.log(`[Enrichment] ✓ ${firstName} ${lastName} @ ${company} (contact ${item.contactId})`);
  } catch (err) {
    errors++;
    console.error(`[Enrichment] ✗ contact ${item.contactId}: ${err.message}`);
  }

  // Schedule next item with random delay
  const delay = randomDelay();
  console.log(`[Enrichment] Waiting ${(delay / 1000).toFixed(1)}s before next contact...`);
  setTimeout(processNext, delay);
}

module.exports = { enqueue, getStatus };

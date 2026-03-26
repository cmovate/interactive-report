/**
 * Background enrichment queue.
 * Processes ONE contact at a time with 5–10 s random delay.
 * No external deps (no Redis / BullMQ).
 */

const db = require('./db');
const { enrichProfile } = require('./unipile');

// ── Queue state ───────────────────────────────────────────────────────────────
const queue = [];
let isRunning = false;
let processed = 0;
let errors    = 0;

// ── Public API ────────────────────────────────────────────────────────────────
function enqueue(contactId, accountId, li_profile_url) {
  if (!li_profile_url || !li_profile_url.includes('linkedin.com/in/')) {
    console.log(`[Enrichment] Skip contact ${contactId} — no valid LinkedIn URL`);
    return;
  }
  queue.push({ contactId, accountId, li_profile_url });
  console.log(`[Enrichment] Queued contact ${contactId}. Queue: ${queue.length}`);
  if (!isRunning) processNext();
}

function getStatus() {
  return { queued: queue.length, running: isRunning, processed, errors };
}

// ── Field extraction — tries every known Unipile field variation ──────────────
/**
 * Given a raw Unipile profile object, extract the fields we care about.
 * Logs the raw structure on first call so we can see what Unipile actually returns.
 */
function extractFields(profile, contactId) {
  // ── Debug: log raw keys + experience structure once per run ──────────────
  console.log(`[Enrichment] Profile keys for contact ${contactId}:`, Object.keys(profile));

  // Experience — Unipile may use any of these keys
  const expArray =
    profile.experience   ||
    profile.experiences  ||
    profile.positions    ||
    profile.work_history ||
    [];

  const exp = Array.isArray(expArray) && expArray.length > 0 ? expArray[0] : null;

  if (exp) {
    console.log(`[Enrichment] experience[0] keys for contact ${contactId}:`, Object.keys(exp));
  } else {
    console.log(`[Enrichment] No experience array found for contact ${contactId}`);
  }

  // ── Job title ─────────────────────────────────────────────────────────────
  const title =
    exp?.title           ||
    exp?.position        ||
    exp?.role            ||
    exp?.job_title       ||
    profile.headline     ||
    '';

  // ── Company name ──────────────────────────────────────────────────────────
  // Unipile may nest it as {company: {name: "..."}} or flat {company_name: "..."}
  const company =
    (typeof exp?.company === 'object' ? exp.company?.name : null) ||
    exp?.company_name     ||
    exp?.organization     ||
    exp?.employer         ||
    (typeof exp?.company === 'string' ? exp.company : null) ||
    // Last resort: parse headline "Title at Company"
    parseCompanyFromHeadline(profile.headline) ||
    '';

  // ── LinkedIn company URL ───────────────────────────────────────────────────
  const liCompanyUrl =
    exp?.company?.url               ||
    exp?.company?.profile_url       ||
    exp?.company?.linkedin_url      ||
    exp?.company_linkedin_url       ||
    exp?.company_url                ||
    exp?.organization_linkedin_url  ||
    '';

  // ── Email ────────────────────────────────────────────────────────────────
  // Unipile may put emails in contact_info.emails[] or at root level
  const email =
    profile.contact_info?.emails?.[0] ||
    profile.emails?.[0]               ||
    profile.email                     ||
    '';

  // ── Website ───────────────────────────────────────────────────────────────
  // Unipile: profile.websites = ["url"] OR contact_info.socials[{type,name}]
  const website =
    (Array.isArray(profile.websites) ? profile.websites[0] : null) ||
    profile.contact_info?.websites?.[0] ||
    profile.contact_info?.socials?.find(
      s => ['website','Website','web','personal_website'].includes(s.type)
    )?.name ||
    '';

  const firstName = profile.first_name || '';
  const lastName  = profile.last_name  || '';
  const location  = profile.location   || '';

  console.log(`[Enrichment] Extracted — title:"${title}" company:"${company}" email:"${email}" web:"${website}" liCo:"${liCompanyUrl}"`);

  return { firstName, lastName, title, company, location, email, website, liCompanyUrl };
}

/** Tries to extract company from "Head of Operations at Acme Corp" patterns */
function parseCompanyFromHeadline(headline) {
  if (!headline) return '';
  // " at ", " @ ", " | ", " - "
  const patterns = [/ at (.+)$/, / @ (.+)$/, / \| (.+)$/, / - (.+)$/];
  for (const re of patterns) {
    const m = headline.match(re);
    if (m) return m[1].trim();
  }
  return '';
}

// ── Queue processor ───────────────────────────────────────────────────────────
function randomDelay() {
  return 5000 + Math.random() * 5000;
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
    const { firstName, lastName, title, company, location, email, website, liCompanyUrl } =
      extractFields(profile, item.contactId);

    await applyToDb(item.contactId, { firstName, lastName, title, company, location, email, website, liCompanyUrl, profile });

    processed++;
    console.log(`[Enrichment] ✓ ${firstName} ${lastName} @ ${company} (contact ${item.contactId})`);
  } catch (err) {
    errors++;
    console.error(`[Enrichment] ✗ contact ${item.contactId}: ${err.message}`);
  }

  const delay = randomDelay();
  console.log(`[Enrichment] Waiting ${(delay / 1000).toFixed(1)}s...`);
  setTimeout(processNext, delay);
}

/** Write enriched fields to DB. Only overwrites fields that are currently empty. */
async function applyToDb(contactId, { firstName, lastName, title, company, location, email, website, liCompanyUrl, profile }) {
  await db.query(
    `UPDATE contacts SET
       first_name     = CASE WHEN first_name     = '' OR first_name     IS NULL THEN $1  ELSE first_name     END,
       last_name      = CASE WHEN last_name      = '' OR last_name      IS NULL THEN $2  ELSE last_name      END,
       title          = COALESCE(NULLIF($3,''), title),
       company        = COALESCE(NULLIF($4,''), company),
       location       = COALESCE(NULLIF($5,''), location),
       email          = COALESCE(NULLIF($6,''), email),
       website        = COALESCE(NULLIF($7,''), website),
       li_company_url = COALESCE(NULLIF($8,''), li_company_url),
       profile_data   = $9
     WHERE id = $10`,
    [firstName, lastName, title, company, location, email, website, liCompanyUrl,
     JSON.stringify(profile), contactId]
  );
}

/**
 * Re-extract fields from already-stored profile_data WITHOUT calling Unipile again.
 * Called by POST /api/contacts/re-extract
 */
async function reExtractAll(workspaceId) {
  const { rows } = await db.query(
    `SELECT id, profile_data FROM contacts
     WHERE workspace_id = $1
       AND profile_data IS NOT NULL
       AND profile_data::text != 'null'`,
    [workspaceId]
  );

  console.log(`[Re-extract] Found ${rows.length} contacts with stored profile_data`);
  let ok = 0, fail = 0;

  for (const row of rows) {
    try {
      const profile = typeof row.profile_data === 'string'
        ? JSON.parse(row.profile_data)
        : row.profile_data;

      const { firstName, lastName, title, company, location, email, website, liCompanyUrl } =
        extractFields(profile, row.id);

      // Force-overwrite all enrichable fields (re-extract = fix existing data)
      await db.query(
        `UPDATE contacts SET
           first_name     = COALESCE(NULLIF($1,''), first_name),
           last_name      = COALESCE(NULLIF($2,''), last_name),
           title          = COALESCE(NULLIF($3,''), title),
           company        = COALESCE(NULLIF($4,''), company),
           location       = COALESCE(NULLIF($5,''), location),
           email          = COALESCE(NULLIF($6,''), email),
           website        = COALESCE(NULLIF($7,''), website),
           li_company_url = COALESCE(NULLIF($8,''), li_company_url)
         WHERE id = $9`,
        [firstName, lastName, title, company, location, email, website, liCompanyUrl, row.id]
      );
      ok++;
    } catch (err) {
      fail++;
      console.error(`[Re-extract] Failed contact ${row.id}: ${err.message}`);
    }
  }

  console.log(`[Re-extract] Done — ${ok} updated, ${fail} failed`);
  return { total: rows.length, updated: ok, failed: fail };
}

module.exports = { enqueue, getStatus, reExtractAll };

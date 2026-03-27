/**
 * Background enrichment queue.
 * Processes ONE contact at a time with 5-10s random delay.
 *
 * Field mapping confirmed from live Unipile API:
 *   profile.work_experience[0].position  => title
 *   profile.work_experience[0].company   => company name (plain STRING)
 *   profile.work_experience[0].company_id => linkedin.com/company/{id}
 *   profile.websites[0]                  => website (array of strings)
 *   profile.contact_info.emails[0]       => email
 *   profile.first_name / last_name / location => root level
 */

const db = require('./db');
const { enrichProfile } = require('./unipile');

const queue = [];
let isRunning = false;
let processed = 0;
let errors    = 0;

function enqueue(contactId, accountId, li_profile_url) {
  if (!li_profile_url || !li_profile_url.includes('linkedin.com/in/')) {
    console.log(`[Enrichment] Skip contact ${contactId} - no valid LinkedIn URL`);
    return;
  }
  queue.push({ contactId, accountId, li_profile_url });
  console.log(`[Enrichment] Queued contact ${contactId}. Queue: ${queue.length}`);
  if (!isRunning) processNext();
}

function getStatus() {
  return { queued: queue.length, running: isRunning, processed, errors };
}

function extractFields(profile, contactId) {
  // CONFIRMED: Unipile uses work_experience (not experience/experiences/positions)
  const expArray = profile.work_experience || [];
  const exp = Array.isArray(expArray) && expArray.length > 0 ? expArray[0] : null;

  // CONFIRMED: field is .position (not .title)
  const title =
    exp?.position ||
    exp?.title    ||
    profile.headline ||
    '';

  // CONFIRMED: company is a plain STRING (not an object)
  const company =
    (typeof exp?.company === 'string' ? exp.company : '') ||
    (typeof exp?.company === 'object' ? (exp?.company?.name || '') : '') ||
    exp?.company_name ||
    '';

  // CONFIRMED: company_id is numeric, build LinkedIn URL from it
  const liCompanyUrl = exp?.company_id
    ? 'https://www.linkedin.com/company/' + exp.company_id
    : (exp?.company_url || exp?.company_linkedin_url || '');

  // CONFIRMED: websites is an array of strings at root level
  const website =
    (Array.isArray(profile.websites) && profile.websites.length > 0 ? profile.websites[0] : '') ||
    (profile.contact_info && profile.contact_info.websites && profile.contact_info.websites[0]) ||
    '';

  // contact_info.emails may or may not be present
  const email =
    (profile.contact_info && profile.contact_info.emails && profile.contact_info.emails[0]) ||
    (profile.emails && profile.emails[0]) ||
    profile.email ||
    '';

  const firstName = profile.first_name || '';
  const lastName  = profile.last_name  || '';
  const location  = profile.location   || '';

  console.log('[Enrichment] contact=' + contactId + ' title="' + title + '" company="' + company + '" website="' + website + '" liCompanyUrl="' + liCompanyUrl + '" email="' + email + '"');

  return { firstName, lastName, title, company, location, email, website, liCompanyUrl };
}

function randomDelay() {
  return 5000 + Math.random() * 5000;
}

async function processNext() {
  if (queue.length === 0) {
    isRunning = false;
    console.log('[Enrichment] Queue empty - idle.');
    return;
  }

  isRunning = true;
  const item = queue.shift();
  console.log('[Enrichment] Processing contact ' + item.contactId + ' - ' + item.li_profile_url);

  try {
    const profile = await enrichProfile(item.accountId, item.li_profile_url);
    const fields  = extractFields(profile, item.contactId);
    await applyToDb(item.contactId, fields, profile);
    processed++;
    console.log('[Enrichment] OK ' + fields.firstName + ' ' + fields.lastName + ' @ ' + fields.company + ' (contact ' + item.contactId + ')');
  } catch (err) {
    errors++;
    console.error('[Enrichment] FAIL contact ' + item.contactId + ': ' + err.message);
  }

  const delay = randomDelay();
  console.log('[Enrichment] Waiting ' + (delay / 1000).toFixed(1) + 's...');
  setTimeout(processNext, delay);
}

async function applyToDb(contactId, fields, profile) {
  const { firstName, lastName, title, company, location, email, website, liCompanyUrl } = fields;
  await db.query(
    `UPDATE contacts SET
       first_name     = COALESCE(NULLIF($1,''), first_name),
       last_name      = COALESCE(NULLIF($2,''), last_name),
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

async function reExtractAll(workspaceId) {
  const { rows } = await db.query(
    `SELECT id, profile_data FROM contacts
     WHERE workspace_id = $1
       AND profile_data IS NOT NULL
       AND profile_data::text != 'null'`,
    [workspaceId]
  );

  console.log('[Re-extract] ' + rows.length + ' contacts with stored profile_data');
  let ok = 0, fail = 0;

  for (const row of rows) {
    try {
      const profile = typeof row.profile_data === 'string'
        ? JSON.parse(row.profile_data)
        : row.profile_data;

      const fields = extractFields(profile, row.id);

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
        [fields.firstName, fields.lastName, fields.title, fields.company,
         fields.location, fields.email, fields.website, fields.liCompanyUrl, row.id]
      );
      ok++;
    } catch (err) {
      fail++;
      console.error('[Re-extract] Failed contact ' + row.id + ': ' + err.message);
    }
  }

  console.log('[Re-extract] Done - ' + ok + ' updated, ' + fail + ' failed');
  return { total: rows.length, updated: ok, failed: fail };
}

module.exports = { enqueue, getStatus, reExtractAll };

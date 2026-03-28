/**
 * Background enrichment queue.
 * Processes ONE contact at a time with 5-10s random delay.
 *
 * Field mapping confirmed from live Unipile API:
 *   profile.provider_id                   => LinkedIn internal ID (ACoXXX)
 *   profile.member_urn                    => numeric LinkedIn URN
 *   profile.work_experience[0].position   => title
 *   profile.work_experience[0].company    => company name
 *   profile.work_experience[0].company_id => numeric LinkedIn company ID (for posts API)
 *   profile.websites[0]                   => website
 *   profile.contact_info.emails[0]        => email
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
  const providerId = profile.provider_id || '';
  const memberUrn  = profile.member_urn  || '';

  const expArray = profile.work_experience || [];
  const exp = Array.isArray(expArray) && expArray.length > 0 ? expArray[0] : null;

  const title =
    exp?.position ||
    exp?.title    ||
    profile.headline || '';

  const company =
    (typeof exp?.company === 'string' ? exp.company : '') ||
    (typeof exp?.company === 'object' ? (exp?.company?.name || '') : '') ||
    exp?.company_name || '';

  // Numeric LinkedIn company ID (e.g. "77603575") — needed for posts API
  const companyLinkedInId = exp?.company_id ? String(exp.company_id) : '';

  const liCompanyUrl = companyLinkedInId
    ? 'https://www.linkedin.com/company/' + companyLinkedInId
    : (exp?.company_url || exp?.company_linkedin_url || '');

  const website =
    (Array.isArray(profile.websites) && profile.websites.length > 0 ? profile.websites[0] : '') ||
    (profile.contact_info?.websites?.[0]) ||
    '';

  const email =
    profile.contact_info?.emails?.[0] ||
    profile.emails?.[0] ||
    profile.email ||
    '';

  const firstName = profile.first_name || '';
  const lastName  = profile.last_name  || '';
  const location  = profile.location   || '';

  console.log(
    `[Enrichment] contact=${contactId}` +
    ` provider_id="${providerId}"` +
    ` company_id="${companyLinkedInId}"` +
    ` company="${company}"`
  );

  return { firstName, lastName, title, company, location, email, website,
           liCompanyUrl, companyLinkedInId, providerId, memberUrn };
}

function randomDelay() {
  return 5000 + Math.random() * 5000;
}

async function processNext() {
  if (queue.length === 0) { isRunning = false; console.log('[Enrichment] Queue empty - idle.'); return; }

  isRunning = true;
  const item = queue.shift();
  console.log('[Enrichment] Processing contact ' + item.contactId);

  try {
    const profile = await enrichProfile(item.accountId, item.li_profile_url);
    const fields  = extractFields(profile, item.contactId);
    await applyToDb(item.contactId, fields, profile);
    // Upsert company into campaign_companies table
    await upsertCampaignCompany(item.contactId, fields);
    processed++;
    console.log('[Enrichment] OK ' + fields.firstName + ' ' + fields.lastName + ' @ ' + fields.company);
  } catch (err) {
    errors++;
    console.error('[Enrichment] FAIL contact ' + item.contactId + ': ' + err.message);
  }

  setTimeout(processNext, randomDelay());
}

async function applyToDb(contactId, fields, profile) {
  const { firstName, lastName, title, company, location, email, website, liCompanyUrl, providerId, memberUrn } = fields;
  await db.query(
    `UPDATE contacts SET
       first_name     = COALESCE(NULLIF($1,''),  first_name),
       last_name      = COALESCE(NULLIF($2,''),  last_name),
       title          = COALESCE(NULLIF($3,''),  title),
       company        = COALESCE(NULLIF($4,''),  company),
       location       = COALESCE(NULLIF($5,''),  location),
       email          = COALESCE(NULLIF($6,''),  email),
       website        = COALESCE(NULLIF($7,''),  website),
       li_company_url = COALESCE(NULLIF($8,''),  li_company_url),
       provider_id    = COALESCE(NULLIF($9,''),  provider_id),
       member_urn     = COALESCE(NULLIF($10,''), member_urn),
       profile_data   = $11
     WHERE id = $12`,
    [firstName, lastName, title, company, location, email, website, liCompanyUrl,
     providerId, memberUrn, JSON.stringify(profile), contactId]
  );
}

/**
 * Upsert this contact's employer into campaign_companies.
 * Called after every successful enrichment.
 * company_linkedin_id (numeric) is required — skip if missing.
 */
async function upsertCampaignCompany(contactId, fields) {
  if (!fields.companyLinkedInId || !fields.company) return;

  try {
    // Get campaign_id and workspace_id from the contact
    const { rows } = await db.query(
      'SELECT campaign_id, workspace_id FROM contacts WHERE id = $1',
      [contactId]
    );
    if (!rows.length || !rows[0].campaign_id) return;

    const { campaign_id, workspace_id } = rows[0];

    // Upsert: create if new, increment contact_count if existing
    await db.query(
      `INSERT INTO campaign_companies
         (campaign_id, workspace_id, company_name, li_company_url, company_linkedin_id, contact_count)
       VALUES ($1, $2, $3, $4, $5, 1)
       ON CONFLICT (campaign_id, company_linkedin_id)
       DO UPDATE SET
         company_name   = EXCLUDED.company_name,
         li_company_url = EXCLUDED.li_company_url,
         contact_count  = campaign_companies.contact_count + 1`,
      [campaign_id, workspace_id, fields.company, fields.liCompanyUrl, fields.companyLinkedInId]
    );
    console.log(`[Enrichment] Upserted company "${fields.company}" (id=${fields.companyLinkedInId}) for campaign ${campaign_id}`);
  } catch (err) {
    // Non-fatal — log but don't fail enrichment
    console.warn(`[Enrichment] upsertCampaignCompany failed for contact ${contactId}: ${err.message}`);
  }
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
        ? JSON.parse(row.profile_data) : row.profile_data;

      const fields = extractFields(profile, row.id);

      await db.query(
        `UPDATE contacts SET
           first_name     = COALESCE(NULLIF($1,''),  first_name),
           last_name      = COALESCE(NULLIF($2,''),  last_name),
           title          = COALESCE(NULLIF($3,''),  title),
           company        = COALESCE(NULLIF($4,''),  company),
           location       = COALESCE(NULLIF($5,''),  location),
           email          = COALESCE(NULLIF($6,''),  email),
           website        = COALESCE(NULLIF($7,''),  website),
           li_company_url = COALESCE(NULLIF($8,''),  li_company_url),
           provider_id    = COALESCE(NULLIF($9,''),  provider_id),
           member_urn     = COALESCE(NULLIF($10,''), member_urn)
         WHERE id = $11`,
        [fields.firstName, fields.lastName, fields.title, fields.company,
         fields.location, fields.email, fields.website, fields.liCompanyUrl,
         fields.providerId, fields.memberUrn, row.id]
      );

      // Also upsert into campaign_companies
      await upsertCampaignCompany(row.id, fields);
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

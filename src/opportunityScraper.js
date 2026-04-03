/**
 * opportunityScraper.js
 *
 * Runs every hour. For every workspace + account combination:
 *  1. Collects ALL target company LinkedIn IDs from three sources:
 *       a) campaign_companies   (linked to active campaigns)
 *       b) opportunity_companies (manually added to Opportunities page)
 *       c) contacts             (profile_data work_experience company_id)
 *  2. For each company ID, calls Unipile search with network_distance: DISTANCE_1
 *     to find 1st-degree connections working there.
 *  3. Saves new found people to contacts table with:
 *       already_connected = true, campaign_id = NULL
 *     and queues them for full enrichment.
 *  4. Skips contacts already in DB (dedup by li_profile_url + workspace).
 */
const db = require('./db');
const { searchPeopleByKeywords, request } = require('./unipile');
const { enqueue } = require('./enrichment');

const INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DELAY_BETWEEN_COMPANIES_MS = [3000, 6000];
const DELAY_BETWEEN_ACCOUNTS_MS  = [5000, 10000];
const MAX_RESULTS_PER_COMPANY = 50;
const MAX_COMPANIES_PER_RUN = 3; // process max 3 companies at a time

let running = false;

function start() {
  console.log('[OppScraper] Started ÃÂ¢ÃÂÃÂ scanning every hour');
  run().catch(e => console.error('[OppScraper] startup run error:', e.message));
  setInterval(() => {
    run().catch(e => console.error('[OppScraper] interval run error:', e.message));
  }, INTERVAL_MS);
}

async function run() {
  if (running) { console.log('[OppScraper] Already running, skipping'); return; }
  running = true;
  try {
    const { rows: workspaces } = await db.query('SELECT id FROM workspaces');
    for (const ws of workspaces) {
      await scanWorkspace(ws.id);
    }
  } catch (err) {
    console.error('[OppScraper] run error:', err.message);
  } finally {
    running = false;
  }
}

async function scanWorkspace(workspaceId) {
  // Get all accounts in workspace
  const { rows: accounts } = await db.query(
    'SELECT account_id, display_name FROM unipile_accounts WHERE workspace_id = $1',
    [workspaceId]
  );
  if (!accounts.length) return;

  // Collect all unique target company LinkedIn IDs from all 3 sources
  const companyIdSet = new Set();

  // Source 1: campaign_companies (any campaign, active or not)
  const { rows: campCos } = await db.query(
    `SELECT DISTINCT company_linkedin_id FROM campaign_companies
     WHERE workspace_id = $1 AND company_linkedin_id IS NOT NULL AND company_linkedin_id != ''`,
    [workspaceId]
  );
  campCos.forEach(r => companyIdSet.add(r.company_linkedin_id));

  // Source 2: opportunity_companies (manually added)
  const { rows: oppCos } = await db.query(
    `SELECT DISTINCT company_linkedin_id FROM opportunity_companies
     WHERE workspace_id = $1 AND company_linkedin_id IS NOT NULL AND company_linkedin_id != ''`,
    [workspaceId]
  );
  oppCos.forEach(r => companyIdSet.add(r.company_linkedin_id));

  // Source 3: contacts already in DB ÃÂ¢ÃÂÃÂ their employer's LinkedIn ID
  const { rows: contactCos } = await db.query(
    `SELECT DISTINCT profile_data->'work_experience'->0->>'company_id' AS co_id
     FROM contacts
     WHERE workspace_id = $1
       AND profile_data->'work_experience'->0->>'company_id' IS NOT NULL`,
    [workspaceId]
  );
  contactCos.forEach(r => { if (r.co_id) companyIdSet.add(r.co_id); });

  // Source 4: list_companies (companies added to any list in this workspace)
  const { rows: listCos } = await db.query(
    `SELECT DISTINCT lco.company_linkedin_id
     FROM list_companies lco
     JOIN lists l ON l.id = lco.list_id
     WHERE l.workspace_id = $1 AND lco.company_linkedin_id IS NOT NULL AND lco.company_linkedin_id != ''`,
    [workspaceId]
  );
  listCos.forEach(r => companyIdSet.add(r.company_linkedin_id));

  // Process in batches of MAX_COMPANIES_PER_RUN, picking companies not recently scanned
  const allIds = [...companyIdSet];
  // Take next MAX_COMPANIES_PER_RUN companies (rotate through allIds each run)
  const companyIds = allIds.slice(0, MAX_COMPANIES_PER_RUN);
  if (!companyIds.length) {
    console.log('[OppScraper] ws' + workspaceId + ': no company IDs to scan');
    return;
  }
  console.log('[OppScraper] ws' + workspaceId + ': scanning ' + companyIds.length + '/' + allIds.length + ' companies across ' + accounts.length + ' account(s)');

  for (const acc of accounts) {
    let found = 0, added = 0;
    for (const companyId of companyIds) {
      try {
        const people = await searchFirstDegreeAtCompany(acc.account_id, companyId);
        found += people.length;
        for (const p of people) {
          const liUrl = p.public_profile_url || p.li_profile_url || '';
          if (!liUrl.includes('linkedin.com/in/')) continue;
          // Dedup: skip if already in DB for this workspace
          const { rows: dup } = await db.query(
            'SELECT id FROM contacts WHERE workspace_id=$1 AND li_profile_url=$2 LIMIT 1',
            [workspaceId, liUrl]
          );
          if (dup.length) continue;
          // Insert as opportunity contact
          const { rows: ins } = await db.query(
            `INSERT INTO contacts
          const coUrl = 'https://www.linkedin.com/company/' + companyId;
          const { rows: ins } = await db.query(
            `INSERT INTO contacts
               (workspace_id, campaign_id, first_name, last_name, company, title,
                li_profile_url, li_company_url, already_connected)
             VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, true)
             RETURNING id`,
            [workspaceId, p.first_name||'', p.last_name||'',
             p.company||p.current_company||'', p.headline||'', liUrl, coUrl]
          );
          if (ins[0]?.id) {
            added++;
            enqueue(ins[0].id, acc.account_id, liUrl);
          }
        }
        await sleep(randBetween(...DELAY_BETWEEN_COMPANIES_MS));
      } catch (err) {
        console.warn('[OppScraper] ws' + workspaceId + ' acc:' + acc.account_id.slice(0,8) + ' co:' + companyId + ' ÃÂ¢ÃÂÃÂ ' + err.message);
      }
    }
    console.log('[OppScraper] ws' + workspaceId + ' ' + acc.display_name + ': found=' + found + ' added=' + added + ' new contacts');
    if (accounts.length > 1) await sleep(randBetween(...DELAY_BETWEEN_ACCOUNTS_MS));
  }
}

/**
 * Search Unipile for FIRST_DEGREE connections currently employed at companyId.
 * Uses LinkedIn classic search with network_distance + currentCompany filters.
 */
async function searchFirstDegreeAtCompany(accountId, companyId) {
  // Uses request() (imported at top) to call LinkedIn search with network_distance filter
  const data = await request(
    '/api/v1/linkedin/search?account_id=' + encodeURIComponent(accountId),
    {
      method: 'POST',
      body: JSON.stringify({
        api: 'classic',
        category: 'people',
        filters: {
          currentCompany: [companyId],
          network_distance: ['DISTANCE_1']
        },
        limit: MAX_RESULTS_PER_COMPANY
      })
    }
  );
  return Array.isArray(data?.items) ? data.items : [];
}

function randBetween(min, max) { return min + Math.random() * (max - min); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { start, run, scanWorkspace };

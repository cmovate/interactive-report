/**
 * syncOpportunities.js
 *
 * Runs every 2 hours.
 * For each workspace, for each account:
 *   ONE search call with ALL company IDs + DISTANCE_1 filter.
 *   2 calls per workspace (one per account) instead of account × company.
 */

const db      = require('../db');
const unipile = require('../unipile');

async function handler() {
  const { rows: workspaces } = await db.query(`
    SELECT DISTINCT lc.workspace_id
    FROM list_companies lc
    JOIN lists l ON l.id = lc.list_id AND l.workspace_id = lc.workspace_id
    WHERE l.type = 'companies'
      AND lc.company_linkedin_id IS NOT NULL
      AND lc.company_linkedin_id != ''
  `);

  for (const { workspace_id } of workspaces) {
    const { rows: accounts } = await db.query(
      `SELECT account_id, display_name FROM unipile_accounts WHERE workspace_id=$1 ORDER BY id`,
      [workspace_id]
    );
    if (!accounts.length) continue;

    // Get all company IDs for this workspace in one query
    const { rows: companies } = await db.query(`
      SELECT DISTINCT lc.company_linkedin_id, lc.company_name
      FROM list_companies lc
      JOIN lists l ON l.id = lc.list_id AND l.workspace_id = lc.workspace_id
      WHERE lc.workspace_id = $1
        AND l.type = 'companies'
        AND lc.company_linkedin_id IS NOT NULL
        AND lc.company_linkedin_id != ''
    `, [workspace_id]);

    if (!companies.length) continue;

    // Build lookup: company_linkedin_id → company_name
    const companyMap = {};
    for (const c of companies) companyMap[c.company_linkedin_id] = c.company_name;
    const allCompanyIds = companies.map(c => c.company_linkedin_id);

    console.log(`[Opportunities] WS${workspace_id}: ${allCompanyIds.length} companies, ${accounts.length} accounts`);

    for (const account of accounts) {
      try {
        // ONE search call per account — all company IDs + DISTANCE_1
        const data = await unipile._request(
          '/api/v1/linkedin/search?account_id=' + encodeURIComponent(account.account_id),
          {
            method: 'POST',
            body: JSON.stringify({
              api: 'classic',
              category: 'people',
              filters: {
                currentCompany: allCompanyIds.map(String),
                network_distance: ['DISTANCE_1']
              },
              limit: 100
            })
          }
        );

        const people = Array.isArray(data?.items) ? data.items : [];
        console.log(`[Opportunities] WS${workspace_id} ${account.display_name}: ${people.length} 1st-degree connections found across all companies`);

        for (const p of people) {
          const pid = p.public_identifier || p.id;
          if (!pid || pid.startsWith('ACo')) continue; // skip non-slug IDs

          // Determine which company this person works at
          const companyId = p.current_positions?.[0]?.company_id
            || allCompanyIds.find(id => p.headline?.includes(companyMap[id]) || p.current_positions?.some(pos => pos.company_id === id));
          const companyName = companyId ? companyMap[companyId] : (p.current_positions?.[0]?.company || '');
          const liUrl = `https://www.linkedin.com/in/${pid}`;

          await db.query(`
            INSERT INTO opportunity_contacts (
              workspace_id, company_linkedin_id, company_name,
              li_profile_url, provider_id,
              first_name, last_name, title,
              connected_via_account_id, connected_via_name,
              last_seen_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
            ON CONFLICT (workspace_id, li_profile_url, connected_via_account_id)
            DO UPDATE SET
              last_seen_at = NOW(),
              title      = COALESCE(NULLIF(EXCLUDED.title,''),      opportunity_contacts.title),
              first_name = COALESCE(NULLIF(EXCLUDED.first_name,''), opportunity_contacts.first_name),
              last_name  = COALESCE(NULLIF(EXCLUDED.last_name,''),  opportunity_contacts.last_name)
          `, [
            workspace_id,
            companyId || '',
            companyName,
            liUrl,
            pid,
            p.first_name || p.firstName || '',
            p.last_name  || p.lastName  || '',
            p.headline   || p.title     || p.occupation || '',
            account.account_id,
            account.display_name,
          ]);
        }

        // Enrich names in background for nameless contacts
        for (const p of people) {
          if (p.first_name || p.firstName) continue;
          const pid = p.public_identifier || p.id;
          if (!pid || pid.startsWith('ACo')) continue;
          const liUrl = `https://www.linkedin.com/in/${pid}`;
          unipile.enrichProfile(account.account_id, liUrl).then(async enriched => {
            if (!enriched?.first_name && !enriched?.firstName) return;
            await db.query(`
              UPDATE opportunity_contacts SET
                first_name = COALESCE(NULLIF($2,''), first_name),
                last_name  = COALESCE(NULLIF($3,''), last_name),
                title      = COALESCE(NULLIF($4,''), title)
              WHERE workspace_id=$1 AND li_profile_url=$5
            `, [workspace_id,
                enriched.first_name || enriched.firstName || '',
                enriched.last_name  || enriched.lastName  || '',
                enriched.headline   || enriched.occupation || '',
                liUrl]);
          }).catch(() => {});
          await new Promise(r => setTimeout(r, 200));
        }

        // Short delay between accounts
        await new Promise(r => setTimeout(r, 3000));

      } catch(e) {
        console.warn(`[Opportunities] WS${workspace_id} ${account.display_name}: ${e.message}`);
      }
    }
  }
}

module.exports = { handler };

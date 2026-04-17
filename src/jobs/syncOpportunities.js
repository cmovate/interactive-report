/**
 * syncOpportunities.js
 *
 * Runs every 2 hours.
 *
 * For each workspace:
 *   1. Get all companies in list_companies with a resolved company_linkedin_id
 *   2. For each account in the workspace:
 *      - Call searchFirstDegreeAtCompany — guaranteed DISTANCE_1 only
 *      - For each result: upsert into opportunity_contacts table
 *   3. Only contacts returned by this search are shown in Opportunities
 *      — no guessing, no post-hoc filtering
 */

const db      = require('../db');
const unipile = require('../unipile');

async function handler() {
  // Get all workspaces that have companies lists with resolved IDs
  const { rows: workspaces } = await db.query(`
    SELECT DISTINCT lc.workspace_id
    FROM list_companies lc
    JOIN lists l ON l.id = lc.list_id AND l.workspace_id = lc.workspace_id
    WHERE l.type = 'companies'
      AND lc.company_linkedin_id IS NOT NULL
      AND lc.company_linkedin_id != ''
  `);

  let totalAdded = 0;

  for (const { workspace_id } of workspaces) {
    // Get all accounts for this workspace
    const { rows: accounts } = await db.query(
      `SELECT account_id, display_name FROM unipile_accounts WHERE workspace_id = $1 ORDER BY id`,
      [workspace_id]
    );
    if (!accounts.length) continue;

    // Get all companies with resolved IDs for this workspace
    const { rows: companies } = await db.query(`
      SELECT DISTINCT ON (lc.company_linkedin_id)
        lc.id, lc.company_name, lc.company_linkedin_id, lc.li_company_url, lc.list_id
      FROM list_companies lc
      JOIN lists l ON l.id = lc.list_id AND l.workspace_id = lc.workspace_id
      WHERE lc.workspace_id = $1
        AND l.type = 'companies'
        AND lc.company_linkedin_id IS NOT NULL
        AND lc.company_linkedin_id != ''
      ORDER BY lc.company_linkedin_id, lc.id ASC
    `, [workspace_id]);

    console.log(`[Opportunities] WS${workspace_id}: ${companies.length} companies, ${accounts.length} accounts`);

    for (const company of companies) {
      for (const account of accounts) {
        try {
          // This uses DISTANCE_1 filter — only genuine 1st-degree connections
          const people = await unipile.searchFirstDegreeAtCompany(
            account.account_id,
            company.company_linkedin_id,
            50
          );

          for (const p of people) {
            const pid = p.public_identifier || p.identifier || p.provider_id;
            if (!pid) continue;
            const liUrl = `https://www.linkedin.com/in/${pid}`;

            // Upsert into opportunity_contacts
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
                title = COALESCE(NULLIF(EXCLUDED.title,''), opportunity_contacts.title),
                first_name = COALESCE(NULLIF(EXCLUDED.first_name,''), opportunity_contacts.first_name),
                last_name  = COALESCE(NULLIF(EXCLUDED.last_name,''),  opportunity_contacts.last_name)
            `, [
              workspace_id,
              company.company_linkedin_id,
              company.company_name,
              liUrl,
              pid,
              p.first_name || p.firstName || '',
              p.last_name  || p.lastName  || '',
              p.headline   || p.title     || p.occupation || '',
              account.account_id,
              account.display_name,
            ]);
            totalAdded++;
          }

          if (people.length > 0) {
            console.log(`[Opportunities] WS${workspace_id} ${account.display_name} @ ${company.company_name}: ${people.length} 1st-degree connections`);
            // Queue enrichment for contacts missing names
            for (const p of people) {
              const pid = p.public_identifier || p.identifier || p.provider_id;
              if (!pid) continue;
              const liUrl = `https://www.linkedin.com/in/${pid}`;
              if (!p.first_name && !p.firstName) {
                // Update names via enrichProfile in background
                unipile.enrichProfile(account.account_id, liUrl).then(async enriched => {
                  if (enriched?.first_name || enriched?.firstName) {
                    await db.query(`
                      UPDATE opportunity_contacts SET
                        first_name = COALESCE(NULLIF($2,''), first_name),
                        last_name  = COALESCE(NULLIF($3,''), last_name),
                        title      = COALESCE(NULLIF($4,''), title)
                      WHERE workspace_id=$1 AND li_profile_url=$5
                    `, [
                      workspace_id,
                      enriched.first_name || enriched.firstName || '',
                      enriched.last_name  || enriched.lastName  || '',
                      enriched.headline   || enriched.occupation || '',
                      liUrl
                    ]);
                  }
                }).catch(() => {});
                await new Promise(r => setTimeout(r, 500));
              }
            }
          }

          // Rate limit between calls (avoid 429)
          await new Promise(r => setTimeout(r, 3000));
        } catch(e) {
          console.warn(`[Opportunities] WS${workspace_id} ${account.display_name} @ ${company.company_name}: ${e.message}`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }
  }

  if (totalAdded > 0) {
    console.log(`[Opportunities] Sync complete — ${totalAdded} contact records upserted`);
  }
}

module.exports = { handler };

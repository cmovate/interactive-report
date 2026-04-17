/**
 * syncOpportunities.js — runs every 2 hours
 *
 * For each company: search PEOPLE with company + DISTANCE_1.
 * Alternates between accounts per company so no single account
 * gets rate-limited.
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

    const { rows: companies } = await db.query(`
      SELECT DISTINCT ON (lc.company_linkedin_id)
        lc.company_linkedin_id, lc.company_name
      FROM list_companies lc
      JOIN lists l ON l.id = lc.list_id AND l.workspace_id = lc.workspace_id
      WHERE lc.workspace_id = $1
        AND l.type = 'companies'
        AND lc.company_linkedin_id IS NOT NULL
        AND lc.company_linkedin_id != ''
      ORDER BY lc.company_linkedin_id
    `, [workspace_id]);

    console.log(`[Opportunities] WS${workspace_id}: ${companies.length} companies, ${accounts.length} accounts — alternating`);

    for (let i = 0; i < companies.length; i++) {
      const company = companies[i];
      // Alternate account per company
      const account = accounts[i % accounts.length];

      try {
        const data = await unipile._request(
          '/api/v1/linkedin/search?account_id=' + encodeURIComponent(account.account_id),
          {
            method: 'POST',
            body: JSON.stringify({
              api: 'classic',
              category: 'people',
              filters: {
                currentCompany: [String(company.company_linkedin_id)],
                network_distance: ['DISTANCE_1']
              },
              limit: 50
            })
          }
        );

        const people = Array.isArray(data?.items) ? data.items : [];

        if (people.length > 0) {
          console.log(`[Opportunities] ${account.display_name} @ ${company.company_name}: ${people.length} connections`);
        }

        for (const p of people) {
          const pid = p.public_identifier || p.identifier;
          if (!pid) continue;
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
            company.company_linkedin_id,
            company.company_name,
            liUrl, pid,
            p.first_name || p.firstName || '',
            p.last_name  || p.lastName  || '',
            p.headline   || p.title     || '',
            account.account_id,
            account.display_name,
          ]);
        }

        await new Promise(r => setTimeout(r, 1500));

      } catch(e) {
        console.warn(`[Opportunities] ${account.display_name} @ ${company.company_name}: ${e.message}`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  console.log('[Opportunities] Sync complete');
}

module.exports = { handler };

/**
 * src/scheduler.js
 * Auto-scan scheduler — runs scan-opportunities for all workspaces every 6 hours.
 * Finds 1st-degree connections at list companies and populates connected_via.
 */
const db = require('./db');
const { searchPeopleByCompany } = require('./unipile');
const { enqueue } = require('./enrichment');

const SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STARTUP_DELAY_MS = 90 * 1000;           // 90 seconds after boot

async function scanListOpportunities(workspaceId, listId) {
  try {
    const { rows: companies } = await db.query(
      'SELECT id, company_name, li_company_url, company_linkedin_id FROM list_companies WHERE list_id=$1 AND workspace_id=$2 AND company_linkedin_id IS NOT NULL AND company_linkedin_id != \'\'',
      [listId, workspaceId]
    );
    if (!companies.length) return;

    const { rows: accounts } = await db.query(
      'SELECT account_id, display_name FROM unipile_accounts WHERE workspace_id=$1',
      [workspaceId]
    );
    if (!accounts.length) return;

    console.log('[Scheduler] Scanning ws=' + workspaceId + ' list=' + listId + ': ' + companies.length + ' companies, ' + accounts.length + ' accounts');

    let totalFound = 0, totalAdded = 0, totalUpdated = 0;

    for (const co of companies) {
      try {
        let companyId = co.company_linkedin_id;
        if (typeof companyId === 'string' && companyId.startsWith('{')) {
          try { companyId = JSON.parse(companyId).id || companyId; } catch(e) {}
        }
        if (!companyId) continue;

        const contactsAcrossAccounts = [];

        for (const acc of accounts) {
          try {
            const all = await searchPeopleByCompany(acc.account_id, companyId, co.company_name, [], 50);
            const firstDeg = all.filter(p =>
              !p.member_distance || p.member_distance === 'DISTANCE_1' || p.distance === 1 || p.distance === '1'
            );
            for (const p of firstDeg) {
              const pid = p.public_identifier || p.identifier;
              if (!pid) continue;
              const url = 'https://www.linkedin.com/in/' + pid;
              const ex = contactsAcrossAccounts.find(c => c.li_profile_url === url);
              if (ex) {
                if (!ex.connected_via.find(v => v.account_id === acc.account_id))
                  ex.connected_via.push({ account_id: acc.account_id, name: acc.display_name });
              } else {
                contactsAcrossAccounts.push({
                  li_profile_url: url,
                  first_name: p.first_name || '',
                  last_name: p.last_name || '',
                  headline: p.headline || '',
                  company: co.company_name,
                  provider_id: pid,
                  connected_via: [{ account_id: acc.account_id, name: acc.display_name }]
                });
              }
            }
            await new Promise(r => setTimeout(r, 1200));
          } catch(e) {
            console.warn('[Scheduler] acc err:', acc.display_name, co.company_name, e.message);
          }
        }

        totalFound += contactsAcrossAccounts.length;

        for (const c of contactsAcrossAccounts) {
          try {
            const { rows: dup } = await db.query(
              'SELECT id, connected_via FROM contacts WHERE workspace_id=$1 AND li_profile_url=$2 LIMIT 1',
              [workspaceId, c.li_profile_url]
            );
            if (dup.length) {
              const exVia = Array.isArray(dup[0].connected_via) ? dup[0].connected_via : [];
              let changed = false;
              c.connected_via.forEach(v => {
                if (!exVia.some(ev => ev.account_id === v.account_id)) { exVia.push(v); changed = true; }
              });
              if (changed || !dup[0].connected_via?.length) {
                await db.query(
                  'UPDATE contacts SET connected_via=$2::jsonb, title=COALESCE(NULLIF($3,\'\'\'), title) WHERE id=$1',
                  [dup[0].id, JSON.stringify(exVia), c.headline || '']
                );
                totalUpdated++;
              }
            } else {
              const { rows: ins } = await db.query(
                'INSERT INTO contacts (workspace_id,campaign_id,first_name,last_name,title,company,li_profile_url,connected_via,already_connected) VALUES ($1,NULL,$2,$3,$4,$5,$6,$7::jsonb,true) ON CONFLICT DO NOTHING RETURNING id',
                [workspaceId, c.first_name, c.last_name, c.headline, c.company, c.li_profile_url, JSON.stringify(c.connected_via)]
              );
              if (ins[0]?.id) { enqueue(ins[0].id, accounts[0].account_id, c.li_profile_url); totalAdded++; }
            }
          } catch(e) { console.warn('[Scheduler] upsert err:', e.message); }
        }
        await new Promise(r => setTimeout(r, 2000));
      } catch(e) {
        console.warn('[Scheduler] company err:', co.company_name, e.message);
      }
    }
    console.log('[Scheduler] Done ws=' + workspaceId + ' list=' + listId + ': found=' + totalFound + ' added=' + totalAdded + ' updated=' + totalUpdated);
  } catch(e) {
    console.error('[Scheduler] scan error ws=' + workspaceId + ' list=' + listId + ':', e.message);
  }
}

async function runAllWorkspaceScans() {
  try {
    // Find all lists of type 'companies' with at least one company that has an ID
    const { rows: lists } = await db.query(
      `SELECT DISTINCT l.id AS list_id, l.workspace_id
        FROM lists l
        JOIN list_companies lc ON lc.list_id = l.id
        WHERE l.type = 'companies'
          AND lc.company_linkedin_id IS NOT NULL
          AND lc.company_linkedin_id != ''`
    );
    for (const row of lists) {
      await scanListOpportunities(row.workspace_id, row.list_id);
    }
  } catch(e) {
    console.error('[Scheduler] runAll error:', e.message);
  }
}

function startScheduler() {
  console.log('[Scheduler] Started — first scan in 90s, then every 6h');

  // Initial scan after startup
  setTimeout(() => {
    runAllWorkspaceScans().catch(e => console.error('[Scheduler] initial scan error:', e.message));
  }, STARTUP_DELAY_MS);

  // Recurring scan every 6 hours
  setInterval(() => {
    runAllWorkspaceScans().catch(e => console.error('[Scheduler] scheduled scan error:', e.message));
  }, SCAN_INTERVAL_MS);
}

module.exports = { startScheduler, scanListOpportunities, runAllWorkspaceScans };

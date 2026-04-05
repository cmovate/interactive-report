/UPDATE contacts SET connected_via=$2::jsonb, li_company_url=COALESCE(NULLIF($3,''), li_company_url), title=COALESCE(NULLIF($4,''), title) WHERE id=$1',
              [dup[0].id, JSON.stringify(exVia), co.li_company_url||'', c.headline||''])UPDATE contacts SET connected_via=$2::jsonb, title=COALESCE(NULLIF($3,\'\'\'), title) WHERE id=$1',
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

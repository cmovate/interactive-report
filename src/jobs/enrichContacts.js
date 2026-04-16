/**
 * src/jobs/enrichContacts.js — Nightly enrichment (02:00)
 * Replaces: enrichment.js in-memory queue
 */
const db = require('../db');
const unipile = require('../unipile');

const BATCH = 50;

async function handler() {
  // Get contacts needing enrichment (no provider_id OR enriched >30 days ago)
  const { rows: contacts } = await db.query(`
    SELECT c.id, c.li_profile_url, c.workspace_id,
           COALESCE(camp.account_id, ua.account_id) AS account_id
    FROM contacts c
    LEFT JOIN campaigns camp ON camp.id = c.campaign_id
    LEFT JOIN LATERAL (
      SELECT account_id FROM unipile_accounts
      WHERE workspace_id = c.workspace_id
      LIMIT 1
    ) ua ON true
    WHERE c.li_profile_url LIKE '%linkedin.com/in/%'
      AND (c.provider_id IS NULL OR c.provider_id = ''
           OR c.enriched_at < NOW() - INTERVAL '30 days')
    ORDER BY c.created_at ASC
    LIMIT $1
  `, [BATCH]);

  let enriched = 0;
  for (const c of contacts) {
    if (!c.account_id) continue;
    try {
      const profile = await unipile.enrichProfile(c.account_id, c.li_profile_url);
      if (!profile) continue;

      const providerId = profile.provider_id || '';
      const memberUrn  = profile.member_urn || '';
      const firstName  = profile.first_name || '';
      const lastName   = profile.last_name  || '';
      const title      = profile.headline || profile.title || '';
      const location   = profile.location || '';

      // Detect already_connected
      const dist = String(profile.network_distance || '').toUpperCase();
      const alreadyConnected = ['FIRST_DEGREE', 'DISTANCE_1', '1'].includes(dist) ||
        profile.relation_type === 1 || profile.degree === 1;

      await db.query(`
        UPDATE contacts SET
          provider_id        = COALESCE(NULLIF($2,''), provider_id),
          member_urn         = COALESCE(NULLIF($3,''), member_urn),
          first_name         = COALESCE(NULLIF($4,''), first_name),
          last_name          = COALESCE(NULLIF($5,''), last_name),
          title              = COALESCE(NULLIF($6,''), title),
          location           = COALESCE(NULLIF($7,''), location),
          already_connected  = $8,
          enriched_at        = NOW(),
          profile_data       = $9
        WHERE id = $1
      `, [c.id, providerId, memberUrn, firstName, lastName, title, location,
          alreadyConnected, JSON.stringify({ headline: title, location })]);

      enriched++;
    } catch (err) {
      console.warn(`[EnrichContacts] contact ${c.id}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 5000 + Math.random() * 5000));
  }

  if (enriched > 0) console.log(`[EnrichContacts] Enriched ${enriched}/${contacts.length}`);
}

module.exports = { handler };

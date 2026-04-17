/**
 * src/routes/opportunities.js
 *
 * Opportunities tab — shows 1st-degree LinkedIn connections at target companies.
 * Data comes exclusively from opportunity_contacts table (populated by syncOpportunities job).
 * Source companies come from list_companies (Lists tab).
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db');

// GET /api/opportunities?workspace_id=X&list_id=X&campaign_id=X
// Returns companies grouped with their verified 1st-degree connections
router.get('/', async (req, res) => {
  try {
    const { workspace_id, list_id } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });

    // Get all companies for this workspace (optionally filtered by list)
    let companyQuery = `
      SELECT DISTINCT ON (lc.company_linkedin_id)
        lc.id, lc.company_name, lc.company_linkedin_id, lc.li_company_url, lc.list_id,
        l.name AS list_name
      FROM list_companies lc
      JOIN lists l ON l.id = lc.list_id AND l.workspace_id = lc.workspace_id
      WHERE lc.workspace_id = $1
        AND l.type = 'companies'
        AND lc.company_linkedin_id IS NOT NULL
        AND lc.company_linkedin_id != ''
    `;
    const params = [workspace_id];
    if (list_id) {
      params.push(list_id);
      companyQuery += ` AND lc.list_id = $${params.length}`;
    }
    companyQuery += ` ORDER BY lc.company_linkedin_id, lc.id ASC`;

    const { rows: companies } = await db.query(companyQuery, params);

    // Get all opportunity contacts for this workspace
    const { rows: contacts } = await db.query(`
      SELECT
        oc.company_linkedin_id,
        oc.first_name, oc.last_name, oc.title,
        oc.li_profile_url, oc.provider_id,
        oc.chat_id,
        oc.connected_via_account_id,
        oc.connected_via_name,
        oc.last_seen_at
      FROM opportunity_contacts oc
      WHERE oc.workspace_id = $1
      ORDER BY oc.company_linkedin_id, oc.connected_via_name
    `, [workspace_id]);

    // Get all lists for filter dropdown
    const { rows: lists } = await db.query(`
      SELECT l.id, l.name, COUNT(lc.id)::int AS company_count
      FROM lists l
      LEFT JOIN list_companies lc ON lc.list_id = l.id AND lc.workspace_id = l.workspace_id
      WHERE l.workspace_id = $1 AND l.type = 'companies'
      GROUP BY l.id, l.name ORDER BY l.name
    `, [workspace_id]);

    // Get accounts for this workspace
    const { rows: accounts } = await db.query(
      `SELECT account_id, display_name FROM unipile_accounts WHERE workspace_id=$1 ORDER BY id`,
      [workspace_id]
    );

    // Group contacts by company
    const contactsByCompany = {};
    for (const c of contacts) {
      const key = c.company_linkedin_id;
      if (!contactsByCompany[key]) contactsByCompany[key] = [];
      contactsByCompany[key].push(c);
    }

    // Build result — only companies that have at least 1 connection
    const result = companies
      .map(co => ({
        ...co,
        connections: contactsByCompany[co.company_linkedin_id] || []
      }))
      .filter(co => co.connections.length > 0)
      .sort((a, b) => b.connections.length - a.connections.length);

    res.json({ companies: result, lists, accounts, total_companies: result.length });
  } catch(e) {
    console.error('[Opportunities] GET error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/opportunities/stats?workspace_id=X
router.get('/stats', async (req, res) => {
  try {
    const { workspace_id } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });
    const { rows } = await db.query(`
      SELECT
        COUNT(DISTINCT company_linkedin_id) AS companies_with_connections,
        COUNT(*)                            AS total_connections,
        COUNT(DISTINCT connected_via_account_id) AS accounts_with_connections,
        MAX(last_seen_at)                   AS last_synced_at
      FROM opportunity_contacts WHERE workspace_id=$1
    `, [workspace_id]);
    res.json(rows[0] || {});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

// Helper: send and then sync inbox in background
async function sendAndSync(res, workspace_id, accId, chatId, method, sendFn) {
  await sendFn();
  res.json({ success: true, chat_id: chatId, method });
  // Trigger inbox sync in background so message appears in Inbox immediately
  const fetch2 = require('node-fetch');
  const BASE = process.env.RAILWAY_PUBLIC_DOMAIN
    ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
    : 'http://localhost:' + (process.env.PORT || 3000);
  fetch2(BASE + '/api/inbox/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace_id, account_id: accId })
  }).catch(() => {});
}

// Trigger inbox sync in background after sending a message
function triggerInboxSync(workspace_id, account_id) {
  // Use internal HTTP call so inbox_threads table gets updated immediately
  const http = require('http');
  const body = JSON.stringify({ workspace_id: parseInt(workspace_id), account_id });
  const req = http.request({
    hostname: 'localhost',
    port: parseInt(process.env.PORT || 3000),
    path: '/api/inbox/sync',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, () => {});
  req.on('error', () => {});
  req.write(body);
  req.end();
}

// After successful send: ensure contact + thread exist in inbox tables
async function upsertContactToInbox(workspace_id, account_id, provider_id, li_profile_url, chat_id, first_name, last_name, title) {
  try {
    // 1. Upsert contact into contacts table (campaign_id=NULL = workspace pool)
    const { rows: existing } = await db.query(
      `SELECT id FROM contacts WHERE workspace_id=$1 AND li_profile_url=$2 LIMIT 1`,
      [workspace_id, li_profile_url]
    );
    let contactId;
    if (existing.length) {
      contactId = existing[0].id;
      // Update chat_id if we have it
      if (chat_id) {
        await db.query(`UPDATE contacts SET chat_id=$1 WHERE id=$2 AND (chat_id IS NULL OR chat_id='')`,
          [chat_id, contactId]);
      }
    } else {
      const { rows: ins } = await db.query(`
        INSERT INTO contacts (workspace_id, campaign_id, first_name, last_name, title, li_profile_url, provider_id, chat_id, already_connected)
        VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, true)
        ON CONFLICT (workspace_id, li_profile_url) DO UPDATE
          SET chat_id = COALESCE(NULLIF(EXCLUDED.chat_id,''), contacts.chat_id),
              already_connected = true
        RETURNING id
      `, [workspace_id, first_name||'', last_name||'', title||'', li_profile_url, provider_id||null, chat_id||null]);
      contactId = ins[0]?.id;
    }
    if (!contactId || !chat_id) return;

    // 2. Upsert inbox_thread — unique key is thread_id
    await db.query(`
      INSERT INTO inbox_threads (workspace_id, contact_id, account_id, thread_id, updated_at, last_message_at)
      VALUES ($1, $2, $3, $4, NOW(), NOW())
      ON CONFLICT (thread_id) DO UPDATE
        SET contact_id     = EXCLUDED.contact_id,
            account_id     = EXCLUDED.account_id,
            workspace_id   = EXCLUDED.workspace_id,
            updated_at     = NOW(),
            last_message_at = NOW()
    `, [workspace_id, contactId, account_id, chat_id]);

    console.log('[Opportunities] upserted to inbox:', li_profile_url, 'chat:', chat_id);
  } catch(e) {
    console.warn('[Opportunities] upsertContactToInbox error:', e.message);
  }
}

// POST /api/opportunities/send-dm
// Sends a LinkedIn DM to a contact. Uses existing chat_id if available,
// otherwise tries to open a new conversation.
router.post('/send-dm', async (req, res) => {
  const { workspace_id, account_id, provider_id, li_profile_url, message } = req.body;
  if (!workspace_id || !message?.trim())
    return res.status(400).json({ error: 'workspace_id and message required' });
  if (!provider_id && !li_profile_url)
    return res.status(400).json({ error: 'provider_id or li_profile_url required' });

  const unipile = require('../unipile');

  try {
    // Resolve ACoXXX from opportunity_contacts (needed for Unipile messaging)
    const slug = provider_id || li_profile_url?.match(/\/in\/([^/?#]+)/)?.[1];
    let acoId = null;
    if (slug) {
      const { rows: ocLookup } = await db.query(
        `SELECT aco_id FROM opportunity_contacts WHERE workspace_id=$1 AND provider_id=$2 AND aco_id IS NOT NULL LIMIT 1`,
        [workspace_id, slug]
      );
      acoId = ocLookup[0]?.aco_id || null;
    }
    // Use ACoXXX if available, else fall back to slug
    const target = acoId || slug;
    if (!target) return res.status(400).json({ error: 'Cannot extract identifier from provider_id or li_profile_url' });

    // Lookup contact info for inbox upsert
    const { rows: ocInfo } = await db.query(
      `SELECT first_name, last_name, title, li_profile_url, aco_id
       FROM opportunity_contacts WHERE workspace_id=$1 AND provider_id=$2 LIMIT 1`,
      [workspace_id, provider_id || slug]
    ).catch(() => ({ rows: [] }));
    const ocContact = ocInfo?.[0] || {};

    // Determine which account to use
    let accId = account_id;
    if (!accId) {
      const { rows } = await db.query(
        `SELECT account_id FROM unipile_accounts WHERE workspace_id=$1 LIMIT 1`, [workspace_id]
      );
      if (!rows.length) return res.status(400).json({ error: 'No accounts in workspace' });
      accId = rows[0].account_id;
    }

    // Step 1: check opportunity_contacts for existing chat_id
    const { rows: ocRows } = await db.query(
      `SELECT chat_id FROM opportunity_contacts
       WHERE workspace_id=$1 AND provider_id=$2 AND connected_via_account_id=$3 AND chat_id IS NOT NULL
       LIMIT 1`,
      [workspace_id, target, accId]
    );
    if (ocRows[0]?.chat_id) {
      await unipile.sendMessage(accId, ocRows[0].chat_id, message.trim());
      upsertContactToInbox(workspace_id, accId, target, ocContact.li_profile_url||li_profile_url, ocRows[0].chat_id, ocContact.first_name, ocContact.last_name, ocContact.title);
      triggerInboxSync(workspace_id, accId);
      return res.json({ success: true, chat_id: ocRows[0].chat_id, method: 'existing_chat' });
    }

    // Step 2: check inbox_threads
    const { rows: thrRows } = await db.query(
      `SELECT t.thread_id FROM inbox_threads t
       JOIN contacts c ON c.id = t.contact_id
       WHERE t.workspace_id=$1 AND t.account_id=$2 AND c.provider_id=$3
       LIMIT 1`,
      [workspace_id, accId, target]
    );
    if (thrRows[0]?.thread_id) {
      await unipile.sendMessage(accId, thrRows[0].thread_id, message.trim());
      triggerInboxSync(workspace_id, accId);
      return res.json({ success: true, chat_id: thrRows[0].thread_id, method: 'inbox_thread' });
    }

    // Step 3: look up existing chat on Unipile
    const chats = await unipile.getChatsByAttendee(accId, target).catch(() => []);
    if (chats.length) {
      const chatId = chats[0].id;
      await unipile.sendMessage(accId, chatId, message.trim());
      // Cache it
      await db.query(
        `UPDATE opportunity_contacts SET chat_id=$1
         WHERE workspace_id=$2 AND provider_id=$3 AND connected_via_account_id=$4`,
        [chatId, workspace_id, target, accId]
      ).catch(() => {});
      upsertContactToInbox(workspace_id, accId, target, ocContact.li_profile_url||li_profile_url, chatId, ocContact.first_name, ocContact.last_name, ocContact.title);
      triggerInboxSync(workspace_id, accId);
      return res.json({ success: true, chat_id: chatId, method: 'unipile_lookup' });
    }

    // Step 4: cold message — need ACoXXX for startDirectMessage
    // If we only have slug, enrich first to get ACoXXX
    let finalTarget = acoId || target;
    if (!finalTarget?.startsWith('ACo')) {
      try {
        const liUrl = ocContact.li_profile_url || li_profile_url ||
          (slug ? `https://www.linkedin.com/in/${slug}` : null);
        if (liUrl) {
          const enriched = await unipile.enrichProfile(accId, liUrl);
          const enrichedAco = enriched?.provider_id?.startsWith('ACo') ? enriched.provider_id : null;
          if (enrichedAco) {
            finalTarget = enrichedAco;
            // Save for next time
            await db.query(
              `UPDATE opportunity_contacts SET aco_id=$1 WHERE workspace_id=$2 AND provider_id=$3`,
              [enrichedAco, workspace_id, slug]
            ).catch(() => {});
          }
        }
      } catch(e) { /* proceed with slug */ }
    }

    // Step 4: start new DM
    const result = await unipile.startDirectMessage(accId, finalTarget, message.trim());
    const chatId = result?.id || result?.chat_id || null;
    if (chatId) {
      await db.query(
        `UPDATE opportunity_contacts SET chat_id=$1
         WHERE workspace_id=$2 AND provider_id=$3 AND connected_via_account_id=$4`,
        [chatId, workspace_id, target, accId]
      ).catch(() => {});
    }
    upsertContactToInbox(workspace_id, accId, target, ocContact.li_profile_url||li_profile_url, chatId, ocContact.first_name, ocContact.last_name, ocContact.title);
    triggerInboxSync(workspace_id, accId);
    return res.json({ success: true, chat_id: chatId, method: 'new_dm' });

  } catch(e) {
    console.error('[Opportunities] send-dm error:', e.message);
    if (e.message?.includes('subscription_required') || e.message?.includes('403')) {
      return res.status(400).json({
        error: 'subscription_required',
        detail: 'No existing conversation found. LinkedIn requires an existing chat to send messages without Premium.'
      });
    }
    res.status(500).json({ error: e.message });
  }
});

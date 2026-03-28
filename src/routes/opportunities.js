/**
 * /api/opportunities
 *
 * Warm leads intelligence — shows LinkedIn connections who work at target companies.
 *
 * Companies come from two sources:
 *   1. campaign_companies — populated automatically from enriched campaign contacts
 *   2. opportunity_companies — manually added by user (independent of any campaign)
 *
 * Both sources are merged and searched together.
 *
 * Routes:
 *   GET  /api/opportunities?workspace_id=X
 *   POST /api/opportunities/companies        — add custom companies (batch)
 *   DELETE /api/opportunities/companies/:id  — remove a custom company
 *   POST /api/opportunities/send-message     — send a direct LinkedIn message
 */

const express  = require('express');
const router   = express.Router();
const db       = require('../db');
const { sendMessage, startDirectMessage } = require('../unipile');

// ── Shared helper: find connected contacts at a given company ─────────────────
async function findContactsAtCompany(workspace_id, company_name, company_linkedin_id) {
  const params = [workspace_id];
  let companyFilter;

  if (company_linkedin_id) {
    params.push(company_linkedin_id, company_name);
    companyFilter = `AND (
      (c.profile_data->'work_experience'->0->>'company_id') = $${params.length - 1}
      OR LOWER(TRIM(c.company)) = LOWER(TRIM($${params.length}))
    )`;
  } else {
    params.push(company_name);
    companyFilter = `AND LOWER(TRIM(c.company)) = LOWER(TRIM($${params.length}))`;
  }

  const { rows } = await db.query(`
    SELECT DISTINCT ON (c.id)
      c.id, c.first_name, c.last_name, c.company, c.title,
      c.li_profile_url, c.email, c.chat_id, c.provider_id,
      c.campaign_id, c.msg_replied, c.invite_approved,
      camp.name   AS campaign_name,
      camp.status AS campaign_status,
      camp.account_id
    FROM contacts c
    JOIN campaigns camp ON camp.id = c.campaign_id
    WHERE c.workspace_id = $1
      AND c.already_connected = true
      ${companyFilter}
    ORDER BY c.id, c.created_at DESC
  `, params);

  return rows;
}

// ── GET /api/opportunities?workspace_id=X ────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { workspace_id } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });

    // 1. Accounts for this workspace (for per-account columns)
    const { rows: accounts } = await db.query(
      `SELECT account_id, display_name FROM unipile_accounts
       WHERE workspace_id = $1 ORDER BY id`,
      [workspace_id]
    );

    // 2. Campaign companies
    const { rows: campRows } = await db.query(`
      SELECT DISTINCT ON (COALESCE(cc.company_linkedin_id, LOWER(cc.company_name)))
        cc.company_name, cc.company_linkedin_id, cc.li_company_url
      FROM campaign_companies cc
      WHERE cc.workspace_id = $1
        AND cc.company_name IS NOT NULL AND cc.company_name != ''
      ORDER BY COALESCE(cc.company_linkedin_id, LOWER(cc.company_name)), cc.company_name
    `, [workspace_id]);

    // 3. Custom (manually-added) companies
    const { rows: customRows } = await db.query(
      `SELECT id AS custom_id, company_name, company_linkedin_id, li_company_url
       FROM opportunity_companies
       WHERE workspace_id = $1
       ORDER BY added_at DESC`,
      [workspace_id]
    );

    // 4. Merge: campaign companies first, dedup by normalized key
    const companyMap = new Map();

    for (const co of campRows) {
      const key = (co.company_linkedin_id || co.company_name.toLowerCase().trim());
      companyMap.set(key, { ...co, source: 'campaign', custom_id: null });
    }
    for (const co of customRows) {
      const key = (co.company_linkedin_id || co.company_name.toLowerCase().trim());
      if (companyMap.has(key)) {
        companyMap.get(key).source      = 'both';
        companyMap.get(key).custom_id   = co.custom_id;
      } else {
        companyMap.set(key, { ...co, source: 'custom' });
      }
    }

    // 5. Find contacts for each merged company
    const result = [];
    for (const co of companyMap.values()) {
      const contacts = await findContactsAtCompany(
        workspace_id, co.company_name, co.company_linkedin_id
      );

      const byAccount = {};
      for (const acc of accounts) byAccount[acc.account_id] = 0;
      for (const c of contacts) {
        if (c.account_id && byAccount[c.account_id] !== undefined) byAccount[c.account_id]++;
      }

      result.push({
        company_name:           co.company_name,
        company_linkedin_id:    co.company_linkedin_id || null,
        li_company_url:         co.li_company_url || null,
        source:                 co.source,
        custom_id:              co.custom_id,
        connections_by_account: byAccount,
        total:                  contacts.length,
        contacts,
      });
    }

    result.sort((a, b) => b.total - a.total || a.company_name.localeCompare(b.company_name));
    res.json({ accounts, companies: result });
  } catch (err) {
    console.error('[Opportunities] GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/opportunities/companies ────────────────────────────────────────
// Body: { workspace_id, companies: [{name, url, linkedin_id}] }
router.post('/companies', async (req, res) => {
  try {
    const { workspace_id, companies } = req.body;
    if (!workspace_id || !Array.isArray(companies) || !companies.length) {
      return res.status(400).json({ error: 'workspace_id and companies[] required' });
    }

    let added = 0, skipped = 0;
    const ids = [];

    for (const co of companies) {
      const name = (co.name || '').trim();
      if (!name) continue;

      // Skip if same name already exists in this workspace (case-insensitive)
      const { rows: existing } = await db.query(
        `SELECT id FROM opportunity_companies
         WHERE workspace_id = $1 AND LOWER(company_name) = LOWER($2) LIMIT 1`,
        [workspace_id, name]
      );
      if (existing.length) { skipped++; continue; }

      const { rows } = await db.query(
        `INSERT INTO opportunity_companies (workspace_id, company_name, li_company_url, company_linkedin_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [workspace_id, name, co.url || null, co.linkedin_id || null]
      );
      ids.push(rows[0].id);
      added++;
    }

    console.log(`[Opportunities] Added ${added} custom companies, skipped ${skipped} duplicates`);
    res.json({ added, skipped, ids });
  } catch (err) {
    console.error('[Opportunities] POST /companies error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/opportunities/companies/:id ──────────────────────────────────
router.delete('/companies/:id', async (req, res) => {
  try {
    const { rowCount } = await db.query(
      'DELETE FROM opportunity_companies WHERE id = $1',
      [req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[Opportunities] DELETE /companies error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/opportunities/send-message ────────────────────────────────────
// Body: { contact_id, text }
router.post('/send-message', async (req, res) => {
  try {
    const { contact_id, text } = req.body;
    if (!contact_id || !text?.trim()) {
      return res.status(400).json({ error: 'contact_id and text are required' });
    }

    const { rows } = await db.query(
      `SELECT c.id, c.first_name, c.last_name, c.provider_id, c.chat_id,
              c.already_connected, camp.account_id
       FROM contacts c
       JOIN campaigns camp ON camp.id = c.campaign_id
       WHERE c.id = $1`,
      [contact_id]
    );

    if (!rows.length) return res.status(404).json({ error: 'Contact not found' });
    const contact = rows[0];

    if (!contact.already_connected)
      return res.status(400).json({ error: 'Contact is not connected on LinkedIn yet' });
    if (!contact.account_id)
      return res.status(400).json({ error: 'No Unipile account for this contact' });
    if (!contact.provider_id && !contact.chat_id)
      return res.status(400).json({ error: 'Contact not enriched — provider_id missing' });

    let chatId = contact.chat_id;
    if (chatId) {
      await sendMessage(contact.account_id, chatId, text.trim());
    } else {
      const result = await startDirectMessage(contact.account_id, contact.provider_id, text.trim());
      chatId = result?.id || result?.chat_id || null;
      if (chatId) await db.query('UPDATE contacts SET chat_id = $1 WHERE id = $2', [chatId, contact_id]);
    }

    await db.query(
      `UPDATE contacts SET
         msg_sent        = true,
         msg_sent_at     = COALESCE(msg_sent_at, NOW()),
         msgs_sent_count = COALESCE(msgs_sent_count, 0) + 1
       WHERE id = $1`,
      [contact_id]
    );

    console.log(`[Opportunities] Message sent to contact ${contact_id}`);
    res.json({ success: true, contact_id, chat_id: chatId });
  } catch (err) {
    console.error('[Opportunities] send-message error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

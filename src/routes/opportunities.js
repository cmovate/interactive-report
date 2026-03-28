/**
 * /api/opportunities
 *
 * "Warm leads" intelligence — for every company we\'re targeting across all campaigns,
 * show which LinkedIn connections (already_connected = true) work there.
 *
 * This lets the user spot known contacts at target accounts and reach out
 * directly without going through a full campaign sequence.
 *
 * GET  /api/opportunities?workspace_id=X
 *   Returns: { accounts, companies: [{ company_name, ... , contacts: [...] }] }
 *
 * POST /api/opportunities/send-message
 *   Body: { contact_id, text }
 *   Sends a direct LinkedIn message to the contact via Unipile.
 */

const express  = require('express');
const router   = express.Router();
const db       = require('../db');
const { sendMessage, startDirectMessage } = require('../unipile');

// GET /api/opportunities?workspace_id=X
router.get('/', async (req, res) => {
  try {
    const { workspace_id } = req.query;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });

    // 1. All Unipile accounts for this workspace (for per-account columns)
    const { rows: accounts } = await db.query(
      `SELECT account_id, display_name
       FROM unipile_accounts
       WHERE workspace_id = $1
       ORDER BY id ASC`,
      [workspace_id]
    );

    // 2. Unique target companies across all campaigns in this workspace
    const { rows: companies } = await db.query(`
      SELECT DISTINCT ON (COALESCE(cc.company_linkedin_id, LOWER(cc.company_name)))
        cc.company_name,
        cc.company_linkedin_id,
        cc.li_company_url
      FROM campaign_companies cc
      WHERE cc.workspace_id = $1
        AND cc.company_name IS NOT NULL
        AND cc.company_name != ''
      ORDER BY COALESCE(cc.company_linkedin_id, LOWER(cc.company_name)), cc.company_name
    `, [workspace_id]);

    // 3. For each company, find already-connected contacts in this workspace
    const result = [];

    for (const company of companies) {
      const params = [workspace_id];
      let companyFilter = '';

      if (company.company_linkedin_id) {
        params.push(company.company_linkedin_id);
        companyFilter = `AND (
          (c.profile_data->'work_experience'->0->>'company_id') = $${params.length}
          OR LOWER(TRIM(c.company)) = LOWER(TRIM($${params.length + 1}))
        )`;
        params.push(company.company_name);
      } else {
        params.push(company.company_name);
        companyFilter = `AND LOWER(TRIM(c.company)) = LOWER(TRIM($${params.length}))`;
      }

      const { rows: contacts } = await db.query(`
        SELECT DISTINCT ON (c.id)
          c.id, c.first_name, c.last_name, c.company, c.title,
          c.li_profile_url, c.email, c.chat_id, c.provider_id,
          c.campaign_id, c.msg_replied, c.invite_approved,
          camp.name  AS campaign_name,
          camp.status AS campaign_status,
          camp.account_id
        FROM contacts c
        JOIN campaigns camp ON camp.id = c.campaign_id
        WHERE c.workspace_id = $1
          AND c.already_connected = true
          ${companyFilter}
        ORDER BY c.id, c.created_at DESC
      `, params);

      // Count per account
      const byAccount = {};
      for (const acc of accounts) byAccount[acc.account_id] = 0;
      for (const c of contacts) {
        if (c.account_id && byAccount[c.account_id] !== undefined) {
          byAccount[c.account_id]++;
        }
      }

      result.push({
        company_name:        company.company_name,
        company_linkedin_id: company.company_linkedin_id || null,
        li_company_url:      company.li_company_url || null,
        connections_by_account: byAccount,
        total:               contacts.length,
        contacts,
      });
    }

    // Sort: most connections first, then alphabetically
    result.sort((a, b) => b.total - a.total || a.company_name.localeCompare(b.company_name));

    res.json({ accounts, companies: result });
  } catch (err) {
    console.error('[Opportunities] GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/opportunities/send-message
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

    if (!contact.already_connected) {
      return res.status(400).json({ error: 'Contact is not connected on LinkedIn yet' });
    }
    if (!contact.account_id) {
      return res.status(400).json({ error: 'No Unipile account found for this contact' });
    }
    if (!contact.provider_id && !contact.chat_id) {
      return res.status(400).json({ error: 'Contact not enriched — provider_id missing' });
    }

    let chatId = contact.chat_id;

    if (chatId) {
      await sendMessage(contact.account_id, chatId, text.trim());
    } else {
      const result = await startDirectMessage(contact.account_id, contact.provider_id, text.trim());
      chatId = result?.id || result?.chat_id || null;
      if (chatId) {
        await db.query('UPDATE contacts SET chat_id = $1 WHERE id = $2', [chatId, contact_id]);
      }
    }

    // Mark message sent
    await db.query(
      `UPDATE contacts SET
         msg_sent    = true,
         msg_sent_at = COALESCE(msg_sent_at, NOW()),
         msgs_sent_count = COALESCE(msgs_sent_count, 0) + 1
       WHERE id = $1`,
      [contact_id]
    );

    console.log(`[Opportunities] Sent direct message to contact ${contact_id} (${contact.first_name} ${contact.last_name})`);
    res.json({ success: true, contact_id, chat_id: chatId });
  } catch (err) {
    console.error('[Opportunities] send-message error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

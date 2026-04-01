const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { reExtractAll, enqueue, getStatus } = require('../enrichment');
const { sendInvitation, withdrawInvitation } = require('../unipile');
const { analyzeConversation } = require('../conversationAnalyzer');
const { status: queueStatus }  = require('../conversationQueue');

// GET /api/contacts?workspace_id=&campaign_id=&q=
router.get('/', async (req, res) => {
  try {
    const { workspace_id, campaign_id, q } = req.query;
    const conditions = [];
    const params = [];
    if (workspace_id) { params.push(workspace_id); conditions.push(`c.workspace_id = $${params.length}`); }
    if (campaign_id)  { params.push(campaign_id);  conditions.push(`c.campaign_id  = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      const i = params.length;
      conditions.push(`(c.first_name ILIKE $${i} OR c.last_name ILIKE $${i} OR c.company ILIKE $${i} OR c.title ILIKE $${i} OR c.email ILIKE $${i})`);
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await db.query(
      `SELECT c.*, camp.name AS campaign_name,
      COALESCE((SELECT STRING_AGG(l.name, ', ' ORDER BY l.name) FROM list_contacts lc JOIN lists l ON l.id = lc.list_id WHERE lc.contact_id = c.id), '') AS list_names
      FROM contacts c LEFT JOIN campaigns camp ON camp.id = c.campaign_id ${where} ORDER BY c.created_at DESC`,
      params
    );
    res.json({ items: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/contacts/:id/conversation
// Returns the full conversation analysis for a single contact.
router.get('/:id/conversation', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, first_name, last_name,
              conversation_stage, conversation_score,
              conversation_signals, conversation_analyzed_at
       FROM contacts WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Contact not found' });
    const r = rows[0];
    const signals = typeof r.conversation_signals === 'string'
      ? JSON.parse(r.conversation_signals || '{}')
      : (r.conversation_signals || {});
    res.json({
      contact_id:   r.id,
      name:         `${r.first_name} ${r.last_name}`,
      stage:        r.conversation_stage,
      score:        r.conversation_score,
      analyzed_at:  r.conversation_analyzed_at,
      ...signals,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/contacts/:id/re-analyze
// Manually trigger conversation analysis for a single contact.
router.post('/:id/re-analyze', async (req, res) => {
  try {
    const contactId = parseInt(req.params.id, 10);
    const { rows } = await db.query(
      `SELECT c.id, c.first_name, c.last_name, c.chat_id, camp.account_id
       FROM contacts c
       JOIN campaigns camp ON camp.id = c.campaign_id
       WHERE c.id = $1`,
      [contactId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Contact not found' });
    const contact = rows[0];
    if (!contact.chat_id)    return res.status(400).json({ error: 'No chat_id Ã¢ÂÂ contact has not been messaged or replied yet' });
    if (!contact.account_id) return res.status(400).json({ error: 'No account_id Ã¢ÂÂ campaign missing account' });

    // Run async, return immediately
    analyzeConversation(contactId, contact.account_id, contact.chat_id)
      .then(r => console.log(`[API] Re-analyze done for contact ${contactId}: stage=${r.stage} score=${r.score}`))
      .catch(e => console.error(`[API] Re-analyze error for contact ${contactId}: ${e.message}`));

    res.json({ status: 'started', contact_id: contactId, name: `${contact.first_name} ${contact.last_name}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/contacts/conversation-queue-status
router.get('/conversation-queue-status', (_req, res) => res.json(queueStatus()));

// GET /api/contacts/debug-profile/:id
router.get('/debug-profile/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, first_name, last_name, li_profile_url, profile_data FROM contacts WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Contact not found' });
    const row = rows[0];
    const raw = row.profile_data
      ? (typeof row.profile_data === 'string' ? JSON.parse(row.profile_data) : row.profile_data)
      : null;
    function inventory(obj, prefix) {
      prefix = prefix || '';
      const result = {};
      if (!obj || typeof obj !== 'object') return result;
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        const fullKey = prefix ? prefix + '.' + k : k;
        if (Array.isArray(v)) {
          result[fullKey] = 'Array(' + v.length + ')';
          if (v.length > 0 && v[0] && typeof v[0] === 'object') Object.assign(result, inventory(v[0], fullKey + '[0]'));
          else if (v.length > 0) result[fullKey + '[0]'] = v[0];
        } else if (v && typeof v === 'object') {
          Object.assign(result, inventory(v, fullKey));
        } else {
          result[fullKey] = v;
        }
      }
      return result;
    }
    res.json({
      contact_id: row.id, stored_name: row.first_name + ' ' + row.last_name,
      li_profile_url: row.li_profile_url, has_profile_data: !!raw,
      field_map: raw ? inventory(raw) : null, raw_profile: raw,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/contacts/re-extract?workspace_id=X
router.post('/re-extract', async (req, res) => {
  try {
    const workspace_id = req.query.workspace_id || req.body.workspace_id;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });
    const result = await reExtractAll(workspace_id);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/contacts/re-enrich?workspace_id=X&campaign_id=Y
router.post('/re-enrich', async (req, res) => {
  try {
    const workspace_id = req.query.workspace_id || req.body.workspace_id;
    const campaign_id  = req.query.campaign_id  || req.body.campaign_id;
    const limit        = parseInt(req.query.limit || req.body.limit || '50', 10);
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });
    const params = [workspace_id];
    let sql = `
      SELECT c.id, c.li_profile_url, camp.account_id
      FROM contacts c
      JOIN campaigns camp ON camp.id = c.campaign_id
      WHERE c.workspace_id = $1
        AND c.li_profile_url IS NOT NULL AND c.li_profile_url != ''
        AND c.li_profile_url LIKE '%linkedin.com/in/%'
        AND (c.profile_data IS NULL OR c.profile_data::text = 'null' OR c.profile_data::text = '{}')
    `;
    if (campaign_id) { params.push(campaign_id); sql += ` AND c.campaign_id = $${params.length}`; }
    params.push(limit);
    sql += ` ORDER BY c.created_at ASC LIMIT $${params.length}`;
    const { rows } = await db.query(sql, params);
    let queued = 0;
    for (const row of rows) {
      if (row.account_id && row.li_profile_url) { enqueue(row.id, row.account_id, row.li_profile_url); queued++; }
    }
    res.json({ queued, total_needing_enrich: rows.length, enrichment_status: getStatus() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/contacts/:id/send-invite
router.post('/:id/send-invite', async (req, res) => {
  try {
    const contactId = parseInt(req.params.id, 10);
    const { rows } = await db.query(
      `SELECT c.id, c.first_name, c.last_name, c.li_profile_url, c.provider_id,
              c.invite_sent, c.invite_approved, c.invite_withdrawn, camp.account_id
       FROM contacts c JOIN campaigns camp ON camp.id = c.campaign_id WHERE c.id = $1`,
      [contactId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Contact not found' });
    const contact = rows[0];
    if (!contact.li_profile_url) return res.status(400).json({ error: 'Contact has no LinkedIn URL' });
    if (!contact.provider_id)    return res.status(400).json({ error: 'Contact not enriched yet Ã¢ÂÂ provider_id missing' });
    if (contact.invite_sent)     return res.status(400).json({ error: 'Invite already sent' });
    await sendInvitation(contact.account_id, contact.provider_id);
    await db.query('UPDATE contacts SET invite_sent = true, invite_sent_at = NOW() WHERE id = $1', [contactId]);
    res.json({ success: true, contact_id: contactId, name: `${contact.first_name} ${contact.last_name}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/contacts/:id/withdraw-invite
router.post('/:id/withdraw-invite', async (req, res) => {
  try {
    const contactId = parseInt(req.params.id, 10);
    const { rows } = await db.query(
      `SELECT c.id, c.first_name, c.last_name, c.li_profile_url, c.provider_id,
              c.invite_sent, c.invite_approved, c.invite_withdrawn, camp.account_id
       FROM contacts c JOIN campaigns camp ON camp.id = c.campaign_id WHERE c.id = $1`,
      [contactId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Contact not found' });
    const contact = rows[0];
    if (!contact.invite_sent)     return res.status(400).json({ error: 'No invite sent yet' });
    if (contact.invite_approved)  return res.status(400).json({ error: 'Invite already approved' });
    if (contact.invite_withdrawn) return res.status(400).json({ error: 'Invite already withdrawn' });
    if (!contact.provider_id)     return res.status(400).json({ error: 'Contact not enriched yet' });
    await withdrawInvitation(contact.account_id, contact.provider_id);
    await db.query('UPDATE contacts SET invite_withdrawn = true, invite_withdrawn_at = NOW() WHERE id = $1', [contactId]);
    res.json({ success: true, contact_id: contactId, name: `${contact.first_name} ${contact.last_name}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/contacts/:id
router.delete('/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM contacts WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/contacts (bulk)
router.delete('/', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
    await db.query('DELETE FROM contacts WHERE id = ANY($1)', [ids]);
    res.json({ success: true, deleted: ids.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// POST /api/contacts/enrich-list
// Stage 2: Enrich one contact at a time from a list.
// Frontend calls this in a loop, one contact per call.
// Returns: { done, total, contact_id, enriched_data } or { finished: true }
router.post('/enrich-list', async (req, res) => {
  try {
    const { list_id, workspace_id, offset = 0 } = req.body;
    if (!list_id || !workspace_id) return res.status(400).json({ error: 'list_id and workspace_id required' });
    const { enrichProfile } = require('../unipile');
    const { rows: accs } = await db.query(
      'SELECT account_id FROM unipile_accounts WHERE workspace_id=$1 LIMIT 1', [workspace_id]
    );
    if (!accs.length) return res.json({ error: 'No LinkedIn account connected' });
    const accountId = accs[0].account_id;
    const { rows: total } = await db.query(
      'SELECT COUNT(*) AS n FROM list_contacts lc JOIN contacts c ON c.id=lc.contact_id WHERE lc.list_id=$1', [list_id]
    );
    const totalN = parseInt(total[0].n);
    const { rows: contacts } = await db.query(
      'SELECT c.id, c.li_profile_url, c.first_name, c.last_name, c.profile_data FROM list_contacts lc JOIN contacts c ON c.id=lc.contact_id WHERE lc.list_id=$1 ORDER BY lc.id LIMIT 1 OFFSET $2',
      [list_id, offset]
    );
    if (!contacts.length) return res.json({ finished: true, total: totalN, done: offset });
    const ct = contacts[0];
    const needsEnrich = !ct.first_name || !ct.profile_data || Object.keys(ct.profile_data||{}).length === 0;
    if (!needsEnrich) {
      return res.json({ done: offset + 1, total: totalN, contact_id: ct.id, skipped: true, first_name: ct.first_name, last_name: ct.last_name });
    }
    const pid = (ct.li_profile_url||'').replace('https://www.linkedin.com/in/','').replace(/\/$/,'');
    if (!pid) return res.json({ done: offset + 1, total: totalN, contact_id: ct.id, skipped: true });
    try {
      const profile = await enrichProfile(accountId, pid);
      if (profile && profile.id) {
        await db.query(
          'UPDATE contacts SET first_name=$1,last_name=$2,title=$3,li_company_url=$4,location=$5,profile_data=$6 WHERE id=$7',
          [profile.first_name||ct.first_name||'', profile.last_name||ct.last_name||'', profile.headline||'', profile.current_company_url||'', profile.location||'', JSON.stringify(profile), ct.id]
        );
        return res.json({ done: offset + 1, total: totalN, contact_id: ct.id, first_name: profile.first_name||'', last_name: profile.last_name||'', title: profile.headline||'', location: profile.location||'' });
      }
    } catch(enrichErr) {}
    return res.json({ done: offset + 1, total: totalN, contact_id: ct.id, error: 'enrich failed' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

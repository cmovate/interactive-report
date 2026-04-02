const express = require('express');
const router = express.Router();
const db = require('../db');
const { enrichProfile } = require('../unipile');

router.post('/', async function(req, res) {
  try {
    var list_id = req.body.list_id;
    var workspace_id = req.body.workspace_id;
    var offset = parseInt(req.body.offset) || 0;
    if (!list_id || !workspace_id) return res.status(400).json({ error: 'list_id and workspace_id required' });

    var accRes = await db.query('SELECT account_id FROM unipile_accounts WHERE workspace_id=$1 LIMIT 1', [workspace_id]);
    if (!accRes.rows.length) return res.json({ error: 'No LinkedIn account' });
    var accountId = accRes.rows[0].account_id;

    var totalRes = await db.query('SELECT COUNT(*) AS n FROM list_contacts WHERE list_id=$1', [list_id]);
    var total = parseInt(totalRes.rows[0].n);

    var ctRes = await db.query(
      'SELECT c.id, c.li_profile_url, c.first_name, c.last_name, c.profile_data FROM list_contacts lc JOIN contacts c ON c.id=lc.contact_id WHERE lc.list_id=$1 ORDER BY lc.contact_id LIMIT 1 OFFSET $2',
      [list_id, offset]
    );
    if (!ctRes.rows.length) return res.json({ finished: true, total: total, done: offset });

    var ct = ctRes.rows[0];
    var alreadyDone = ct.first_name && ct.first_name.trim() && ct.profile_data && Object.keys(ct.profile_data || {}).length > 0;
    if (alreadyDone) {
      return res.json({ done: offset + 1, total, contact_id: ct.id, skipped: true, first_name: ct.first_name, last_name: ct.last_name });
    }

    var enrichErrMsg = '';
    var pid = (ct.li_profile_url || '')
      .replace('https://www.linkedin.com/in/', '')
      .replace('http://www.linkedin.com/in/', '')
      .replace(/\/+$/, '');
    if (!pid) return res.json({ done: offset + 1, total, contact_id: ct.id, skipped: true, reason: 'no_pid' });

    try {
      var profile = await enrichProfile(accountId, pid);
      if (profile && profile.id) {
        var company = '';
        var companyUrl = '';
        // job title = current position role (not headline)
        var jobTitle = '';
        if (profile.current_positions && profile.current_positions[0]) {
          jobTitle    = profile.current_positions[0].role    || '';
          company     = profile.current_positions[0].company || '';
          companyUrl  = profile.current_positions[0].company_url || '';
        }
        await db.query(
          'UPDATE contacts SET first_name=$1, last_name=$2, title=$3, location=$4, company=$5, li_company_url=$6, member_urn=$7, provider_id=$8, profile_data=$9 WHERE id=$10',
          [
            profile.first_name || '', profile.last_name || '',
            jobTitle, profile.location || '',
            company, companyUrl,
            profile.member_urn || '', profile.id || '',
            JSON.stringify(profile), ct.id
          ]
        );
        return res.json({ done: offset + 1, total, contact_id: ct.id, ok: true,
          first_name: profile.first_name || '', last_name: profile.last_name || '',
          title: jobTitle, company, location: profile.location || '' });
      }
    } catch (enrichErr) { enrichErrMsg = enrichErr.message || String(enrichErr); }

    return res.json({ done: offset + 1, total, contact_id: ct.id, error: 'enrich_failed', detail: enrichErrMsg, profile_keys: profile ? Object.keys(profile) : 'null', profile_type: profile ? profile.type : 'n/a', profile_status: profile ? profile.status : 'n/a' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

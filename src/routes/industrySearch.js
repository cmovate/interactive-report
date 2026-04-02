
const express = require('express');
const router = express.Router();
const db = require('../db');
const { searchPeopleByKeywords } = require('../unipile');

// POST /api/industry-search
// Body: { workspace_id, list_id, keywords, industry_ids, location_ids, cursor, limit }
router.post('/', async function(req, res) {
  try {
    const { workspace_id, list_id, keywords, industry_ids, location_ids, cursor, limit } = req.body;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });

    const accRes = await db.query('SELECT account_id FROM unipile_accounts WHERE workspace_id=$1 LIMIT 1', [workspace_id]);
    if (!accRes.rows.length) return res.json({ error: 'no account' });
    const accountId = accRes.rows[0].account_id;

    // Call Unipile directly
    const { getAccountInfo } = require('../unipile');
    const acc = await getAccountInfo(accountId).catch(()=>({}));
    const baseUrl = (acc.subdomain && acc.port)
      ? 'https://' + acc.subdomain + '.unipile.com:' + acc.port
      : 'https://api1.unipile.com:13111';
    const apiKey = process.env.UNIPILE_API_KEY || acc.api_key;

    const body = { api: 'classic', category: 'people', limit: limit || 50 };
    if (keywords) body.keywords = keywords;
    if (industry_ids && industry_ids.length) body.industry = industry_ids.map(String);
    if (location_ids && location_ids.length) body.location = location_ids.map(String);
    if (cursor) body.cursor = cursor;

    const searchUrl = baseUrl + '/api/v1/linkedin/search?account_id=' + encodeURIComponent(accountId);
    const searchRes = await fetch(searchUrl, {
      method: 'POST',
      headers: { 'accept': 'application/json', 'content-type': 'application/json', 'X-API-KEY': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000)
    }).then(r => r.json());

    const items = searchRes.items || [];
    const nextCursor = searchRes.paging && searchRes.paging.cursor ? searchRes.paging.cursor : null;
    const totalCount = searchRes.paging && searchRes.paging.total_count;

    // Save to list if list_id provided
    let saved = 0;
    if (list_id && items.length) {
      for (const p of items) {
        const url = p.public_profile_url || p.profile_url;
        if (!url) continue;
        const existing = await db.query('SELECT id FROM contacts WHERE workspace_id=$1 AND li_profile_url=$2', [workspace_id, url]);
        let contactId;
        if (existing.rows.length) {
          contactId = existing.rows[0].id;
        } else {
          const ins = await db.query(
            'INSERT INTO contacts (workspace_id, li_profile_url, first_name, last_name, headline, company) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id',
            [workspace_id, url, p.first_name||'', p.last_name||'', p.headline||'', p.company||'']
          );
          contactId = ins.rows[0] && ins.rows[0].id;
        }
        if (contactId) {
          await db.query('INSERT INTO list_contacts (list_id, contact_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [list_id, contactId]);
          saved++;
        }
      }
    }

    res.json({ found: items.length, saved, next_cursor: nextCursor, total_count: totalCount, items: items.map(p=>({ url: p.public_profile_url, name: p.name || (p.first_name+' '+p.last_name).trim(), headline: p.headline })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

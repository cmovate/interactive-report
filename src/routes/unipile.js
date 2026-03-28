const express = require('express');
const router = express.Router();
const { getAccounts, enrichProfile } = require('../unipile');

// GET /api/unipile/accounts
router.get('/accounts', async (req, res) => {
  try {
    const accounts = await getAccounts();
    res.json({ items: accounts });
  } catch (err) {
    console.error('Unipile getAccounts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/unipile/enrich-test
// Body: { account_id, li_profile_url }
// Returns raw profile data + extracted fields for debugging
router.post('/enrich-test', async (req, res) => {
  try {
    const { account_id, li_profile_url } = req.body;
    if (!account_id || !li_profile_url) return res.status(400).json({ error: 'account_id and li_profile_url required' });

    const profile = await enrichProfile(account_id, li_profile_url);

    // Detect connection status (same logic as enrichment.js)
    const rel = profile.relation_type;
    const dist = String(profile.network_distance || '').toUpperCase();
    const already_connected =
      rel === 1 || rel === '1' ||
      dist === 'DISTANCE_1' || dist === '1' ||
      profile.degree === 1 || profile.degree === '1' ||
      profile.connection_degree === 1 || profile.connection_degree === '1';

    // Extract key fields
    const exp = Array.isArray(profile.work_experience) && profile.work_experience.length > 0 ? profile.work_experience[0] : null;
    const extracted = {
      provider_id:       profile.provider_id || null,
      first_name:        profile.first_name || null,
      last_name:         profile.last_name || null,
      headline:          profile.headline || null,
      location:          profile.location || null,
      title:             exp?.position || exp?.title || profile.headline || null,
      company:           (typeof exp?.company === 'string' ? exp.company : exp?.company?.name) || exp?.company_name || null,
      company_id:        exp?.company_id ? String(exp.company_id) : null,
      email:             profile.contact_info?.emails?.[0] || profile.emails?.[0] || null,
      // Connection detection
      already_connected,
      relation_type:     profile.relation_type,
      network_distance:  profile.network_distance,
      degree:            profile.degree,
      connection_degree: profile.connection_degree,
    };

    res.json({ extracted, raw_keys: Object.keys(profile) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

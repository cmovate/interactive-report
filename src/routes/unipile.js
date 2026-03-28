const express = require('express');
const router = express.Router();
const { getAccounts, enrichProfile, getChatsByAttendee } = require('../unipile');

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
// Returns extracted fields + connection status + chat history check
router.post('/enrich-test', async (req, res) => {
  try {
    const { account_id, li_profile_url } = req.body;
    if (!account_id || !li_profile_url) return res.status(400).json({ error: 'account_id and li_profile_url required' });

    const profile = await enrichProfile(account_id, li_profile_url);

    const dist = String(profile.network_distance || '').toUpperCase();
    const already_connected =
      dist === 'FIRST_DEGREE' ||
      dist === 'DISTANCE_1' || dist === '1' ||
      profile.relation_type === 1 || profile.relation_type === '1' ||
      profile.degree === 1 || profile.degree === '1' ||
      profile.connection_degree === 1 || profile.connection_degree === '1';

    const exp = Array.isArray(profile.work_experience) && profile.work_experience.length > 0
      ? profile.work_experience[0] : null;

    let has_chat_history = null;
    let chat_id = null;
    let chats_error = null;

    if (already_connected && profile.provider_id) {
      try {
        const chats = await getChatsByAttendee(account_id, profile.provider_id);
        has_chat_history = chats.length > 0;
        chat_id = has_chat_history ? (chats[0].id || chats[0].provider_id || null) : null;
      } catch (err) {
        chats_error = err.message;
      }
    }

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
      already_connected,
      network_distance:  profile.network_distance,
      has_chat_history,
      chat_id,
      chats_error,
    };

    res.json({ extracted, raw_keys: Object.keys(profile) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

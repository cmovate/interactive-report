const express = require('express');
const router = express.Router();
const { getAccounts } = require('../unipile');

// GET /api/unipile/accounts
// Returns all LinkedIn accounts connected to Unipile
router.get('/accounts', async (req, res) => {
  try {
    const accounts = await getAccounts();
    res.json({ items: accounts });
  } catch (err) {
    console.error('Unipile getAccounts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

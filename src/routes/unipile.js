const express = require('express');
const router = express.Router();
const unipile = require('../unipile');

router.get('/accounts', async (req, res) => {
  try {
    const data = await unipile.getAccounts();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

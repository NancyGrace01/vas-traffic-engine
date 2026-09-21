const express = require('express');
const jwt     = require('jsonwebtoken');
const router  = express.Router();

// POST /api/v1/admin/login
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username !== process.env.ADMIN_USERNAME || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ username, role: 'admin' }, process.env.ADMIN_JWT_SECRET, { expiresIn: '24h' });
  return res.json({ token, expires_in: '24h' });
});

router.post('/run/reset-visitors', async (req, res) => {
  try {
    const reset = require('../reset-visitors');
    const rows = await reset();
    return res.json({ success: true, updated: rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

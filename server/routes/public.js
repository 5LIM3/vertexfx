const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/announcements/active', (req, res) => {
  const rows = db.prepare('SELECT id, message, created_at FROM announcements WHERE active = 1 ORDER BY created_at DESC LIMIT 5').all();
  res.json({ announcements: rows });
});

module.exports = router;

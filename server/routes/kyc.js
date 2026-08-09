const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

router.get('/status', requireAuth, (req, res) => {
  const row = db.prepare('SELECT kyc_status, kyc_note FROM users WHERE id = ?').get(req.userId);
  res.json({ status: row.kyc_status, note: row.kyc_note });
});

// Mock submission — this is a demo UI flow only. It does NOT store real documents
// or call any real identity-verification vendor (Sumsub/Persona/Onfido/etc).
// It just records that the user "submitted" and moves them into a review queue
// that shows up in the admin dashboard.
router.post('/submit', requireAuth, (req, res) => {
  const { idType, idFilename, selfieFilename, addressFilename } = req.body || {};
  if (!idType || !idFilename || !selfieFilename) {
    return res.status(400).json({ error: 'ID type, ID document, and selfie are required' });
  }
  const row = db.prepare('SELECT kyc_status FROM users WHERE id = ?').get(req.userId);
  if (row.kyc_status === 'approved') return res.status(400).json({ error: 'Your account is already verified' });

  db.prepare("UPDATE users SET kyc_status = 'pending', kyc_note = ? WHERE id = ?")
    .run(`Submitted: ${idType}, ${idFilename}, ${selfieFilename}${addressFilename ? ', ' + addressFilename : ''}`, req.userId);

  res.json({ ok: true, status: 'pending' });
});

module.exports = router;

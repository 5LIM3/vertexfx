const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

const MAX_DOC_BYTES = 6 * 1024 * 1024; // ~6MB per file, generous for a phone photo
const ALLOWED_DOC_PREFIX = /^data:(image\/(jpeg|png|webp)|application\/pdf);base64,/;

function validDoc(dataUri, required) {
  if (!dataUri) return !required;
  if (typeof dataUri !== 'string' || !ALLOWED_DOC_PREFIX.test(dataUri)) return false;
  // Rough size check from base64 length (base64 is ~4/3 the size of the raw bytes)
  const approxBytes = dataUri.length * 0.75;
  return approxBytes <= MAX_DOC_BYTES;
}

router.get('/status', requireAuth, (req, res) => {
  const row = db.prepare('SELECT kyc_status, kyc_note FROM users WHERE id = ?').get(req.userId);
  res.json({ status: row.kyc_status, note: row.kyc_note });
});

// Real document storage: the actual image/PDF is stored (as a data URI) and
// reviewable by an admin in the KYC queue — this does NOT call any real
// identity-verification vendor (Sumsub/Persona/Onfido/etc), it's still an
// internal-review-only flow, just with real files behind it instead of a
// filename string.
router.post('/submit', requireAuth, (req, res) => {
  const { idType, idDoc, selfieDoc, addressDoc } = req.body || {};
  if (!idType || !idDoc || !selfieDoc) {
    return res.status(400).json({ error: 'ID type, ID document, and selfie are required' });
  }
  if (!validDoc(idDoc, true) || !validDoc(selfieDoc, true) || !validDoc(addressDoc, false)) {
    return res.status(400).json({ error: 'Each file must be a JPEG, PNG, WEBP, or PDF under 6MB' });
  }
  const row = db.prepare('SELECT kyc_status FROM users WHERE id = ?').get(req.userId);
  if (row.kyc_status === 'approved') return res.status(400).json({ error: 'Your account is already verified' });

  db.prepare(
    "UPDATE users SET kyc_status = 'pending', kyc_note = NULL, kyc_id_type = ?, kyc_id_doc = ?, kyc_selfie_doc = ?, kyc_address_doc = ? WHERE id = ?"
  ).run(idType, idDoc, selfieDoc, addressDoc || null, req.userId);

  res.json({ ok: true, status: 'pending' });
});

module.exports = router;

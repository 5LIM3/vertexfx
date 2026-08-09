const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const twofa = require('../twofa');

const router = express.Router();

// Step 1: generate a secret + QR code for the user to scan, but don't enable yet.
router.post('/setup', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT email, totp_enabled FROM users WHERE id = ?').get(req.userId);
  if (user.totp_enabled) return res.status(400).json({ error: '2FA is already enabled on this account' });

  const secret = twofa.generateSecret();
  const otpauth = twofa.otpAuthUrl(user.email, secret);
  const qr = await twofa.qrDataUrl(otpauth);

  // Stash the pending secret (not yet active) until the user confirms with a valid code.
  db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret, req.userId);
  res.json({ secret, qr, otpauth });
});

// Step 2: user submits a code from their authenticator app to confirm setup.
router.post('/enable', requireAuth, (req, res) => {
  const { code } = req.body || {};
  const user = db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').get(req.userId);
  if (!user.totp_secret) return res.status(400).json({ error: 'Call /setup first' });
  if (user.totp_enabled) return res.status(400).json({ error: '2FA is already enabled' });
  if (!twofa.verifyToken(code, user.totp_secret)) {
    return res.status(400).json({ error: 'Invalid code — check your authenticator app and try again' });
  }
  const backupCodes = twofa.generateBackupCodes(8);
  const hashed = backupCodes.map(twofa.hashBackupCode);
  db.prepare('UPDATE users SET totp_enabled = 1, backup_codes = ? WHERE id = ?').run(JSON.stringify(hashed), req.userId);
  res.json({ ok: true, backupCodes }); // shown once — user must save these
});

router.post('/disable', requireAuth, (req, res) => {
  const { password, code } = req.body || {};
  const bcrypt = require('bcryptjs');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user.totp_enabled) return res.status(400).json({ error: '2FA is not enabled' });
  if (!password || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  if (!twofa.verifyToken(code, user.totp_secret)) {
    return res.status(400).json({ error: 'Invalid authentication code' });
  }
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, backup_codes = NULL WHERE id = ?').run(req.userId);
  res.json({ ok: true });
});

module.exports = router;

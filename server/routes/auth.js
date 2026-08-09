const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { signToken, signTempToken, requireAuth } = require('../auth');
const { sendVerificationEmail } = require('../mailer');
const twofa = require('../twofa');

const router = express.Router();
const STARTING_BALANCE = parseFloat(process.env.STARTING_BALANCE || '10000');
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

// Brute-force protection — matters once this is on a real public domain, not just localhost.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: 'Too many login attempts. Try again in a few minutes.' },
  standardHeaders: true, legacyHeaders: false,
});
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 8,
  message: { error: 'Too many accounts created from this network. Try again later.' },
  standardHeaders: true, legacyHeaders: false,
});
const twofaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 15,
  message: { error: 'Too many code attempts. Try again in a few minutes.' },
  standardHeaders: true, legacyHeaders: false,
});

function genHarborId() {
  const n = Math.floor(10000 + Math.random() * 90000);
  const letters = Array.from({ length: 2 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
  return `VFX-${n}-${letters}`;
}

const cookieOpts = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

async function issueVerification(userId, email) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO email_verifications (user_id, token, expires_at, used, created_at) VALUES (?,?,?,0,?)')
    .run(userId, token, now + VERIFY_TTL_MS, now);
  await sendVerificationEmail(email, token);
}

router.post('/signup', signupLimiter, async (req, res) => {
  const { email, password, fullName } = req.body || {};
  if (!email || !password || !fullName) {
    return res.status(400).json({ error: 'email, password and fullName are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

  const hash = bcrypt.hashSync(password, 10);
  let harborId = genHarborId();
  while (db.prepare('SELECT 1 FROM users WHERE harbor_id = ?').get(harborId)) harborId = genHarborId();

  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO users (email, password_hash, full_name, harbor_id, created_at) VALUES (?,?,?,?,?)'
  ).run(email.toLowerCase(), hash, fullName, harborId, now);

  db.prepare('INSERT INTO wallets (user_id, account_type, balance, equity_locked, updated_at) VALUES (?,?,?,?,?)')
    .run(info.lastInsertRowid, 'demo', STARTING_BALANCE, 0, now);
  db.prepare('INSERT INTO wallets (user_id, account_type, balance, equity_locked, updated_at) VALUES (?,?,?,?,?)')
    .run(info.lastInsertRowid, 'real', 0, 0, now);

  // Only the demo account gets a welcome bonus — the real account starts at $0,
  // exactly like a real broker's live account before any deposit.
  db.prepare('INSERT INTO ledger (user_id, account_type, type, amount, status, method, reference, note, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(info.lastInsertRowid, 'demo', 'deposit', STARTING_BALANCE, 'completed', 'welcome_bonus', 'WELCOME-' + info.lastInsertRowid, 'Demo starting balance', now);

  try {
    await issueVerification(info.lastInsertRowid, email.toLowerCase());
  } catch (e) {
    console.error('Failed to send verification email:', e.message);
  }

  res.json({
    ok: true,
    requiresVerification: true,
    message: 'Account created with both a Demo account ($10,000 welcome bonus) and a Real account ($0 — fund it via deposit). Check your email to verify before logging in.',
  });
});

router.post('/resend-verification', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email is required' });
  const user = db.prepare('SELECT id, email, email_verified FROM users WHERE email = ?').get(email.toLowerCase());
  // Don't leak whether the account exists — always respond the same way.
  if (user && !user.email_verified) {
    try { await issueVerification(user.id, user.email); } catch (e) { console.error(e.message); }
  }
  res.json({ ok: true, message: 'If that account exists and is unverified, a new email has been sent.' });
});

router.get('/verify-email', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Missing token' });
  const row = db.prepare('SELECT * FROM email_verifications WHERE token = ?').get(token);
  if (!row || row.used || row.expires_at < Date.now()) {
    return res.status(400).json({ error: 'This verification link is invalid or has expired.' });
  }
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare('UPDATE email_verifications SET used = 1 WHERE id = ?').run(row.id);
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(row.user_id);
  });
  tx();
  res.json({ ok: true, message: 'Email verified — you can now log in.' });
});

router.post('/login', loginLimiter, (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (row.suspended) return res.status(403).json({ error: 'This account has been suspended. Contact support.' });
  if (!row.email_verified) {
    return res.status(403).json({ error: 'Please verify your email before logging in.', requiresVerification: true });
  }

  if (row.totp_enabled) {
    const tempToken = signTempToken(row);
    return res.json({ requires2fa: true, tempToken });
  }

  const token = signToken(row);
  res.cookie('vfx_token', token, cookieOpts);
  res.json({
    token,
    user: { id: row.id, email: row.email, fullName: row.full_name, harborId: row.harbor_id, role: row.role },
  });
});

router.post('/2fa/verify', twofaLimiter, (req, res) => {
  const { tempToken, code } = req.body || {};
  const { verifyToken } = require('../auth');
  const payload = tempToken && verifyToken(tempToken);
  if (!payload || payload.stage !== '2fa_pending') return res.status(401).json({ error: 'Invalid or expired session — please log in again.' });

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
  if (!row) return res.status(404).json({ error: 'User not found' });

  let ok = twofa.verifyToken(code, row.totp_secret);
  if (!ok && row.backup_codes) {
    const codes = JSON.parse(row.backup_codes);
    const hash = twofa.hashBackupCode(code);
    const idx = codes.indexOf(hash);
    if (idx !== -1) {
      ok = true;
      codes.splice(idx, 1);
      db.prepare('UPDATE users SET backup_codes = ? WHERE id = ?').run(JSON.stringify(codes), row.id);
    }
  }
  if (!ok) return res.status(401).json({ error: 'Invalid authentication code' });

  const token = signToken(row);
  res.cookie('vfx_token', token, cookieOpts);
  res.json({ token, user: { id: row.id, email: row.email, fullName: row.full_name, harborId: row.harbor_id, role: row.role } });
});

router.post('/logout', (req, res) => {
  res.clearCookie('vfx_token');
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, email, full_name, harbor_id, role, email_verified, totp_enabled, kyc_status, created_at FROM users WHERE id = ?').get(req.userId);
  if (!row) return res.status(404).json({ error: 'User not found' });
  res.json({
    user: {
      id: row.id, email: row.email, fullName: row.full_name, harborId: row.harbor_id,
      role: row.role, emailVerified: !!row.email_verified, totpEnabled: !!row.totp_enabled,
      kycStatus: row.kyc_status, createdAt: row.created_at,
    },
  });
});

module.exports = router;

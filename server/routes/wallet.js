const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { getAccountType } = require('../accountType');

const router = express.Router();

const METHODS = ['card', 'bank_transfer', 'crypto'];

function getWallet(userId, accountType) {
  return db.prepare('SELECT * FROM wallets WHERE user_id = ? AND account_type = ?').get(userId, accountType);
}

function openPositionsMargin(userId, accountType) {
  const rows = db.prepare("SELECT volume_lots, entry_price FROM positions WHERE user_id = ? AND account_type = ? AND status = 'open'").all(userId, accountType);
  // simplified margin model: 1 lot = $100,000 notional, 1% margin requirement
  return rows.reduce((sum, p) => sum + p.volume_lots * 100000 * 0.01, 0);
}

// Real-shaped (but not real) card validation — Luhn check + expiry + CVV format.
// This never touches a real card network; it just rejects obviously-fake input
// the way an actual card form would, so the demo behaves authentically.
function luhnValid(numStr) {
  const digits = numStr.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = parseInt(digits[i], 10);
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function validateCard({ cardNumber, expiry, cvv }) {
  if (!cardNumber || !luhnValid(cardNumber)) return 'Card number is invalid';
  const m = /^(\d{2})\/(\d{2})$/.exec((expiry || '').trim());
  if (!m) return 'Expiry must be in MM/YY format';
  const month = parseInt(m[1], 10), year = 2000 + parseInt(m[2], 10);
  if (month < 1 || month > 12) return 'Expiry month is invalid';
  const now = new Date();
  const expDate = new Date(year, month, 0); // last day of expiry month
  if (expDate < now) return 'This card has expired';
  if (!/^\d{3,4}$/.test((cvv || '').trim())) return 'CVV must be 3 or 4 digits';
  return null;
}

router.get('/', requireAuth, (req, res) => {
  const accountType = getAccountType(req);
  const w = getWallet(req.userId, accountType);
  if (!w) return res.status(404).json({ error: 'Wallet not found' });
  const locked = openPositionsMargin(req.userId, accountType);
  res.json({
    accountType,
    balance: w.balance,
    lockedMargin: +locked.toFixed(2),
    freeMargin: +(w.balance - locked).toFixed(2),
    updatedAt: w.updated_at,
  });
});

router.get('/ledger', requireAuth, (req, res) => {
  const accountType = getAccountType(req);
  const rows = db.prepare('SELECT * FROM ledger WHERE user_id = ? AND account_type = ? ORDER BY created_at DESC LIMIT 200').all(req.userId, accountType);
  res.json({ entries: rows });
});

router.post('/deposit', requireAuth, (req, res) => {
  const accountType = getAccountType(req);
  const { amount, method, card, crypto } = req.body || {};
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Enter a valid deposit amount' });
  if (amt > 250000) return res.status(400).json({ error: 'Single deposit limit is $250,000 in this demo' });
  const m = METHODS.includes(method) ? method : 'card';
  const now = Date.now();
  const ref = 'DEP-' + now.toString(36).toUpperCase();

  // --- Crypto: requires a screenshot reference, goes to pending admin review ---
  if (m === 'crypto') {
    const network = crypto?.network;
    const proofFilename = crypto?.proofFilename;
    if (!network) return res.status(400).json({ error: 'Select a network' });
    if (!proofFilename) return res.status(400).json({ error: 'Upload a screenshot of your transaction as proof of deposit' });

    db.prepare(
      'INSERT INTO ledger (user_id, account_type, type, amount, status, method, reference, note, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(req.userId, accountType, 'deposit', amt, 'pending', m, ref,
      `Awaiting admin review — network: ${network}, proof: ${proofFilename}`, now);

    return res.json({ ok: true, reference: ref, status: 'pending', message: 'Submitted for review. Your balance will update once an admin verifies the transaction.' });
  }

  // --- Card: real-shaped validation, then instant credit (this is how a real card network behaves) ---
  if (m === 'card') {
    const err = validateCard(card || {});
    if (err) return res.status(400).json({ error: err });
  }

  // --- Card / bank transfer: instant mock credit ---
  const tx = db.transaction(() => {
    db.prepare('UPDATE wallets SET balance = balance + ?, updated_at = ? WHERE user_id = ? AND account_type = ?').run(amt, now, req.userId, accountType);
    db.prepare(
      'INSERT INTO ledger (user_id, account_type, type, amount, status, method, reference, note, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(req.userId, accountType, 'deposit', amt, 'completed', m, ref, 'Simulated deposit — no real funds moved', now);
  });
  tx();

  const w = getWallet(req.userId, accountType);
  res.json({ ok: true, reference: ref, status: 'completed', balance: w.balance });
});

router.post('/withdraw', requireAuth, (req, res) => {
  const accountType = getAccountType(req);
  const { amount, method } = req.body || {};
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Enter a valid withdrawal amount' });
  const w = getWallet(req.userId, accountType);
  const locked = openPositionsMargin(req.userId, accountType);
  const free = w.balance - locked;
  if (amt > free) {
    return res.status(400).json({ error: `Insufficient free balance. Available: $${free.toFixed(2)}` });
  }
  const m = METHODS.includes(method) ? method : 'bank_transfer';
  const now = Date.now();
  const ref = 'WD-' + now.toString(36).toUpperCase();

  const tx = db.transaction(() => {
    db.prepare('UPDATE wallets SET balance = balance - ?, updated_at = ? WHERE user_id = ? AND account_type = ?').run(amt, now, req.userId, accountType);
    db.prepare(
      'INSERT INTO ledger (user_id, account_type, type, amount, status, method, reference, note, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(req.userId, accountType, 'withdrawal', -amt, 'pending', m, ref, 'Simulated withdrawal — reviewed by mock admin flow', now);
  });
  tx();

  const updated = getWallet(req.userId, accountType);
  res.json({ ok: true, reference: ref, balance: updated.balance, status: 'pending' });
});

module.exports = router;

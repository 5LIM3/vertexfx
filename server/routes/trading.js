const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { getAccountType } = require('../accountType');

module.exports = function tradingRouter(engine) {
  const router = express.Router();

  router.get('/symbols', (req, res) => {
    const controls = db.prepare('SELECT symbol, trading_enabled FROM symbol_controls').all();
    const controlMap = Object.fromEntries(controls.map(c => [c.symbol, !!c.trading_enabled]));
    const snap = engine.snapshot();
    for (const sym of Object.keys(snap)) {
      snap[sym].tradingEnabled = controlMap[sym] !== undefined ? controlMap[sym] : true;
    }
    res.json({ symbols: engine.meta(), snapshot: snap });
  });

  router.get('/candles/:symbol/:tf', (req, res) => {
    const { symbol, tf } = req.params;
    if (!engine.symbols[symbol]) return res.status(404).json({ error: 'Unknown symbol' });
    res.json({ candles: engine.candles(symbol, tf) });
  });

  router.get('/tape', (req, res) => {
    res.json({ trades: engine.tradeTape.slice(0, 50) });
  });

  router.get('/positions', requireAuth, (req, res) => {
    const accountType = getAccountType(req);
    const open = db.prepare("SELECT * FROM positions WHERE user_id = ? AND account_type = ? AND status = 'open' ORDER BY opened_at DESC").all(req.userId, accountType);
    const withLive = open.map(p => {
      const live = engine.getPrice(p.symbol);
      const meta = engine.meta().find(m => m.sym === p.symbol);
      const dir = p.side === 'long' ? 1 : -1;
      const pnl = (live - p.entry_price) * dir * p.volume_lots * (meta ? meta.contract : 100000);
      return { ...p, livePrice: live, pnl: +pnl.toFixed(2) };
    });
    res.json({ positions: withLive, accountType });
  });

  router.get('/history', requireAuth, (req, res) => {
    const accountType = getAccountType(req);
    const rows = db.prepare("SELECT * FROM positions WHERE user_id = ? AND account_type = ? AND status = 'closed' ORDER BY closed_at DESC LIMIT 100").all(req.userId, accountType);
    res.json({ history: rows, accountType });
  });

  router.post('/positions', requireAuth, (req, res) => {
    const accountType = getAccountType(req);
    const { symbol, side, volumeLots, sl, tp } = req.body || {};
    if (!engine.symbols[symbol]) return res.status(400).json({ error: 'Unknown symbol' });
    if (!['long', 'short'].includes(side)) return res.status(400).json({ error: 'side must be long or short' });
    const vol = parseFloat(volumeLots);
    if (!vol || vol <= 0 || vol > 100) return res.status(400).json({ error: 'Invalid volume (lots)' });

    const control = db.prepare('SELECT * FROM symbol_controls WHERE symbol = ?').get(symbol);
    if (control && !control.trading_enabled) {
      return res.status(423).json({ error: `Trading on ${symbol} is currently paused by the platform` });
    }
    const marginRate = control?.leverage_override ? 1 / control.leverage_override : 0.01;

    const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ? AND account_type = ?').get(req.userId, accountType);
    if (!wallet) return res.status(400).json({ error: 'Invalid account' });
    const openRows = db.prepare("SELECT volume_lots FROM positions WHERE user_id = ? AND account_type = ? AND status = 'open'").all(req.userId, accountType);
    const lockedMargin = openRows.reduce((s, p) => s + p.volume_lots * 100000 * marginRate, 0);
    const requiredMargin = vol * 100000 * marginRate;
    const freeMargin = wallet.balance - lockedMargin;
    if (requiredMargin > freeMargin) {
      const label = accountType === 'real' ? 'real account' : 'demo account';
      return res.status(400).json({ error: `Insufficient free margin on your ${label}. Available: $${freeMargin.toFixed(2)}, required: $${requiredMargin.toFixed(2)}` });
    }

    const fillPrice = engine.getPrice(symbol); // server-authoritative fill — client never sets the price

    // SL/TP must sit on the side of entry price that actually makes sense for the trade direction.
    const slNum = sl != null && sl !== '' ? parseFloat(sl) : null;
    const tpNum = tp != null && tp !== '' ? parseFloat(tp) : null;
    if (slNum != null) {
      if (isNaN(slNum) || slNum <= 0) return res.status(400).json({ error: 'Invalid Stop Loss price' });
      if (side === 'long' && slNum >= fillPrice) return res.status(400).json({ error: 'For a Buy, Stop Loss must be below the entry price' });
      if (side === 'short' && slNum <= fillPrice) return res.status(400).json({ error: 'For a Sell, Stop Loss must be above the entry price' });
    }
    if (tpNum != null) {
      if (isNaN(tpNum) || tpNum <= 0) return res.status(400).json({ error: 'Invalid Take Profit price' });
      if (side === 'long' && tpNum <= fillPrice) return res.status(400).json({ error: 'For a Buy, Take Profit must be above the entry price' });
      if (side === 'short' && tpNum >= fillPrice) return res.status(400).json({ error: 'For a Sell, Take Profit must be below the entry price' });
    }

    const now = Date.now();
    const info = db.prepare(
      'INSERT INTO positions (user_id, account_type, symbol, side, volume_lots, entry_price, sl, tp, status, opened_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(req.userId, accountType, symbol, side, vol, fillPrice, slNum, tpNum, 'open', now);

    res.json({ ok: true, position: { id: info.lastInsertRowid, symbol, side, volumeLots: vol, entryPrice: fillPrice, sl: slNum, tp: tpNum, openedAt: now, accountType } });
  });

  // Update SL/TP on an already-open position.
  router.post('/positions/:id/modify', requireAuth, (req, res) => {
    const accountType = getAccountType(req);
    const id = parseInt(req.params.id, 10);
    const pos = db.prepare("SELECT * FROM positions WHERE id = ? AND user_id = ? AND account_type = ? AND status = 'open'").get(id, req.userId, accountType);
    if (!pos) return res.status(404).json({ error: 'Open position not found' });

    const { sl, tp } = req.body || {};
    const slNum = sl != null && sl !== '' ? parseFloat(sl) : null;
    const tpNum = tp != null && tp !== '' ? parseFloat(tp) : null;
    if (slNum != null) {
      if (isNaN(slNum) || slNum <= 0) return res.status(400).json({ error: 'Invalid Stop Loss price' });
      if (pos.side === 'long' && slNum >= pos.entry_price) return res.status(400).json({ error: 'For a Buy, Stop Loss must be below the entry price' });
      if (pos.side === 'short' && slNum <= pos.entry_price) return res.status(400).json({ error: 'For a Sell, Stop Loss must be above the entry price' });
    }
    if (tpNum != null) {
      if (isNaN(tpNum) || tpNum <= 0) return res.status(400).json({ error: 'Invalid Take Profit price' });
      if (pos.side === 'long' && tpNum <= pos.entry_price) return res.status(400).json({ error: 'For a Buy, Take Profit must be above the entry price' });
      if (pos.side === 'short' && tpNum >= pos.entry_price) return res.status(400).json({ error: 'For a Sell, Take Profit must be below the entry price' });
    }

    db.prepare('UPDATE positions SET sl = ?, tp = ? WHERE id = ?').run(slNum, tpNum, id);
    res.json({ ok: true, sl: slNum, tp: tpNum });
  });

  router.post('/positions/:id/close', requireAuth, (req, res) => {
    const accountType = getAccountType(req);
    const id = parseInt(req.params.id, 10);
    const pos = db.prepare("SELECT * FROM positions WHERE id = ? AND user_id = ? AND account_type = ? AND status = 'open'").get(id, req.userId, accountType);
    if (!pos) return res.status(404).json({ error: 'Open position not found' });

    const closePrice = engine.getPrice(pos.symbol);
    const meta = engine.meta().find(m => m.sym === pos.symbol);
    const dir = pos.side === 'long' ? 1 : -1;
    const priceDelta = (closePrice - pos.entry_price) * dir;
    const pnlFinal = +(priceDelta * pos.volume_lots * (meta ? meta.contract : 100000)).toFixed(2);
    const now = Date.now();

    const tx = db.transaction(() => {
      db.prepare("UPDATE positions SET status='closed', close_price=?, pnl=?, closed_at=? WHERE id=?")
        .run(closePrice, pnlFinal, now, id);
      db.prepare('UPDATE wallets SET balance = balance + ?, updated_at = ? WHERE user_id = ? AND account_type = ?').run(pnlFinal, now, req.userId, accountType);
      db.prepare(
        'INSERT INTO ledger (user_id, account_type, type, amount, status, method, reference, note, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
      ).run(req.userId, accountType, 'trade_pnl', pnlFinal, 'completed', null, 'POS-' + id, `${pos.symbol} ${pos.side} closed`, now);
    });
    tx();

    res.json({ ok: true, closePrice, pnl: pnlFinal });
  });

  return router;
};

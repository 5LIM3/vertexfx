const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../auth');

module.exports = function adminRouter(engine, wss) {
  const router = express.Router();
  router.use(requireAuth, requireAdmin);

  // ---- Users ----
  router.get('/users', (req, res) => {
    const rows = db.prepare(`
      SELECT u.id, u.email, u.full_name, u.harbor_id, u.role, u.email_verified, u.suspended,
             u.totp_enabled, u.kyc_status, u.created_at
      FROM users u
      ORDER BY u.created_at DESC
    `).all();
    const wallets = db.prepare('SELECT user_id, account_type, balance FROM wallets').all();
    const balanceMap = {};
    for (const w of wallets) {
      balanceMap[w.user_id] = balanceMap[w.user_id] || {};
      balanceMap[w.user_id][w.account_type] = w.balance;
    }
    const enriched = rows.map(u => ({
      ...u,
      demoBalance: balanceMap[u.id]?.demo ?? 0,
      realBalance: balanceMap[u.id]?.real ?? 0,
    }));
    res.json({ users: enriched });
  });

  router.post('/users/:id/suspend', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { suspended } = req.body || {};
    db.prepare('UPDATE users SET suspended = ? WHERE id = ?').run(suspended ? 1 : 0, id);
    res.json({ ok: true });
  });

  router.post('/users/:id/role', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { role } = req.body || {};
    if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    res.json({ ok: true });
  });

  // ---- Deposits / withdrawals (mock ledger) ----
  router.get('/ledger', (req, res) => {
    const { type, status } = req.query;
    let sql = `SELECT l.*, u.email, u.full_name FROM ledger l JOIN users u ON u.id = l.user_id WHERE 1=1`;
    const params = [];
    if (type) { sql += ' AND l.type = ?'; params.push(type); }
    if (status) { sql += ' AND l.status = ?'; params.push(status); }
    sql += ' ORDER BY l.created_at DESC LIMIT 300';
    res.json({ entries: db.prepare(sql).all(...params) });
  });

  router.post('/withdrawals/:id/approve', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const row = db.prepare("SELECT * FROM ledger WHERE id = ? AND type = 'withdrawal' AND status = 'pending'").get(id);
    if (!row) return res.status(404).json({ error: 'Pending withdrawal not found' });
    db.prepare("UPDATE ledger SET status = 'completed' WHERE id = ?").run(id);
    res.json({ ok: true });
  });

  router.post('/withdrawals/:id/reject', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const row = db.prepare("SELECT * FROM ledger WHERE id = ? AND type = 'withdrawal' AND status = 'pending'").get(id);
    if (!row) return res.status(404).json({ error: 'Pending withdrawal not found' });
    const now = Date.now();
    const tx = db.transaction(() => {
      db.prepare("UPDATE ledger SET status = 'rejected' WHERE id = ?").run(id);
      db.prepare('UPDATE wallets SET balance = balance + ?, updated_at = ? WHERE user_id = ? AND account_type = ?')
        .run(Math.abs(row.amount), now, row.user_id, row.account_type);
    });
    tx();
    res.json({ ok: true });
  });

  // Pending crypto deposits — balance is only credited once an admin approves.
  router.post('/deposits/:id/approve', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const row = db.prepare("SELECT * FROM ledger WHERE id = ? AND type = 'deposit' AND status = 'pending'").get(id);
    if (!row) return res.status(404).json({ error: 'Pending deposit not found' });
    const now = Date.now();
    const tx = db.transaction(() => {
      db.prepare("UPDATE ledger SET status = 'completed' WHERE id = ?").run(id);
      db.prepare('UPDATE wallets SET balance = balance + ?, updated_at = ? WHERE user_id = ? AND account_type = ?')
        .run(row.amount, now, row.user_id, row.account_type);
    });
    tx();
    res.json({ ok: true });
  });

  router.post('/deposits/:id/reject', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { reason } = req.body || {};
    const row = db.prepare("SELECT * FROM ledger WHERE id = ? AND type = 'deposit' AND status = 'pending'").get(id);
    if (!row) return res.status(404).json({ error: 'Pending deposit not found' });
    db.prepare("UPDATE ledger SET status = 'rejected', note = ? WHERE id = ?")
      .run((row.note || '') + ` — Rejected: ${reason || 'proof not verified'}`, id);
    res.json({ ok: true });
  });

  // ---- Positions (all users) ----
  router.get('/positions', (req, res) => {
    const rows = db.prepare(`
      SELECT p.*, u.email, u.harbor_id FROM positions p JOIN users u ON u.id = p.user_id
      WHERE p.status = 'open' ORDER BY p.opened_at DESC
    `).all();
    const withLive = rows.map(p => {
      const live = engine.getPrice(p.symbol);
      const meta = engine.meta().find(m => m.sym === p.symbol);
      const dir = p.side === 'long' ? 1 : -1;
      const pnl = live != null ? (live - p.entry_price) * dir * p.volume_lots * (meta ? meta.contract : 100000) : 0;
      return { ...p, livePrice: live, pnl: +pnl.toFixed(2) };
    });
    res.json({ positions: withLive });
  });

  // ---- Market status / symbol controls ----
  router.get('/symbols', (req, res) => {
    const controls = db.prepare('SELECT * FROM symbol_controls').all();
    const controlMap = Object.fromEntries(controls.map(c => [c.symbol, c]));
    const rows = engine.meta().map(m => {
      const s = engine.symbols[m.sym];
      return {
        symbol: m.sym,
        cat: m.cat,
        source: s?.source || 'simulated',
        price: engine.getPrice(m.sym),
        livePrice: s?.livePrice ?? null,
        lastLiveUpdate: s?.lastLiveUpdate ?? null,
        neverConnected: !s?.lastLiveUpdate, // true = this symbol has NEVER received a real price, ever
        regime: s?.regime || 'normal',
        tradingEnabled: controlMap[m.sym] ? !!controlMap[m.sym].trading_enabled : true,
        leverageOverride: controlMap[m.sym]?.leverage_override ?? null,
      };
    });
    res.json({ symbols: rows });
  });

  router.post('/symbols/:symbol/regime', (req, res) => {
    const { symbol } = req.params;
    const { regime } = req.body || {};
    const ok = engine.setRegime(symbol, regime);
    if (!ok) return res.status(400).json({ error: 'Unknown symbol or invalid regime' });
    res.json({ ok: true, regime });
  });

  router.post('/symbols/:symbol/reset', (req, res) => {
    const { symbol } = req.params;
    const ok = engine.resetSimulation(symbol);
    if (!ok) return res.status(404).json({ error: 'Unknown symbol' });
    res.json({ ok: true, price: engine.getPrice(symbol) });
  });

  router.post('/symbols/:symbol/trading', (req, res) => {
    const { symbol } = req.params;
    const { enabled } = req.body || {};
    if (!engine.symbols[symbol]) return res.status(404).json({ error: 'Unknown symbol' });
    const now = Date.now();
    db.prepare(`
      INSERT INTO symbol_controls (symbol, trading_enabled, updated_at) VALUES (?,?,?)
      ON CONFLICT(symbol) DO UPDATE SET trading_enabled = excluded.trading_enabled, updated_at = excluded.updated_at
    `).run(symbol, enabled ? 1 : 0, now);
    res.json({ ok: true });
  });

  router.post('/symbols/:symbol/leverage', (req, res) => {
    const { symbol } = req.params;
    const { leverage } = req.body || {};
    if (!engine.symbols[symbol]) return res.status(404).json({ error: 'Unknown symbol' });
    const now = Date.now();
    db.prepare(`
      INSERT INTO symbol_controls (symbol, trading_enabled, leverage_override, updated_at) VALUES (?,1,?,?)
      ON CONFLICT(symbol) DO UPDATE SET leverage_override = excluded.leverage_override, updated_at = excluded.updated_at
    `).run(symbol, leverage || null, now);
    res.json({ ok: true });
  });

  // ---- Announcements ----
  router.get('/announcements', (req, res) => {
    res.json({ announcements: db.prepare('SELECT * FROM announcements ORDER BY created_at DESC').all() });
  });

  router.post('/announcements', (req, res) => {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message is required' });
    const now = Date.now();
    db.prepare('INSERT INTO announcements (message, active, created_at) VALUES (?,1,?)').run(message, now);
    res.json({ ok: true });
  });

  router.post('/announcements/:id/toggle', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const row = db.prepare('SELECT active FROM announcements WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    db.prepare('UPDATE announcements SET active = ? WHERE id = ?').run(row.active ? 0 : 1, id);
    res.json({ ok: true });
  });

  // ---- KYC queue ----
  router.get('/kyc', (req, res) => {
    const rows = db.prepare(`
      SELECT id, email, full_name, harbor_id, kyc_status, kyc_note, created_at
      FROM users WHERE kyc_status != 'not_started' ORDER BY created_at DESC
    `).all();
    res.json({ submissions: rows });
  });

  router.post('/kyc/:id/approve', (req, res) => {
    const id = parseInt(req.params.id, 10);
    db.prepare("UPDATE users SET kyc_status = 'approved' WHERE id = ?").run(id);
    res.json({ ok: true });
  });

  router.post('/kyc/:id/reject', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { reason } = req.body || {};
    db.prepare("UPDATE users SET kyc_status = 'rejected', kyc_note = ? WHERE id = ?").run(reason || 'Rejected by admin', id);
    res.json({ ok: true });
  });

  // ---- System health ----
  router.get('/health', (req, res) => {
    const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
    const openPositions = db.prepare("SELECT COUNT(*) c FROM positions WHERE status='open'").get().c;
    const pendingWithdrawals = db.prepare("SELECT COUNT(*) c FROM ledger WHERE type='withdrawal' AND status='pending'").get().c;
    res.json({
      uptimeSeconds: process.uptime(),
      userCount,
      openPositions,
      pendingWithdrawals,
      connectedClients: wss ? wss.clients.size : 0,
      symbolsLive: Object.values(engine.symbols).filter(s => s.source !== 'simulated').length,
      symbolsTotal: Object.keys(engine.symbols).length,
    });
  });

  return router;
};

const db = require('./db');

/**
 * Runs every engine tick. Auto-closes any open position whose Stop Loss or
 * Take Profit level has been crossed by the current simulation price.
 * Mirrors the manual close logic in routes/trading.js exactly, just
 * triggered by price instead of a user click.
 */
function checkStopLevels(engine) {
  const rows = db.prepare(
    "SELECT * FROM positions WHERE status = 'open' AND (sl IS NOT NULL OR tp IS NOT NULL)"
  ).all();
  if (!rows.length) return;

  for (const pos of rows) {
    const live = engine.getPrice(pos.symbol);
    if (live == null) continue;

    let trigger = null; // 'sl' | 'tp'
    if (pos.side === 'long') {
      if (pos.sl != null && live <= pos.sl) trigger = 'sl';
      else if (pos.tp != null && live >= pos.tp) trigger = 'tp';
    } else {
      if (pos.sl != null && live >= pos.sl) trigger = 'sl';
      else if (pos.tp != null && live <= pos.tp) trigger = 'tp';
    }
    if (!trigger) continue;

    const meta = engine.meta().find(m => m.sym === pos.symbol);
    const dir = pos.side === 'long' ? 1 : -1;
    const closePrice = trigger === 'sl' ? pos.sl : pos.tp; // fill at the set level, not the (possibly gapped) live price
    const priceDelta = (closePrice - pos.entry_price) * dir;
    const pnl = +(priceDelta * pos.volume_lots * (meta ? meta.contract : 100000)).toFixed(2);
    const now = Date.now();
    const label = trigger === 'sl' ? 'Stop Loss' : 'Take Profit';

    const tx = db.transaction(() => {
      db.prepare("UPDATE positions SET status='closed', close_price=?, pnl=?, closed_at=? WHERE id=?")
        .run(closePrice, pnl, now, pos.id);
      db.prepare('UPDATE wallets SET balance = balance + ?, updated_at = ? WHERE user_id = ? AND account_type = ?')
        .run(pnl, now, pos.user_id, pos.account_type);
      db.prepare(
        'INSERT INTO ledger (user_id, account_type, type, amount, status, method, reference, note, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
      ).run(pos.user_id, pos.account_type, 'trade_pnl', pnl, 'completed', null, 'POS-' + pos.id,
        `${pos.symbol} ${pos.side} closed by ${label}`, now);
    });
    tx();
  }
}

module.exports = { checkStopLevels };

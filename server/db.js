const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'vertexfx.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  harbor_id TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  email_verified INTEGER NOT NULL DEFAULT 0,
  suspended INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  backup_codes TEXT,
  kyc_status TEXT NOT NULL DEFAULT 'not_started',
  kyc_note TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wallets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_type TEXT NOT NULL DEFAULT 'demo', -- 'demo' | 'real'
  balance REAL NOT NULL DEFAULT 0,
  equity_locked REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, account_type)
);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_type TEXT NOT NULL DEFAULT 'demo',
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL,
  method TEXT,
  reference TEXT,
  note TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_type TEXT NOT NULL DEFAULT 'demo',
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  volume_lots REAL NOT NULL,
  entry_price REAL NOT NULL,
  sl REAL,
  tp REAL,
  status TEXT NOT NULL DEFAULT 'open',
  close_price REAL,
  pnl REAL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE TABLE IF NOT EXISTS email_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS symbol_controls (
  symbol TEXT PRIMARY KEY,
  trading_enabled INTEGER NOT NULL DEFAULT 1,
  leverage_override INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(user_id, account_type, status);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, account_type);
CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id, account_type);
CREATE INDEX IF NOT EXISTS idx_everif_token ON email_verifications(token);
`);

/**
 * node:sqlite's StatementSync.run()/get()/all() don't accept a plain JS
 * `undefined` the way better-sqlite3 does — normalize to null so
 * `db.prepare(...).run(x, undefined)`-style calls from routes keep working.
 */
const rawPrepare = db.prepare.bind(db);
db.prepare = (sql) => {
  const stmt = rawPrepare(sql);
  const wrap = (fn) => (...args) => fn(...args.map(a => (a === undefined ? null : a)));
  return {
    run: wrap(stmt.run.bind(stmt)),
    get: wrap(stmt.get.bind(stmt)),
    all: wrap(stmt.all.bind(stmt)),
  };
};

// Minimal transaction helper matching the better-sqlite3 call pattern used in routes:
//   const tx = db.transaction(() => { ... }); tx();
db.transaction = (fn) => {
  return (...args) => {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
};

module.exports = db;

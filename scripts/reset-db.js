/**
 * Wipe the entire database — all users, wallets, positions, everything.
 * Usage: npm run reset-db
 * Then restart the server (npm start) for a completely fresh site.
 */
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');

if (fs.existsSync(dataDir)) {
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('✓ Database wiped. Run `npm start` for a completely fresh site — no users, no trades, nothing.');
} else {
  console.log('No data directory found — already fresh.');
}

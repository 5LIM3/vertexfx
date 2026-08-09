/**
 * Promote a user to admin.
 * Usage: node scripts/make-admin.js you@example.com
 */
const db = require('../server/db');

const email = process.argv[2];
if (!email) {
  console.error('Usage: node scripts/make-admin.js <email>');
  process.exit(1);
}

const user = db.prepare('SELECT id, email, role FROM users WHERE email = ?').get(email.toLowerCase());
if (!user) {
  console.error(`No user found with email ${email}. Sign up first, then run this script.`);
  process.exit(1);
}

db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
console.log(`✓ ${user.email} is now an admin. Log out and back in, then visit /admin.html`);

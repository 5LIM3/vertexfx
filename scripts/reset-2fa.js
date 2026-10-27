const db = require('../server/db');

const email = process.argv[2];
if (!email) {
  console.error('Usage: node scripts/reset-2fa.js <email>');
  process.exit(1);
}

const user = db.prepare('SELECT id, email, totp_enabled FROM users WHERE email = ?').get(email.toLowerCase());
if (!user) {
  console.error(`No user found with email ${email}.`);
  process.exit(1);
}

db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, backup_codes = NULL WHERE id = ?').run(user.id);
console.log(`✓ 2FA cleared for ${user.email}. Log in with your password, then re-enable 2FA on the Security page.`);

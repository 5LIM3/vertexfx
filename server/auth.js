const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const TOKEN_TTL = '7d';

function signToken(user) {
  return jwt.sign({ uid: user.id, harborId: user.harbor_id }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

// Short-lived token issued after password check but before a required 2FA code —
// only usable against the /api/auth/2fa/verify endpoint, not general API access.
function signTempToken(user) {
  return jwt.sign({ uid: user.id, stage: '2fa_pending' }, JWT_SECRET, { expiresIn: '10m' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

/** Express middleware — requires a valid session cookie or Bearer token. */
function requireAuth(req, res, next) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const token = req.cookies?.vfx_token || bearer;
  const payload = token && verifyToken(token);
  if (!payload || payload.stage === '2fa_pending') return res.status(401).json({ error: 'Not authenticated' });
  req.userId = payload.uid;
  next();
}

/** Express middleware — requires an authenticated admin user. Chain after requireAuth. */
function requireAdmin(req, res, next) {
  const row = db.prepare('SELECT role, suspended FROM users WHERE id = ?').get(req.userId);
  if (!row || row.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  if (row.suspended) return res.status(403).json({ error: 'Account suspended' });
  next();
}

module.exports = { signToken, signTempToken, verifyToken, requireAuth, requireAdmin };

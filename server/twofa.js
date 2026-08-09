const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const crypto = require('crypto');

authenticator.options = { window: 1 }; // allow 1 step of clock drift

function generateSecret() {
  return authenticator.generateSecret();
}

function otpAuthUrl(email, secret) {
  return authenticator.keyuri(email, 'VertexFX', secret);
}

async function qrDataUrl(otpauthUrl) {
  return QRCode.toDataURL(otpauthUrl);
}

function verifyToken(token, secret) {
  try {
    return authenticator.verify({ token, secret });
  } catch {
    return false;
  }
}

function generateBackupCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    codes.push(crypto.randomBytes(5).toString('hex').toUpperCase().match(/.{1,5}/g).join('-'));
  }
  return codes;
}

function hashBackupCode(code) {
  return crypto.createHash('sha256').update(code.toUpperCase()).digest('hex');
}

module.exports = { generateSecret, otpAuthUrl, qrDataUrl, verifyToken, generateBackupCodes, hashBackupCode };

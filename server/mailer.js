const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const FROM_ADDR = process.env.SMTP_FROM || 'VertexFX Demo <no-reply@vertexfx.demo>';
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';

let transporter = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

/**
 * Sends an email if SMTP is configured (.env: SMTP_HOST/PORT/USER/PASS).
 * If not configured, logs the email to the console instead — this keeps the
 * verification flow fully functional in dev without requiring real SMTP.
 */
async function sendMail({ to, subject, html, text }) {
  if (!transporter) {
    console.log('\n===== [DEV MAIL — no SMTP configured] =====');
    console.log('To:', to);
    console.log('Subject:', subject);
    console.log(text || html);
    console.log('=============================================\n');
    return { dev: true };
  }
  return transporter.sendMail({ from: FROM_ADDR, to, subject, html, text });
}

async function sendVerificationEmail(toEmail, token) {
  const link = `${APP_BASE_URL}/verify-email.html?token=${token}`;
  return sendMail({
    to: toEmail,
    subject: 'Verify your VertexFX demo account',
    text: `Verify your email: ${link}\n\nThis link expires in 24 hours. VertexFX is a simulated demo platform — no real funds are involved.`,
    html: `<p>Welcome to VertexFX (demo platform).</p><p>Click below to verify your email and activate your account:</p><p><a href="${link}">${link}</a></p><p>This link expires in 24 hours.</p>`,
  });
}

module.exports = { sendMail, sendVerificationEmail, APP_BASE_URL };

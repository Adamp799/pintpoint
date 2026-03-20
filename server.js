const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '.env.local') });
const bcrypt = require('bcryptjs');
const session = require('express-session');
const helmet = require('helmet');
const nodemailer = require('nodemailer');
const FileStore = require('session-file-store')(session);

const PORT = Number(process.env.PORT || 3000);
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const SESSION_SECRET = process.env.SESSION_SECRET || 'replace-this-in-production';
const DEV_CODE = 'boucherpeach';
const VERIFY_WINDOW_MS = 12 * 60 * 60 * 1000;
const RESET_WINDOW_MS = 60 * 60 * 1000;

const app = express();
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const PUBS_FILE = path.join(DATA_DIR, 'pubs.json');
const USERS_FILE = path.join(DATA_DIR, 'users.private.json');
const PROPOSALS_FILE = path.join(DATA_DIR, 'update-proposals.private.json');
const MAIL_LOG_FILE = path.join(DATA_DIR, 'verification-mails.private.log');
const RESET_MAIL_LOG_FILE = path.join(DATA_DIR, 'password-reset-mails.private.log');
const AUDIT_LOG_FILE = path.join(DATA_DIR, 'developer-audit.private.json');
const SESSION_DIR = path.join(ROOT_DIR, '.sessions');
const ipRateLimits = new Map();

function ensurePath() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');
  if (!fs.existsSync(PROPOSALS_FILE)) fs.writeFileSync(PROPOSALS_FILE, '[]');
  if (!fs.existsSync(MAIL_LOG_FILE)) fs.writeFileSync(MAIL_LOG_FILE, '');
  if (!fs.existsSync(RESET_MAIL_LOG_FILE)) fs.writeFileSync(RESET_MAIL_LOG_FILE, '');
  if (!fs.existsSync(AUDIT_LOG_FILE)) fs.writeFileSync(AUDIT_LOG_FILE, '[]');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_err) {
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeUsername(username) {
  return String(username || '').trim();
}

function formatDateStamp(value = Date.now()) {
  const date = new Date(value);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

function safeUser(user) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
    verified: Boolean(user.verified)
  };
}

function purgeExpiredUnverifiedUsers() {
  const users = readJson(USERS_FILE, []);
  const now = Date.now();
  const kept = users.filter((u) => {
    if (u.verified) return true;
    return now - Number(u.createdAt || 0) < VERIFY_WINDOW_MS;
  });
  if (kept.length !== users.length) writeJson(USERS_FILE, kept);
}

function usernameTaken(users, username, excludeUserId = null) {
  const candidate = normalizeUsername(username).toLowerCase();
  return users.some((u) => u.id !== excludeUserId && normalizeUsername(u.username).toLowerCase() === candidate);
}

function makeToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

function makeCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function getIp(req) {
  const header = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return header || req.ip || 'unknown-ip';
}

function getTransporter() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const port = Number(process.env.SMTP_PORT || 587);
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });
}

async function sendVerificationEmail(user, verificationToken, verificationCode) {
  const verifyUrl = `${APP_BASE_URL}/?verify=${verificationToken}`;
  const textBody = [
    `Hi ${user.username},`,
    '',
    'Please verify your PintPoint account within 12 hours.',
    `Verification link: ${verifyUrl}`,
    `Verification code: ${verificationCode}`,
    '',
    'If you did not create this account, you can ignore this email.'
  ].join('\n');

  const transporter = getTransporter();
  if (!transporter) {
    fs.appendFileSync(
      MAIL_LOG_FILE,
      `[${new Date().toISOString()}] ${user.email} | link=${verifyUrl} | code=${verificationCode}\n`
    );
    return { delivered: false, fallback: true };
  }

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: user.email,
    subject: 'Verify your PintPoint account',
    text: textBody
  });
  return { delivered: true, fallback: false };
}

async function sendPasswordResetEmail(user, resetToken, resetCode) {
  const resetUrl = `${APP_BASE_URL}/?reset=${resetToken}`;
  const textBody = [
    `Hi ${user.username},`,
    '',
    'You requested a PintPoint password reset.',
    `Reset link: ${resetUrl}`,
    `Reset code: ${resetCode}`,
    '',
    'This reset expires in 1 hour. If this was not you, ignore this email.'
  ].join('\n');

  const transporter = getTransporter();
  if (!transporter) {
    fs.appendFileSync(
      RESET_MAIL_LOG_FILE,
      `[${new Date().toISOString()}] ${user.email} | link=${resetUrl} | code=${resetCode}\n`
    );
    return { delivered: false, fallback: true };
  }

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: user.email,
    subject: 'Reset your PintPoint password',
    text: textBody
  });
  return { delivered: true, fallback: false };
}

function consumeRateLimit(user, key, maxEvents, windowMs) {
  const now = Date.now();
  if (!user.rateLimits) user.rateLimits = {};
  const history = Array.isArray(user.rateLimits[key]) ? user.rateLimits[key] : [];
  const recent = history.filter((timestamp) => now - Number(timestamp) <= windowMs);
  if (recent.length >= maxEvents) return false;
  recent.push(now);
  user.rateLimits[key] = recent;
  return true;
}

function consumeIpRateLimit(ip, key, maxEvents, windowMs) {
  const now = Date.now();
  const mapKey = `${key}:${ip}`;
  const history = Array.isArray(ipRateLimits.get(mapKey)) ? ipRateLimits.get(mapKey) : [];
  const recent = history.filter((timestamp) => now - Number(timestamp) <= windowMs);
  if (recent.length >= maxEvents) return false;
  recent.push(now);
  ipRateLimits.set(mapKey, recent);
  return true;
}

function consumeCombinedRateLimit(req, user, key, maxEvents, windowMs) {
  const ip = getIp(req);
  const ipOk = consumeIpRateLimit(ip, key, maxEvents, windowMs);
  const userOk = consumeRateLimit(user, key, maxEvents, windowMs);
  return ipOk && userOk;
}

function addAuditLog(entry) {
  const log = readJson(AUDIT_LOG_FILE, []);
  log.push(entry);
  writeJson(AUDIT_LOG_FILE, log.slice(-2000));
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Please log in first.' });
  }
  const users = readJson(USERS_FILE, []);
  const user = users.find((u) => u.id === req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  }
  req.user = user;
  req.allUsers = users;
  return next();
}

function requireVerified(req, res, next) {
  if (!req.user.verified) {
    return res.status(403).json({ error: 'Please verify your email before submitting updates.' });
  }
  return next();
}

function requireDeveloper(req, res, next) {
  if (req.user.role !== 'developer') {
    return res.status(403).json({ error: 'Developer access required.' });
  }
  return next();
}

ensurePath();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(
  session({
    store: new FileStore({ path: SESSION_DIR, retries: 1 }),
    name: 'pintpoint.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  })
);

app.use((req, res, next) => {
  purgeExpiredUnverifiedUsers();
  next();
});

app.get('/api/auth/me', (req, res) => {
  const users = readJson(USERS_FILE, []);
  const user = users.find((u) => u.id === req.session.userId);
  res.json({ user: user ? safeUser(user) : null });
});

app.post('/api/auth/signup', async (req, res) => {
  if (!consumeIpRateLimit(getIp(req), 'signup', 20, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many signup attempts from this IP. Try again later.' });
  }
  const email = normalizeEmail(req.body.email);
  const username = normalizeUsername(req.body.username);
  const password = String(req.body.password || '');
  const code = String(req.body.code || '').trim();

  if (!email || !username || !password) {
    return res.status(400).json({ error: 'Email, username, and password are required.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (username.length < 3 || username.length > 24) {
    return res.status(400).json({ error: 'Username must be between 3 and 24 characters.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
  }

  const users = readJson(USERS_FILE, []);
  if (users.some((u) => normalizeEmail(u.email) === email)) {
    return res.status(409).json({ error: 'This email is already registered.' });
  }
  if (usernameTaken(users, username)) {
    return res.status(409).json({ error: 'That username is already in use.' });
  }

  const verificationToken = makeToken(24);
  const verificationCode = makeCode();
  const passwordHash = await bcrypt.hash(password, 12);
  const role = code === DEV_CODE ? 'developer' : 'user';
  const user = {
    id: makeToken(12),
    email,
    username,
    passwordHash,
    role,
    verified: false,
    verificationToken,
    verificationCodeHash: await bcrypt.hash(verificationCode, 10),
    verificationExpiresAt: Date.now() + VERIFY_WINDOW_MS,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    rateLimits: {}
  };
  users.push(user);
  writeJson(USERS_FILE, users);
  req.session.userId = user.id;

  try {
    const result = await sendVerificationEmail(user, verificationToken, verificationCode);
    return res.status(201).json({
      user: safeUser(user),
      message: result.delivered
        ? 'Account created. Check your inbox to verify your email within 12 hours.'
        : 'Account created. Email service is not configured, so verification details were logged on the server.'
    });
  } catch (_err) {
    return res.status(201).json({
      user: safeUser(user),
      message: 'Account created, but verification email failed to send. Please ask an admin to check SMTP settings.'
    });
  }
});

app.post('/api/auth/login', async (req, res) => {
  if (!consumeIpRateLimit(getIp(req), 'login', 40, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many login attempts from this IP. Try again later.' });
  }
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  const users = readJson(USERS_FILE, []);
  const user = users.find((u) => normalizeEmail(u.email) === email);
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  req.session.userId = user.id;
  return res.json({ user: safeUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('pintpoint.sid');
    res.json({ ok: true });
  });
});

app.get('/api/auth/verify', requireAuth, (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).json({ error: 'Verification token is missing.' });

  if (req.user.verified) {
    return res.json({ user: safeUser(req.user), message: 'Your email is already verified.' });
  }
  if (req.user.verificationToken !== token) {
    return res.status(400).json({ error: 'This verification link does not match your logged-in account.' });
  }
  if (Date.now() > Number(req.user.verificationExpiresAt || 0)) {
    return res.status(400).json({ error: 'Verification token has expired. Please sign up again.' });
  }

  req.user.verified = true;
  req.user.verificationToken = null;
  req.user.verificationCodeHash = null;
  req.user.verificationExpiresAt = null;
  req.user.updatedAt = Date.now();
  writeJson(USERS_FILE, req.allUsers);
  return res.json({ user: safeUser(req.user), message: 'Your email has been verified.' });
});

app.post('/api/auth/verify-code', requireAuth, async (req, res) => {
  if (!consumeIpRateLimit(getIp(req), 'verifyCode', 30, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many verification attempts from this IP. Try again later.' });
  }
  const code = String(req.body.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Verification code is required.' });

  if (req.user.verified) return res.json({ user: safeUser(req.user), message: 'Email already verified.' });
  if (Date.now() > Number(req.user.verificationExpiresAt || 0)) {
    return res.status(400).json({ error: 'Verification window expired. Please sign up again.' });
  }
  if (!req.user.verificationCodeHash) {
    return res.status(400).json({ error: 'No verification code is active for this account.' });
  }
  const ok = await bcrypt.compare(code, req.user.verificationCodeHash);
  if (!ok) return res.status(400).json({ error: 'Incorrect verification code.' });

  req.user.verified = true;
  req.user.verificationToken = null;
  req.user.verificationCodeHash = null;
  req.user.verificationExpiresAt = null;
  req.user.updatedAt = Date.now();
  writeJson(USERS_FILE, req.allUsers);
  return res.json({ user: safeUser(req.user), message: 'Your email has been verified.' });
});

app.post('/api/auth/resend-verification', requireAuth, async (req, res) => {
  if (!consumeIpRateLimit(getIp(req), 'resendVerification', 20, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many resend attempts from this IP. Try again later.' });
  }

  if (req.user.verified) return res.json({ message: 'That account is already verified.' });
  if (Date.now() > Number(req.user.verificationExpiresAt || 0)) {
    return res.status(400).json({ error: 'Verification window expired. Please sign up again.' });
  }

  const verificationToken = makeToken(24);
  const verificationCode = makeCode();
  req.user.verificationToken = verificationToken;
  req.user.verificationCodeHash = await bcrypt.hash(verificationCode, 10);
  req.user.updatedAt = Date.now();
  writeJson(USERS_FILE, req.allUsers);
  await sendVerificationEmail(req.user, verificationToken, verificationCode);
  return res.json({ message: 'Verification email sent.' });
});

app.post('/api/auth/request-password-reset', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  if (!email) return res.status(400).json({ error: 'Email is required.' });
  if (!consumeIpRateLimit(getIp(req), 'passwordResetRequest', 15, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many reset requests from this IP. Try again later.' });
  }

  const users = readJson(USERS_FILE, []);
  const user = users.find((u) => normalizeEmail(u.email) === email);
  if (!user) return res.json({ message: 'If that email exists, reset instructions have been sent.' });
  const resetToken = makeToken(24);
  const resetCode = makeCode();
  user.resetToken = resetToken;
  user.resetCodeHash = await bcrypt.hash(resetCode, 10);
  user.resetExpiresAt = Date.now() + RESET_WINDOW_MS;
  user.updatedAt = Date.now();
  writeJson(USERS_FILE, users);
  await sendPasswordResetEmail(user, resetToken, resetCode);
  return res.json({ message: 'If that email exists, reset instructions have been sent.' });
});

app.post('/api/auth/reset-password', async (req, res) => {
  if (!consumeIpRateLimit(getIp(req), 'passwordResetSubmit', 25, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many password reset attempts from this IP. Try again later.' });
  }
  const email = normalizeEmail(req.body.email);
  const token = String(req.body.token || '').trim();
  const code = String(req.body.code || '').trim();
  const newPassword = String(req.body.newPassword || '');
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters long.' });
  }
  if (!email && !token) {
    return res.status(400).json({ error: 'Email or reset token is required.' });
  }

  const users = readJson(USERS_FILE, []);
  const user = token
    ? users.find((u) => u.resetToken === token)
    : users.find((u) => normalizeEmail(u.email) === email);
  if (!user) return res.status(400).json({ error: 'Invalid reset credentials.' });
  if (!user.resetExpiresAt || Date.now() > Number(user.resetExpiresAt)) {
    return res.status(400).json({ error: 'Reset token/code expired. Request a new reset.' });
  }
  if (token) {
    if (user.resetToken !== token) return res.status(400).json({ error: 'Invalid reset token.' });
  } else if (!code || !user.resetCodeHash || !(await bcrypt.compare(code, user.resetCodeHash))) {
    return res.status(400).json({ error: 'Invalid reset code.' });
  }

  user.passwordHash = await bcrypt.hash(newPassword, 12);
  user.resetToken = null;
  user.resetCodeHash = null;
  user.resetExpiresAt = null;
  user.updatedAt = Date.now();
  writeJson(USERS_FILE, users);
  return res.json({ message: 'Password reset successful. You can now log in.' });
});

app.post('/api/auth/change-username', requireAuth, requireVerified, (req, res) => {
  const nextName = normalizeUsername(req.body.username);
  if (nextName.length < 3 || nextName.length > 24) {
    return res.status(400).json({ error: 'Username must be between 3 and 24 characters.' });
  }
  if (usernameTaken(req.allUsers, nextName, req.user.id)) {
    return res.status(409).json({ error: 'That username is already in use.' });
  }
  if (!consumeCombinedRateLimit(req, req.user, 'usernameChange', 3, 24 * 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Username change limit reached. Try again in 24 hours.' });
  }
  req.user.username = nextName;
  req.user.updatedAt = Date.now();
  writeJson(USERS_FILE, req.allUsers);
  return res.json({ user: safeUser(req.user), message: 'Username updated.' });
});

app.post('/api/proposals', requireAuth, requireVerified, (req, res) => {
  if (!consumeCombinedRateLimit(req, req.user, 'pubUpdate', 10, 24 * 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Daily update limit reached. Try again tomorrow.' });
  }
  const pubId = String(req.body.pubId || '').trim();
  const proposedPintName = String(req.body.proposedPintName || '').trim();
  const proposedPintPrice = Number(req.body.proposedPintPrice);
  if (!pubId || !proposedPintName || !Number.isFinite(proposedPintPrice)) {
    return res.status(400).json({ error: 'Pub, pint name, and pint price are required.' });
  }
  if (proposedPintName.length > 80) {
    return res.status(400).json({ error: 'Pint name is too long.' });
  }
  if (proposedPintPrice < 0.5 || proposedPintPrice > 30) {
    return res.status(400).json({ error: 'Pint price must be between 0.50 and 30.00.' });
  }

  const pubs = readJson(PUBS_FILE, []);
  const pub = pubs.find((p) => p.id === pubId);
  if (!pub) return res.status(404).json({ error: 'Pub not found.' });
  const normalizedCurrentName = String(pub.cheapestPintName || '').trim().toLowerCase();
  const normalizedProposedName = proposedPintName.toLowerCase();
  const roundedCurrentPrice = Number(Number(pub.cheapestPint).toFixed(2));
  const roundedProposedPrice = Number(proposedPintPrice.toFixed(2));
  if (normalizedCurrentName === normalizedProposedName && roundedCurrentPrice === roundedProposedPrice) {
    return res.status(400).json({ error: 'No changes detected. Update at least one field before submitting.' });
  }

  const proposals = readJson(PROPOSALS_FILE, []);
  proposals.push({
    id: makeToken(10),
    pubId: pub.id,
    pubName: pub.name,
    currentPintName: pub.cheapestPintName || '',
    currentPintPrice: pub.cheapestPint,
    proposedPintName,
    proposedPintPrice: roundedProposedPrice,
    submittedByUserId: req.user.id,
    submittedByUsername: req.user.username,
    submittedAt: Date.now()
  });
  writeJson(PROPOSALS_FILE, proposals);
  writeJson(USERS_FILE, req.allUsers);
  return res.status(201).json({ message: 'Update submitted for review.' });
});

app.get('/api/developer/proposals', requireAuth, requireVerified, requireDeveloper, (_req, res) => {
  const proposals = readJson(PROPOSALS_FILE, []).sort((a, b) => b.submittedAt - a.submittedAt);
  res.json({ proposals });
});

app.post('/api/developer/proposals/:proposalId/reject', requireAuth, requireVerified, requireDeveloper, (req, res) => {
  const proposalId = String(req.params.proposalId || '');
  const proposals = readJson(PROPOSALS_FILE, []);
  const proposal = proposals.find((p) => p.id === proposalId);
  const next = proposals.filter((p) => p.id !== proposalId);
  if (next.length === proposals.length) return res.status(404).json({ error: 'Proposal not found.' });
  writeJson(PROPOSALS_FILE, next);
  addAuditLog({
    id: makeToken(10),
    action: 'reject',
    actedAt: Date.now(),
    actedByUserId: req.user.id,
    actedByUsername: req.user.username,
    actedByRole: req.user.role,
    ip: getIp(req),
    proposal
  });
  return res.json({ ok: true });
});

app.post('/api/developer/proposals/:proposalId/approve', requireAuth, requireVerified, requireDeveloper, (req, res) => {
  const proposalId = String(req.params.proposalId || '');
  const proposals = readJson(PROPOSALS_FILE, []);
  const proposal = proposals.find((p) => p.id === proposalId);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found.' });

  const pubs = readJson(PUBS_FILE, []);
  const pub = pubs.find((p) => p.id === proposal.pubId);
  if (!pub) return res.status(404).json({ error: 'Associated pub no longer exists.' });

  pub.cheapestPintName = proposal.proposedPintName;
  pub.cheapestPint = proposal.proposedPintPrice;
  pub.lastUpdated = formatDateStamp();

  writeJson(PUBS_FILE, pubs);
  writeJson(PROPOSALS_FILE, proposals.filter((p) => p.id !== proposalId));
  addAuditLog({
    id: makeToken(10),
    action: 'approve',
    actedAt: Date.now(),
    actedByUserId: req.user.id,
    actedByUsername: req.user.username,
    actedByRole: req.user.role,
    ip: getIp(req),
    proposal,
    appliedUpdate: {
      pubId: pub.id,
      cheapestPintName: pub.cheapestPintName,
      cheapestPint: pub.cheapestPint
    }
  });
  return res.json({ ok: true, updatedPub: pub });
});

app.get('/api/developer/audit', requireAuth, requireVerified, requireDeveloper, (_req, res) => {
  const log = readJson(AUDIT_LOG_FILE, []).sort((a, b) => b.actedAt - a.actedAt).slice(0, 200);
  return res.json({ entries: log });
});

app.use((req, res, next) => {
  if (
    req.path === '/data/users.private.json' ||
    req.path === '/data/update-proposals.private.json' ||
    req.path === '/data/verification-mails.private.log' ||
    req.path === '/data/password-reset-mails.private.log' ||
    req.path === '/data/developer-audit.private.json'
  ) {
    return res.status(403).send('Forbidden');
  }
  return next();
});

app.use(express.static(ROOT_DIR));

app.get('*', (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`PintPoint running on ${APP_BASE_URL}`);
});

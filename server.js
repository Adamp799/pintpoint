const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '.env.local') });
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const nodemailer = require('nodemailer');
const cookieSession = require('cookie-session');
const { createClient } = require('@supabase/supabase-js');

const PORT = Number(process.env.PORT || 3000);
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const SESSION_SECRET = process.env.SESSION_SECRET || 'replace-this-in-production';
const DEV_CODE = 'boucherpeach';
const VERIFY_WINDOW_MS = 12 * 60 * 60 * 1000;
const RESET_WINDOW_MS = 60 * 60 * 1000;
const IS_VERCEL = Boolean(process.env.VERCEL);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const app = express();
const ROOT_DIR = __dirname;
const SOURCE_PUBS_FILE = path.join(ROOT_DIR, 'data', 'pubs.json');
const ipRateLimits = new Map();
let initPromise = null;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeUsername(username) {
  return String(username || '').trim();
}

function makeToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

function makeCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function formatDateStamp(value = Date.now()) {
  const date = new Date(value);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

function getIp(req) {
  const header = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return header || req.ip || 'unknown-ip';
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

function consumeRateLimit(user, key, maxEvents, windowMs) {
  const now = Date.now();
  if (!user.rateLimits || typeof user.rateLimits !== 'object') user.rateLimits = {};
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
  const ipOk = consumeIpRateLimit(getIp(req), key, maxEvents, windowMs);
  const userOk = consumeRateLimit(user, key, maxEvents, windowMs);
  return ipOk && userOk;
}

function usernameTaken(users, username, excludeUserId = null) {
  const candidate = normalizeUsername(username).toLowerCase();
  return users.some((user) => user.id !== excludeUserId && normalizeUsername(user.username).toLowerCase() === candidate);
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
    `Verification code: ${verificationCode}`
  ].join('\n');
  const transporter = getTransporter();
  if (!transporter) {
    console.log(`[mail-fallback] verify ${user.email} link=${verifyUrl} code=${verificationCode}`);
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
    'This reset expires in 1 hour.'
  ].join('\n');
  const transporter = getTransporter();
  if (!transporter) {
    console.log(`[mail-fallback] reset ${user.email} link=${resetUrl} code=${resetCode}`);
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

function mapPubToRow(pub) {
  return {
    id: pub.id,
    name: pub.name,
    address: pub.address,
    description: pub.description,
    cheapest_pint: pub.cheapestPint,
    cheapest_pint_name: pub.cheapestPintName,
    lat: pub.lat,
    lng: pub.lng,
    last_updated: pub.lastUpdated || formatDateStamp()
  };
}

function mapRowToPub(row) {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    description: row.description,
    cheapestPint: Number(row.cheapest_pint),
    cheapestPintName: row.cheapest_pint_name,
    lat: Number(row.lat),
    lng: Number(row.lng),
    lastUpdated: row.last_updated || formatDateStamp()
  };
}

function mapUserToRow(user) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    password_hash: user.passwordHash,
    role: user.role,
    verified: Boolean(user.verified),
    verification_token: user.verificationToken || null,
    verification_code_hash: user.verificationCodeHash || null,
    verification_expires_at: user.verificationExpiresAt || null,
    reset_token: user.resetToken || null,
    reset_code_hash: user.resetCodeHash || null,
    reset_expires_at: user.resetExpiresAt || null,
    created_at: user.createdAt || Date.now(),
    updated_at: user.updatedAt || Date.now(),
    rate_limits: user.rateLimits || {}
  };
}

function mapRowToUser(row) {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role,
    verified: Boolean(row.verified),
    verificationToken: row.verification_token,
    verificationCodeHash: row.verification_code_hash,
    verificationExpiresAt: row.verification_expires_at,
    resetToken: row.reset_token,
    resetCodeHash: row.reset_code_hash,
    resetExpiresAt: row.reset_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rateLimits: row.rate_limits || {}
  };
}

function mapProposalToRow(proposal) {
  return {
    id: proposal.id,
    pub_id: proposal.pubId,
    pub_name: proposal.pubName,
    current_pint_name: proposal.currentPintName,
    current_pint_price: proposal.currentPintPrice,
    proposed_pint_name: proposal.proposedPintName,
    proposed_pint_price: proposal.proposedPintPrice,
    submitted_by_user_id: proposal.submittedByUserId,
    submitted_by_username: proposal.submittedByUsername,
    submitted_at: proposal.submittedAt
  };
}

function mapRowToProposal(row) {
  return {
    id: row.id,
    pubId: row.pub_id,
    pubName: row.pub_name,
    currentPintName: row.current_pint_name,
    currentPintPrice: Number(row.current_pint_price),
    proposedPintName: row.proposed_pint_name,
    proposedPintPrice: Number(row.proposed_pint_price),
    submittedByUserId: row.submitted_by_user_id,
    submittedByUsername: row.submitted_by_username,
    submittedAt: row.submitted_at
  };
}

function mapAuditToRow(entry) {
  return {
    id: entry.id,
    action: entry.action,
    acted_at: entry.actedAt,
    acted_by_user_id: entry.actedByUserId,
    acted_by_username: entry.actedByUsername,
    acted_by_role: entry.actedByRole,
    ip: entry.ip,
    proposal: entry.proposal || null,
    applied_update: entry.appliedUpdate || null
  };
}

function mapRowToAudit(row) {
  return {
    id: row.id,
    action: row.action,
    actedAt: row.acted_at,
    actedByUserId: row.acted_by_user_id,
    actedByUsername: row.acted_by_username,
    actedByRole: row.acted_by_role,
    ip: row.ip,
    proposal: row.proposal,
    appliedUpdate: row.applied_update
  };
}

async function dbSelectSingle(table, key, value) {
  const { data, error } = await supabase.from(table).select('*').eq(key, value).limit(1);
  if (error) throw error;
  return data[0] || null;
}

async function listPubs() {
  const { data, error } = await supabase.from('pubs').select('*').order('name');
  if (error) throw error;
  return data.map(mapRowToPub);
}

async function getPubById(pubId) {
  const row = await dbSelectSingle('pubs', 'id', pubId);
  return row ? mapRowToPub(row) : null;
}

async function savePub(pub) {
  const { error } = await supabase.from('pubs').upsert(mapPubToRow(pub), { onConflict: 'id' });
  if (error) throw error;
}

async function listUsers() {
  const { data, error } = await supabase.from('users').select('*');
  if (error) throw error;
  return data.map(mapRowToUser);
}

async function getUserById(userId) {
  const row = await dbSelectSingle('users', 'id', userId);
  return row ? mapRowToUser(row) : null;
}

async function getUserByEmail(email) {
  const row = await dbSelectSingle('users', 'email', normalizeEmail(email));
  return row ? mapRowToUser(row) : null;
}

async function saveUser(user) {
  const { error } = await supabase.from('users').upsert(mapUserToRow(user), { onConflict: 'id' });
  if (error) throw error;
}

async function deleteExpiredUnverifiedUsers() {
  const cutoff = Date.now() - VERIFY_WINDOW_MS;
  const { error } = await supabase.from('users').delete().eq('verified', false).lt('created_at', cutoff);
  if (error) throw error;
}

async function listProposals() {
  const { data, error } = await supabase.from('proposals').select('*').order('submitted_at', { ascending: false });
  if (error) throw error;
  return data.map(mapRowToProposal);
}

async function getProposalById(proposalId) {
  const row = await dbSelectSingle('proposals', 'id', proposalId);
  return row ? mapRowToProposal(row) : null;
}

async function saveProposal(proposal) {
  const { error } = await supabase.from('proposals').insert(mapProposalToRow(proposal));
  if (error) throw error;
}

async function deleteProposal(proposalId) {
  const { error } = await supabase.from('proposals').delete().eq('id', proposalId);
  if (error) throw error;
}

async function listAuditLogs() {
  const { data, error } = await supabase.from('audit_logs').select('*').order('acted_at', { ascending: false }).limit(200);
  if (error) throw error;
  return data.map(mapRowToAudit);
}

async function appendAudit(entry) {
  const { error } = await supabase.from('audit_logs').insert(mapAuditToRow(entry));
  if (error) throw error;
}

async function ensureSupabaseReady() {
  const { error } = await supabase.from('pubs').select('id').limit(1);
  if (error) {
    throw new Error(
      `Supabase tables are missing or inaccessible (${error.message}). Run supabase/schema.sql and set env vars.`
    );
  }
  const { count, error: countError } = await supabase.from('pubs').select('id', { head: true, count: 'exact' });
  if (countError) throw countError;
  if (Number(count || 0) > 0) return;
  const seed = JSON.parse(fs.readFileSync(SOURCE_PUBS_FILE, 'utf8'));
  if (!seed.length) return;
  const { error: upsertError } = await supabase.from('pubs').upsert(seed.map(mapPubToRow), { onConflict: 'id' });
  if (upsertError) throw upsertError;
}

async function ensureInitialized() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await ensureSupabaseReady();
  })();
  return initPromise;
}

async function requireAuth(req, res, next) {
  try {
    if (!req.session?.userId) return res.status(401).json({ error: 'Please log in first.' });
    const user = await getUserById(req.session.userId);
    if (!user) {
      req.session = null;
      return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
    }
    req.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireVerified(req, res, next) {
  if (!req.user.verified) return res.status(403).json({ error: 'Please verify your email before submitting updates.' });
  return next();
}

function requireDeveloper(req, res, next) {
  if (req.user.role !== 'developer') return res.status(403).json({ error: 'Developer access required.' });
  return next();
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(
  cookieSession({
    name: 'pintpoint.sid',
    keys: [SESSION_SECRET],
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  })
);

app.use(async (_req, _res, next) => {
  try {
    await ensureInitialized();
    await deleteExpiredUnverifiedUsers();
    next();
  } catch (error) {
    next(error);
  }
});

app.get('/api/pubs', async (_req, res, next) => {
  try {
    res.json(await listPubs());
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/me', async (req, res, next) => {
  try {
    const user = req.session?.userId ? await getUserById(req.session.userId) : null;
    res.json({ user: user ? safeUser(user) : null });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/signup', async (req, res, next) => {
  try {
    if (!consumeIpRateLimit(getIp(req), 'signup', 20, 60 * 60 * 1000)) {
      return res.status(429).json({ error: 'Too many signup attempts from this IP. Try again later.' });
    }
    const email = normalizeEmail(req.body.email);
    const username = normalizeUsername(req.body.username);
    const password = String(req.body.password || '');
    const code = String(req.body.code || '').trim();
    if (!email || !username || !password) return res.status(400).json({ error: 'Email, username, and password are required.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (username.length < 3 || username.length > 24) return res.status(400).json({ error: 'Username must be between 3 and 24 characters.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters long.' });

    const users = await listUsers();
    if (users.some((user) => normalizeEmail(user.email) === email)) return res.status(409).json({ error: 'This email is already registered.' });
    if (usernameTaken(users, username)) return res.status(409).json({ error: 'That username is already in use.' });

    const verificationToken = makeToken(24);
    const verificationCode = makeCode();
    const user = {
      id: makeToken(12),
      email,
      username,
      passwordHash: await bcrypt.hash(password, 12),
      role: code === DEV_CODE ? 'developer' : 'user',
      verified: false,
      verificationToken,
      verificationCodeHash: await bcrypt.hash(verificationCode, 10),
      verificationExpiresAt: Date.now() + VERIFY_WINDOW_MS,
      resetToken: null,
      resetCodeHash: null,
      resetExpiresAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      rateLimits: {}
    };
    await saveUser(user);
    req.session.userId = user.id;
    const result = await sendVerificationEmail(user, verificationToken, verificationCode);
    return res.status(201).json({
      user: safeUser(user),
      message: result.delivered
        ? 'Account created. Check your inbox to verify your email within 12 hours.'
        : 'Account created. Email service is not configured, so verification details were logged on the server.'
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    if (!consumeIpRateLimit(getIp(req), 'login', 40, 60 * 60 * 1000)) {
      return res.status(429).json({ error: 'Too many login attempts from this IP. Try again later.' });
    }
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    const user = await getUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
    if (!(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: 'Invalid email or password.' });
    req.session.userId = user.id;
    return res.json({ user: safeUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/auth/verify', requireAuth, async (req, res, next) => {
  try {
    const token = String(req.query.token || '');
    if (!token) return res.status(400).json({ error: 'Verification token is missing.' });
    if (req.user.verified) return res.json({ user: safeUser(req.user), message: 'Your email is already verified.' });
    if (req.user.verificationToken !== token) return res.status(400).json({ error: 'This verification link does not match your logged-in account.' });
    if (Date.now() > Number(req.user.verificationExpiresAt || 0)) return res.status(400).json({ error: 'Verification token has expired. Please sign up again.' });
    req.user.verified = true;
    req.user.verificationToken = null;
    req.user.verificationCodeHash = null;
    req.user.verificationExpiresAt = null;
    req.user.updatedAt = Date.now();
    await saveUser(req.user);
    return res.json({ user: safeUser(req.user), message: 'Your email has been verified.' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/verify-code', requireAuth, async (req, res, next) => {
  try {
    if (!consumeIpRateLimit(getIp(req), 'verifyCode', 30, 60 * 60 * 1000)) {
      return res.status(429).json({ error: 'Too many verification attempts from this IP. Try again later.' });
    }
    const code = String(req.body.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Verification code is required.' });
    if (req.user.verified) return res.json({ user: safeUser(req.user), message: 'Email already verified.' });
    if (Date.now() > Number(req.user.verificationExpiresAt || 0)) return res.status(400).json({ error: 'Verification window expired. Please sign up again.' });
    if (!req.user.verificationCodeHash || !(await bcrypt.compare(code, req.user.verificationCodeHash))) {
      return res.status(400).json({ error: 'Incorrect verification code.' });
    }
    req.user.verified = true;
    req.user.verificationToken = null;
    req.user.verificationCodeHash = null;
    req.user.verificationExpiresAt = null;
    req.user.updatedAt = Date.now();
    await saveUser(req.user);
    return res.json({ user: safeUser(req.user), message: 'Your email has been verified.' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/resend-verification', requireAuth, async (req, res, next) => {
  try {
    if (!consumeIpRateLimit(getIp(req), 'resendVerification', 20, 60 * 60 * 1000)) {
      return res.status(429).json({ error: 'Too many resend attempts from this IP. Try again later.' });
    }
    if (req.user.verified) return res.json({ message: 'That account is already verified.' });
    if (Date.now() > Number(req.user.verificationExpiresAt || 0)) return res.status(400).json({ error: 'Verification window expired. Please sign up again.' });
    const verificationToken = makeToken(24);
    const verificationCode = makeCode();
    req.user.verificationToken = verificationToken;
    req.user.verificationCodeHash = await bcrypt.hash(verificationCode, 10);
    req.user.updatedAt = Date.now();
    await saveUser(req.user);
    await sendVerificationEmail(req.user, verificationToken, verificationCode);
    return res.json({ message: 'Verification email sent.' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/request-password-reset', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!email) return res.status(400).json({ error: 'Email is required.' });
    if (!consumeIpRateLimit(getIp(req), 'passwordResetRequest', 15, 60 * 60 * 1000)) {
      return res.status(429).json({ error: 'Too many reset requests from this IP. Try again later.' });
    }
    const user = await getUserByEmail(email);
    if (!user) return res.json({ message: 'If that email exists, reset instructions have been sent.' });
    const resetToken = makeToken(24);
    const resetCode = makeCode();
    user.resetToken = resetToken;
    user.resetCodeHash = await bcrypt.hash(resetCode, 10);
    user.resetExpiresAt = Date.now() + RESET_WINDOW_MS;
    user.updatedAt = Date.now();
    await saveUser(user);
    await sendPasswordResetEmail(user, resetToken, resetCode);
    return res.json({ message: 'If that email exists, reset instructions have been sent.' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/reset-password', async (req, res, next) => {
  try {
    if (!consumeIpRateLimit(getIp(req), 'passwordResetSubmit', 25, 60 * 60 * 1000)) {
      return res.status(429).json({ error: 'Too many password reset attempts from this IP. Try again later.' });
    }
    const email = normalizeEmail(req.body.email);
    const token = String(req.body.token || '').trim();
    const code = String(req.body.code || '').trim();
    const newPassword = String(req.body.newPassword || '');
    if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters long.' });
    if (!email && !token) return res.status(400).json({ error: 'Email or reset token is required.' });

    let user = null;
    if (token) {
      const users = await listUsers();
      user = users.find((item) => item.resetToken === token) || null;
    } else {
      user = await getUserByEmail(email);
    }
    if (!user) return res.status(400).json({ error: 'Invalid reset credentials.' });
    if (!user.resetExpiresAt || Date.now() > Number(user.resetExpiresAt)) return res.status(400).json({ error: 'Reset token/code expired. Request a new reset.' });
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
    await saveUser(user);
    return res.json({ message: 'Password reset successful. You can now log in.' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/change-username', requireAuth, requireVerified, async (req, res, next) => {
  try {
    const nextName = normalizeUsername(req.body.username);
    if (nextName.length < 3 || nextName.length > 24) return res.status(400).json({ error: 'Username must be between 3 and 24 characters.' });
    const users = await listUsers();
    if (usernameTaken(users, nextName, req.user.id)) return res.status(409).json({ error: 'That username is already in use.' });
    if (!consumeCombinedRateLimit(req, req.user, 'usernameChange', 3, 24 * 60 * 60 * 1000)) {
      return res.status(429).json({ error: 'Username change limit reached. Try again in 24 hours.' });
    }
    req.user.username = nextName;
    req.user.updatedAt = Date.now();
    await saveUser(req.user);
    return res.json({ user: safeUser(req.user), message: 'Username updated.' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/proposals', requireAuth, requireVerified, async (req, res, next) => {
  try {
    if (!consumeCombinedRateLimit(req, req.user, 'pubUpdate', 10, 24 * 60 * 60 * 1000)) {
      return res.status(429).json({ error: 'Daily update limit reached. Try again tomorrow.' });
    }
    const pubId = String(req.body.pubId || '').trim();
    const proposedPintName = String(req.body.proposedPintName || '').trim();
    const proposedPintPrice = Number(req.body.proposedPintPrice);
    if (!pubId || !proposedPintName || !Number.isFinite(proposedPintPrice)) {
      return res.status(400).json({ error: 'Pub, pint name, and pint price are required.' });
    }
    if (proposedPintName.length > 80) return res.status(400).json({ error: 'Pint name is too long.' });
    if (proposedPintPrice < 0.5 || proposedPintPrice > 30) return res.status(400).json({ error: 'Pint price must be between 0.50 and 30.00.' });

    const pub = await getPubById(pubId);
    if (!pub) return res.status(404).json({ error: 'Pub not found.' });
    const normalizedCurrentName = String(pub.cheapestPintName || '').trim().toLowerCase();
    const normalizedProposedName = proposedPintName.toLowerCase();
    const roundedCurrentPrice = Number(Number(pub.cheapestPint).toFixed(2));
    const roundedProposedPrice = Number(proposedPintPrice.toFixed(2));
    if (normalizedCurrentName === normalizedProposedName && roundedCurrentPrice === roundedProposedPrice) {
      return res.status(400).json({ error: 'No changes detected. Update at least one field before submitting.' });
    }

    const proposal = {
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
    };
    await saveProposal(proposal);
    await saveUser(req.user);
    return res.status(201).json({ message: 'Update submitted for review.' });
  } catch (error) {
    next(error);
  }
});

app.get('/api/developer/proposals', requireAuth, requireVerified, requireDeveloper, async (_req, res, next) => {
  try {
    res.json({ proposals: await listProposals() });
  } catch (error) {
    next(error);
  }
});

app.post('/api/developer/proposals/:proposalId/reject', requireAuth, requireVerified, requireDeveloper, async (req, res, next) => {
  try {
    const proposalId = String(req.params.proposalId || '');
    const proposal = await getProposalById(proposalId);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found.' });
    await deleteProposal(proposalId);
    await appendAudit({
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
  } catch (error) {
    next(error);
  }
});

app.post('/api/developer/proposals/:proposalId/approve', requireAuth, requireVerified, requireDeveloper, async (req, res, next) => {
  try {
    const proposalId = String(req.params.proposalId || '');
    const proposal = await getProposalById(proposalId);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found.' });
    const pub = await getPubById(proposal.pubId);
    if (!pub) return res.status(404).json({ error: 'Associated pub no longer exists.' });
    pub.cheapestPintName = proposal.proposedPintName;
    pub.cheapestPint = proposal.proposedPintPrice;
    pub.lastUpdated = formatDateStamp();
    await savePub(pub);
    await deleteProposal(proposalId);
    await appendAudit({
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
  } catch (error) {
    next(error);
  }
});

app.get('/api/developer/audit', requireAuth, requireVerified, requireDeveloper, async (_req, res, next) => {
  try {
    res.json({ entries: await listAuditLogs() });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(ROOT_DIR));

app.get('*', (req, res) => {
  if (path.extname(req.path)) return res.status(404).send('Not found');
  return res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Server error. Please try again.' });
});

if (IS_VERCEL) {
  module.exports = app;
} else {
  app.listen(PORT, () => {
    console.log(`PintPoint running on ${APP_BASE_URL}`);
  });
}

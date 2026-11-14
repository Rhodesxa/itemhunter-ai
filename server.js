'use strict';
/**
 * ItemHunter AI - server
 *
 * Public:   GET /api/config, GET /api/health, POST /api/orders (new customer request only)
 * Staff:    everything else (reading, updating, deleting orders, staff accounts) needs a staff session.
 *
 * ENVIRONMENT VARIABLES (set these in the Render dashboard -> Environment):
 *   STAFF_PIN        Required for staff login. The PIN shown on the first staff screen.
 *   ADMIN_USERNAME   Required for staff login. Username of the main (owner) account.
 *   ADMIN_PASSWORD   Required for staff login. Password of the main account (min 8 characters).
 *   SESSION_SECRET   Strongly recommended. Long random text used to sign login sessions.
 *                    If missing, a random one is made on every start (everyone is logged out on each restart).
 *   DATA_DIR         Optional. Folder where orders.json / staff.json are saved. Point it at a Render
 *                    Persistent Disk (e.g. /var/data) so orders survive redeploys. Default: this folder.
 *   STANDARD_FEE / PRIORITY_FEE   Optional. Default 30 / 50.
 *   STANDARD_SLA_HOURS / PRIORITY_SLA_HOURS   Optional. Hours before an order shows as overdue on the staff dashboard. Default 24 / 24.
 *
 * Uses only Node built-ins plus express (already in package.json).
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const STAFF_FILE = path.join(DATA_DIR, 'staff.json');

const STAFF_PIN = (process.env.STAFF_PIN || '').trim();
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || '').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
let SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_SECRET_FROM_ENV = !!SESSION_SECRET;
if (!SESSION_SECRET) SESSION_SECRET = crypto.randomBytes(32).toString('hex');

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const FEES = { standard: num(process.env.STANDARD_FEE, 30), priority: num(process.env.PRIORITY_FEE, 50) };
const SLA_HOURS = { standard: num(process.env.STANDARD_SLA_HOURS, 24), priority: num(process.env.PRIORITY_SLA_HOURS, 24) };
const PACKAGE_NAMES = { standard: 'Standard Search', priority: 'Priority Deep Hunt' };

const STATUSES = ['Waiting', 'Searching', 'Listings Ready', 'Sent', 'Done'];
const SESSION_HOURS = num(process.env.SESSION_HOURS, 12);
const MAX_ORDERS = 20000;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render sits behind a proxy

/* ------------------------------------------------------------------ helpers */
const nowIso = () => new Date().toISOString();

function clean(v, max) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
const b64u = (buf) => Buffer.from(buf).toString('base64url');
function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}
function verifyToken(token) {
  if (typeof token !== 'string' || token.length > 2000) return null;
  const i = token.indexOf('.');
  if (i < 1) return null;
  const body = token.slice(0, i);
  const mac = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac); const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p || typeof p.exp !== 'number' || p.exp < Date.now()) return null;
    return p;
  } catch (e) { return null; }
}
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}
function checkPassword(pw, stored) {
  try {
    const [alg, saltHex, hashHex] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expect = Buffer.from(hashHex, 'hex');
    const got = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), expect.length);
    return crypto.timingSafeEqual(got, expect);
  } catch (e) { return false; }
}
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

/* ------------------------------------------------------------------ storage */
function ensureDir() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {} }
function writeJsonAtomic(file, data) {
  ensureDir();
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
function readJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    try { fs.renameSync(file, file + '.corrupt-' + Date.now()); } catch (e2) {}
    console.error('Could not read ' + file + ' (moved aside as .corrupt):', e.message);
    return fallback;
  }
}

function safeUrl(u) {
  const s = clean(u, 1000);
  if (!s) return '';
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : 'https://' + s);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString();
  } catch (e) { return ''; }
}
function normalizeLinks(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const l of arr.slice(0, 15)) {
    if (!l || typeof l !== 'object') continue;
    const url = safeUrl(l.url);
    if (!url) continue;
    out.push({ label: clean(l.label, 120) || new URL(url).hostname.replace(/^www\./, ''), url, price: clean(l.price, 40), notes: clean(l.notes, 500) });
  }
  return out;
}
function normalizeHistory(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(-60).filter((h) => h && h.text).map((h) => ({ at: clean(h.at, 40) || nowIso(), by: clean(h.by, 60), text: clean(h.text, 300) }));
}
function normalizeOrder(o) {
  const feeNum = Number(o.fee);
  const status = STATUSES.includes(o.status) ? o.status : 'Waiting';
  return {
    id: clean(o.id, 40) || Date.now().toString(),
    ref: clean(o.ref, 12),
    name: clean(o.name, 120) || 'Anonymous',
    contact: clean(o.contact, 200),
    query: clean(o.query, 400),
    details: clean(o.details, 600),
    condition: clean(o.condition, 60) || 'Any Condition',
    budget: clean(o.budget, 100) || 'Flexible',
    notes: clean(o.notes, 1500),
    packageName: clean(o.packageName, 60) || PACKAGE_NAMES.standard,
    fee: Number.isFinite(feeNum) && feeNum >= 0 ? feeNum : FEES.standard,
    isPaid: o.isPaid === true,
    paymentClaimed: o.paymentClaimed === true,
    status,
    directLinks: normalizeLinks(o.directLinks),
    aiResults: clean(o.aiResults, 2000),
    staffNotes: clean(o.staffNotes, 5000),
    history: normalizeHistory(o.history),
    paidAt: clean(o.paidAt, 40),
    sentAt: clean(o.sentAt, 40),
    doneAt: clean(o.doneAt, 40),
    createdAt: clean(o.createdAt, 40) || (/^\d{13}$/.test(String(o.id)) ? new Date(Number(o.id)).toISOString() : nowIso()),
    updatedAt: clean(o.updatedAt, 40) || clean(o.createdAt, 40) || nowIso()
  };
}

let orders = [];
let staffAccounts = [];
function loadAll() {
  const raw = readJsonFile(ORDERS_FILE, []);
  orders = (Array.isArray(raw) ? raw : (raw && Array.isArray(raw.orders) ? raw.orders : [])).filter((o) => o && typeof o === 'object').map(normalizeOrder);
  const st = readJsonFile(STAFF_FILE, { accounts: [] });
  staffAccounts = Array.isArray(st.accounts) ? st.accounts.filter((a) => a && a.username && a.hash) : [];
}
function saveOrders() {
  try { writeJsonAtomic(ORDERS_FILE, orders); return true; }
  catch (e) { console.error('Failed to save orders:', e.message); return false; }
}
function saveStaff() {
  try { writeJsonAtomic(STAFF_FILE, { accounts: staffAccounts }); return true; }
  catch (e) { console.error('Failed to save staff accounts:', e.message); return false; }
}
loadAll();

function newOrderId() {
  let id = Date.now();
  while (orders.some((o) => o.id === String(id))) id += 1;
  return String(id);
}
function newRef() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let n = 0; n < 50; n++) {
    let s = 'IH-';
    const bytes = crypto.randomBytes(5);
    for (let i = 0; i < 5; i++) s += alphabet[bytes[i] % alphabet.length];
    if (!orders.some((o) => o.ref === s)) return s;
  }
  return 'IH-' + Date.now().toString(36).toUpperCase().slice(-5);
}
function addHistory(order, by, text) {
  order.history = (order.history || []).concat([{ at: nowIso(), by: by || 'system', text }]).slice(-60);
}

/* ------------------------------------------------------------------ rate limits */
const buckets = new Map();
function hit(key, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.count += 1;
  return b;
}
function peek(key) {
  const b = buckets.get(key);
  return b && b.reset > Date.now() ? b : null;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 10 * 60 * 1000).unref();

/* ------------------------------------------------------------------ middleware */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: https://api.qrserver.com; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '300kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  setHeaders: (res, file) => {
    // pages always re-checked (so updates show up right away); images cached for a day
    res.setHeader('Cache-Control', /\.html$/.test(file) ? 'no-cache' : 'public, max-age=86400');
  }
}));
app.get('/staff', (req, res) => res.sendFile(path.join(__dirname, 'public', 'staff.html')));

/* ------------------------------------------------------------------ staff auth */
function staffLoginConfigured() { return !!(STAFF_PIN && ADMIN_USERNAME && ADMIN_PASSWORD.length >= 8); }
function findAccount(username) {
  const u = String(username || '').trim().toLowerCase();
  if (!u) return null;
  if (ADMIN_USERNAME && ADMIN_PASSWORD && u === ADMIN_USERNAME.toLowerCase()) {
    return { username: ADMIN_USERNAME, role: 'admin', env: true };
  }
  const a = staffAccounts.find((x) => x.username.toLowerCase() === u);
  return a ? { username: a.username, role: a.role === 'admin' ? 'admin' : 'staff', env: false, hash: a.hash } : null;
}
function verifyLogin(username, password) {
  const acct = findAccount(username);
  if (acct && acct.env) return safeEqual(password, ADMIN_PASSWORD) ? acct : null;
  const ok = checkPassword(password, acct ? acct.hash : DUMMY_HASH);
  return acct && ok ? acct : null;
}
function setSessionCookie(req, res, token) {
  const parts = ['ih_session=' + encodeURIComponent(token), 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=' + Math.floor(SESSION_HOURS * 3600)];
  if (req.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'ih_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch (e) { return false; }
}
function requireStaff(req, res, next) {
  const auth = String(req.headers.authorization || '');
  const fromBearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const token = fromBearer || parseCookies(req).ih_session;
  const p = verifyToken(token);
  if (!p || p.t !== 'session') return res.status(401).json({ success: false, error: 'Staff login required.' });
  const acct = findAccount(p.u);
  if (!acct) return res.status(401).json({ success: false, error: 'Staff login required.' });
  if (!fromBearer && req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
    return res.status(403).json({ success: false, error: 'Blocked cross-site request.' });
  }
  req.user = { username: acct.username, role: acct.role, env: acct.env };
  next();
}
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ success: false, error: 'Admin account required.' });
  next();
}

const LOGIN_WINDOW = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 8;
function loginBlocked(req, res) {
  const b = peek('fail:' + req.ip);
  if (b && b.count >= LOGIN_MAX_FAILS) {
    res.status(429).json({ success: false, error: 'Too many attempts. Please wait 15 minutes and try again.' });
    return true;
  }
  return false;
}
function notConfigured(res) {
  res.status(503).json({ success: false, error: 'Staff login is not set up yet. The site owner must set STAFF_PIN, ADMIN_USERNAME and ADMIN_PASSWORD (8+ characters) in the Render Environment settings.' });
}

app.post('/api/staff/pin', (req, res) => {
  if (!staffLoginConfigured()) return notConfigured(res);
  if (loginBlocked(req, res)) return;
  const pin = clean(req.body && req.body.pin, 100);
  if (!pin || !safeEqual(pin, STAFF_PIN)) {
    hit('fail:' + req.ip, LOGIN_WINDOW);
    return res.status(401).json({ success: false, error: 'Incorrect PIN.' });
  }
  res.json({ success: true, pinToken: sign({ t: 'pin', exp: Date.now() + 10 * 60 * 1000 }) });
});

app.post('/api/staff/login', (req, res) => {
  if (!staffLoginConfigured()) return notConfigured(res);
  if (loginBlocked(req, res)) return;
  const body = req.body || {};
  let pinOk = false;
  const pt = verifyToken(body.pinToken);
  if (pt && pt.t === 'pin') pinOk = true;
  else if (body.pin && safeEqual(clean(body.pin, 100), STAFF_PIN)) pinOk = true;
  const acct = pinOk ? verifyLogin(clean(body.username, 80), String(body.password || '').slice(0, 200)) : null;
  if (!pinOk || !acct) {
    hit('fail:' + req.ip, LOGIN_WINDOW);
    return res.status(401).json({ success: false, error: pinOk ? 'Incorrect username or password.' : 'PIN expired or incorrect. Please start again.', pinExpired: !pinOk });
  }
  buckets.delete('fail:' + req.ip);
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  const token = sign({ t: 'session', u: acct.username, exp });
  setSessionCookie(req, res, token);
  res.json({ success: true, user: { username: acct.username, role: acct.role }, token, expiresAt: new Date(exp).toISOString() });
});

app.post('/api/staff/logout', (req, res) => { clearSessionCookie(res); res.json({ success: true }); });
app.get('/api/staff/me', requireStaff, (req, res) => res.json({ success: true, user: req.user }));

app.post('/api/staff/password', requireStaff, (req, res) => {
  if (req.user.env) return res.status(400).json({ success: false, error: 'The main account password is set with the ADMIN_PASSWORD setting on Render.' });
  const { current, next } = req.body || {};
  const acct = staffAccounts.find((a) => a.username.toLowerCase() === req.user.username.toLowerCase());
  if (!acct || !checkPassword(String(current || ''), acct.hash)) return res.status(400).json({ success: false, error: 'Current password is incorrect.' });
  if (typeof next !== 'string' || next.length < 8 || next.length > 200) return res.status(400).json({ success: false, error: 'New password must be at least 8 characters.' });
  acct.hash = hashPassword(next);
  saveStaff();
  res.json({ success: true });
});

/* accounts (admin only) */
app.get('/api/staff/accounts', requireStaff, requireAdmin, (req, res) => {
  const list = [];
  if (ADMIN_USERNAME && ADMIN_PASSWORD) list.push({ username: ADMIN_USERNAME, role: 'admin', env: true, createdAt: '' });
  staffAccounts.forEach((a) => list.push({ username: a.username, role: a.role === 'admin' ? 'admin' : 'staff', env: false, createdAt: a.createdAt || '', createdBy: a.createdBy || '' }));
  res.json({ success: true, accounts: list });
});
app.post('/api/staff/accounts', requireStaff, requireAdmin, (req, res) => {
  const username = clean(req.body && req.body.username, 40);
  const password = String((req.body && req.body.password) || '');
  const role = req.body && req.body.role === 'admin' ? 'admin' : 'staff';
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._@-]{2,39}$/.test(username)) return res.status(400).json({ success: false, error: 'Username must be 3-40 characters (letters, numbers, spaces, . _ @ -).' });
  if (password.length < 8 || password.length > 200) return res.status(400).json({ success: false, error: 'Password must be at least 8 characters.' });
  if (findAccount(username)) return res.status(409).json({ success: false, error: 'That username already exists.' });
  staffAccounts.push({ username, role, hash: hashPassword(password), createdAt: nowIso(), createdBy: req.user.username });
  if (!saveStaff()) return res.status(500).json({ success: false, error: 'Could not save the account.' });
  res.json({ success: true });
});
app.post('/api/staff/accounts/:username/password', requireStaff, requireAdmin, (req, res) => {
  const a = staffAccounts.find((x) => x.username.toLowerCase() === String(req.params.username).toLowerCase());
  if (!a) return res.status(404).json({ success: false, error: 'Account not found (the main account is changed on Render).' });
  const password = String((req.body && req.body.password) || '');
  if (password.length < 8 || password.length > 200) return res.status(400).json({ success: false, error: 'Password must be at least 8 characters.' });
  a.hash = hashPassword(password);
  saveStaff();
  res.json({ success: true });
});
app.delete('/api/staff/accounts/:username', requireStaff, requireAdmin, (req, res) => {
  const u = String(req.params.username).toLowerCase();
  if (u === req.user.username.toLowerCase()) return res.status(400).json({ success: false, error: 'You cannot remove the account you are logged in with.' });
  const before = staffAccounts.length;
  staffAccounts = staffAccounts.filter((a) => a.username.toLowerCase() !== u);
  if (staffAccounts.length === before) return res.status(404).json({ success: false, error: 'Account not found (the main account is changed on Render).' });
  saveStaff();
  res.json({ success: true });
});

app.get('/api/staff/system', requireStaff, (req, res) => {
  res.json({
    success: true,
    system: {
      orderCount: orders.length,
      staffAccountCount: staffAccounts.length + (ADMIN_USERNAME ? 1 : 0),
      dataDir: DATA_DIR,
      dataDirIsCustom: !!process.env.DATA_DIR,
      sessionSecretSet: SESSION_SECRET_FROM_ENV,
      sessionHours: SESSION_HOURS,
      fees: FEES,
      slaHours: SLA_HOURS,
      serverTime: nowIso(),
      node: process.version
    }
  });
});

/* ------------------------------------------------------------------ public API */
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/config', (req, res) => res.json({ success: true, fees: FEES, slaHours: SLA_HOURS, packages: PACKAGE_NAMES }));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function validContact(c) {
  if (EMAIL_RE.test(c)) return true;
  const digits = c.replace(/\D/g, '');
  return /^[\d\s()+.\-x]+$/i.test(c) && digits.length >= 10 && digits.length <= 15;
}

app.post('/api/orders', (req, res) => {
  const b = req.body || {};
  const hits = hit('order:' + req.ip, 60 * 60 * 1000);
  if (hits.count > 12) return res.status(429).json({ success: false, error: 'Too many requests from your connection. Please try again later.' });
  if (b.website) return res.json({ success: true, order: { id: 'ok', ref: 'IH-00000' } }); // honeypot: pretend success

  const name = clean(b.name, 120);
  const contact = clean(b.contact, 200);
  const itemOnly = clean(b.item || b.query, 300);
  const details = clean(b.details, 600);
  const errors = {};
  if (!name) errors.name = 'Please enter your name.';
  if (!contact || !validContact(contact)) errors.contact = 'Enter a valid email address or phone number.';
  if (itemOnly.length < 3) errors.query = 'Please describe the item you want.';
  if (Object.keys(errors).length) return res.status(400).json({ success: false, error: 'Please check the form.', errors });

  const pkgKey = /priority/i.test(String(b.packageName || b.package || '')) ? 'priority' : 'standard';
  let ref = clean(b.ref, 12).toUpperCase();
  if (!/^IH-[A-Z0-9]{5}$/.test(ref) || orders.some((o) => o.ref === ref)) ref = newRef();

  if (orders.length >= MAX_ORDERS) return res.status(503).json({ success: false, error: 'We are not accepting new requests right now.' });
  const order = normalizeOrder({
    id: newOrderId(),
    ref,
    name,
    contact,
    // 'query' keeps the old format "item [details]" so older tools keep working
    query: itemOnly + (details ? ' [' + details + ']' : ''),
    details,
    condition: clean(b.condition, 60) || 'Any Condition',
    budget: clean(b.budget, 100) || 'Flexible',
    notes: clean(b.notes, 1500),
    packageName: PACKAGE_NAMES[pkgKey],
    fee: FEES[pkgKey], // price is set by the server, never trusted from the browser
    isPaid: false,
    paymentClaimed: b.paymentClaimed === true,
    status: 'Waiting',
    directLinks: [],
    aiResults: '',
    createdAt: nowIso(),
    updatedAt: nowIso()
  });
  addHistory(order, 'customer', 'Order submitted' + (order.paymentClaimed ? ' (customer says Venmo payment sent)' : ''));
  orders.unshift(order);
  if (!saveOrders()) { orders.shift(); return res.status(500).json({ success: false, error: 'Could not save your request. Please try again.' }); }
  res.json({ success: true, order: { id: order.id, ref: order.ref, packageName: order.packageName, fee: order.fee, createdAt: order.createdAt } });
});

/* ------------------------------------------------------------------ staff orders API */
app.get('/api/orders', requireStaff, (req, res) => res.json({ success: true, orders, serverTime: nowIso() }));

function applyPatch(order, b, by) {
  const changes = [];
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) return { error: 'Invalid status.' };
    if (b.status !== order.status) {
      changes.push('Status: ' + order.status + ' → ' + b.status);
      order.status = b.status;
      if (b.status === 'Sent' && !order.sentAt) order.sentAt = nowIso();
      if (b.status === 'Done') { if (!order.doneAt) order.doneAt = nowIso(); if (!order.sentAt) order.sentAt = order.doneAt; }
      if (b.status !== 'Done') order.doneAt = '';
    }
  }
  if (b.isPaid !== undefined) {
    const paid = b.isPaid === true || b.isPaid === 'true';
    if (paid !== order.isPaid) {
      order.isPaid = paid;
      order.paidAt = paid ? nowIso() : '';
      changes.push(paid ? 'Marked paid' : 'Marked unpaid');
    }
  }
  if (b.directLinks !== undefined) {
    const links = normalizeLinks(b.directLinks);
    if (JSON.stringify(links) !== JSON.stringify(order.directLinks)) {
      order.directLinks = links;
      changes.push('Listings updated (' + links.length + ')');
    }
  }
  if (b.staffNotes !== undefined) {
    const n = clean(b.staffNotes, 5000);
    if (n !== order.staffNotes) { order.staffNotes = n; changes.push('Staff notes updated'); }
  }
  ['name', 'contact', 'condition', 'budget', 'notes'].forEach((k) => {
    if (b[k] !== undefined) {
      const lim = { name: 120, contact: 200, condition: 60, budget: 100, notes: 1500 }[k];
      const v = clean(b[k], lim);
      if (v !== order[k]) { order[k] = v; changes.push('Edited ' + k); }
    }
  });
  if (b.query !== undefined) {
    const v = clean(b.query, 400);
    if (v !== order.query) { order.query = v; changes.push('Edited item'); }
  }
  if (changes.length) {
    order.updatedAt = nowIso();
    changes.forEach((c) => addHistory(order, by, c));
  }
  return { changes };
}
function updateOrder(req, res, id, body) {
  const order = orders.find((o) => o.id === String(id));
  if (!order) return res.status(404).json({ success: false, error: 'Order not found.' });
  const r = applyPatch(order, body || {}, req.user.username);
  if (r.error) return res.status(400).json({ success: false, error: r.error });
  if (r.changes.length && !saveOrders()) return res.status(500).json({ success: false, error: 'Could not save changes.' });
  res.json({ success: true, order, orders });
}
function deleteOrder(req, res, id) {
  const before = orders.length;
  orders = orders.filter((o) => o.id !== String(id));
  if (orders.length === before) return res.status(404).json({ success: false, error: 'Order not found.' });
  saveOrders();
  res.json({ success: true, orders });
}

app.patch('/api/orders/:id', requireStaff, (req, res) => updateOrder(req, res, req.params.id, req.body));
app.delete('/api/orders/:id', requireStaff, (req, res) => deleteOrder(req, res, req.params.id));
// Legacy endpoint (kept so older scripts keep working) - now staff only.
app.post('/api/orders/update', requireStaff, (req, res) => {
  const b = req.body || {};
  if (b.action === 'delete') return deleteOrder(req, res, b.id);
  return updateOrder(req, res, b.id, b);
});

app.get('/api/orders/export', requireStaff, (req, res) => {
  const stamp = new Date().toISOString().slice(0, 10);
  if (req.query.format === 'csv') {
    const cols = ['id', 'ref', 'createdAt', 'name', 'contact', 'query', 'condition', 'budget', 'notes', 'packageName', 'fee', 'isPaid', 'status', 'staffNotes', 'links'];
    const cell = (v) => {
      let s = String(v === undefined || v === null ? '' : v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
      return '"' + s.replace(/"/g, '""') + '"';
    };
    const lines = [cols.join(',')].concat(orders.map((o) => cols.map((c) => cell(c === 'links' ? o.directLinks.map((l) => l.url).join(' | ') : o[c])).join(',')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="itemhunter-orders-' + stamp + '.csv"');
    return res.send(lines.join('\n'));
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="itemhunter-orders-' + stamp + '.json"');
  res.send(JSON.stringify(orders, null, 2));
});

app.post('/api/orders/import', requireStaff, (req, res) => {
  const incoming = Array.isArray(req.body && req.body.orders) ? req.body.orders : (Array.isArray(req.body) ? req.body : null);
  if (!incoming) return res.status(400).json({ success: false, error: 'Expected { "orders": [...] }.' });
  let added = 0;
  const ids = new Set(orders.map((o) => o.id));
  incoming.slice(0, 2000).forEach((raw) => {
    if (!raw || typeof raw !== 'object' || !raw.id) return;
    const id = clean(raw.id, 40);
    if (!id || ids.has(id)) return;
    const o = normalizeOrder(Object.assign({}, raw, { id }));
    if (o.ref && orders.some((x) => x.ref === o.ref)) o.ref = '';
    orders.push(o); ids.add(id); added++;
  });
  if (added) {
    orders.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    saveOrders();
  }
  res.json({ success: true, added, orders });
});

/* ------------------------------------------------------------------ fallbacks */
app.use('/api', (req, res) => res.status(404).json({ success: false, error: 'Not found.' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
    return res.status(400).json({ success: false, error: 'Invalid request.' });
  }
  console.error(err);
  res.status(500).json({ success: false, error: 'Server error.' });
});

app.listen(PORT, () => {
  console.log('ItemHunter AI server running on port ' + PORT);
  console.log('Data folder: ' + DATA_DIR + (process.env.DATA_DIR ? '' : '  (default - orders may be erased when Render redeploys; see DATA_DIR in server.js)'));
  if (!staffLoginConfigured()) console.warn('WARNING: staff login is DISABLED. Set STAFF_PIN, ADMIN_USERNAME and ADMIN_PASSWORD (8+ chars).');
  if (!SESSION_SECRET_FROM_ENV) console.warn('WARNING: SESSION_SECRET not set - staff will be logged out whenever the server restarts.');
});

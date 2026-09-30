const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

loadEnvFile(path.join(__dirname, '.env'));

// ---------- CONFIG ----------
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS || 'srmist.edu.in')
    .split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
const SESSION_SECRET = process.env.SESSION_SECRET || (IS_PROD ? '' : 'dev-only-secret');
const SESSION_DAYS = 365;          // renewed on every visit, so people stay logged in until they log out
const CODE_TTL_MS = 15 * 60 * 1000;       // a login code works (and can be reused) for 15 minutes
const REPORTS_TO_BAN = Number(process.env.REPORTS_TO_BAN) || 3;
const BAN_HOURS = Number(process.env.BAN_HOURS) || 24;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

if (!SESSION_SECRET) {
    console.error('SESSION_SECRET must be set in production (any long random string).');
    process.exit(1);
}

// Local HTTPS with self-signed certs so phones on the same Wi-Fi can use the camera.
// Hosting providers (Render, Railway...) give you HTTPS themselves, so we use plain HTTP there.
const useLocalHttps = !IS_PROD && fs.existsSync('key.pem') && fs.existsSync('cert.pem');

const app = express();
if (IS_PROD) app.set('trust proxy', 1);
const server = useLocalHttps
    ? https.createServer({ key: fs.readFileSync('key.pem'), cert: fs.readFileSync('cert.pem') }, app)
    : http.createServer(app);
const io = require('socket.io')(server, { maxHttpBufferSize: 64 * 1024 });

app.use(express.json({ limit: '10kb' }));
// Only the third parties the page actually uses are allowed to load
const CSP = [
    "default-src 'self'",
    "script-src 'self' https://cdnjs.cloudflare.com https://accounts.google.com/gsi/client",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style",
    "frame-src https://accounts.google.com/gsi/",
    "font-src 'self' https://fonts.gstatic.com",
    "media-src 'self' blob: https://d8j0ntlcm91z4.cloudfront.net",
    "img-src 'self' data:",
    "connect-src 'self' https://accounts.google.com/gsi/",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
].join('; ');

app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');   // Google sign-in checks the page origin
    res.set('X-Frame-Options', 'DENY');
    res.set('Content-Security-Policy', CSP);
    res.set('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()');
    if (IS_PROD) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
});
// Pages can be linked without .html (e.g. /privacy once legal pages are added)
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
// Nudity filter libraries, served from our own server (runs entirely in the browser; video never leaves the device for this)
app.get('/vendor/nsfwjs.min.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/nsfwjs/dist/browser/nsfwjs.min.js'), { maxAge: '30d' }));
app.get('/vendor/nsfw-model/model.min.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/nsfwjs/dist/models/mobilenet_v2/model.min.js'), { maxAge: '30d' }));
app.get('/vendor/nsfw-model/weights.min.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/nsfwjs/dist/models/mobilenet_v2/group1-shard1of1.min.js'), { maxAge: '30d' }));

// ---------- MODERATION STORE (bans + reports, saved to disk) ----------
const DB_FILE = path.join(DATA_DIR, 'moderation.json');
let db = { bans: {}, reports: {} };
try { db = { bans: {}, reports: {}, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch { }

let saveTimer = null;
function saveDb() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), err => err && console.error('Save failed:', err));
    }, 500);
}

// Reporters are stored as a keyed hash, never as a plain email (we only need to count distinct reporters)
const reporterId = (email) => crypto.createHmac('sha256', SESSION_SECRET).update(`reporter:${email}`).digest('hex').slice(0, 24);

// Retention: reports are deleted after 30 days, temporary bans as soon as they expire
const REPORT_RETENTION_MS = 30 * 864e5;
function pruneDb() {
    const now = Date.now();
    let changed = false;
    for (const [email, list] of Object.entries(db.reports)) {
        const kept = list.filter(r => now - r.at < REPORT_RETENTION_MS);
        if (kept.length !== list.length) changed = true;
        if (kept.length) db.reports[email] = kept;
        else delete db.reports[email];
    }
    for (const [email, ban] of Object.entries(db.bans)) {
        if (ban.until !== null && ban.until <= now) { delete db.bans[email]; changed = true; }
    }
    for (const email of Object.keys(db.marks || {})) {
        if (!db.reports[email]) { delete db.marks[email]; changed = true; }
    }
    if (changed) saveDb();
}
if (!db.marks) db.marks = {};
pruneDb();
setInterval(pruneDb, 3600e3).unref();

// Red mark: more than RED_MARK_AT different people reported the same account in the last 30 days.
// They get a one-time warning, and the account is highlighted in the admin dashboard.
const RED_MARK_AT = Number(process.env.RED_MARK_AT) || 5;
if (!db.marks) db.marks = {};                      // email -> { at, count, acknowledged }
const distinctReporters30d = (email) => new Set((db.reports[email] || []).map(r => r.by)).size;

// Admins (you) can open /admin. Comma-separated emails, e.g. ADMIN_EMAILS=you@srmist.edu.in
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const isAdmin = (email) => ADMIN_EMAILS.includes(String(email || '').toLowerCase());

// A ban with until: null is permanent (set it by hand in data/moderation.json).
function isBanned(email) {
    const ban = db.bans[email];
    return !!ban && (ban.until === null || ban.until > Date.now());
}

// ---------- SESSIONS (signed cookie, survives restarts) ----------
function sign(payload) {
    return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}

// Each login is one "device" (a browser on a phone or laptop) with its own random id inside the cookie.
function createSession(email, device = crypto.randomBytes(12).toString('base64url')) {
    const payload = Buffer.from(JSON.stringify({ e: email, d: device, x: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
    return `${payload}.${sign(payload)}`;
}

// Returns { email, device } for a valid, unexpired cookie
function readSession(token) {
    if (typeof token !== 'string') return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const a = Buffer.from(sig), b = Buffer.from(sign(payload));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        const { e, d, x } = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (!(Date.now() < x)) return null;
        return { email: e, device: d || `legacy-${sig.slice(0, 16)}` };   // cookies from before device ids existed
    } catch { return null; }
}

// ---------- DEVICE LIMIT: one email can be logged in on at most MAX_DEVICES devices ----------
// Logging in on one more device logs out the device that was used least recently.
// This lives in memory; after a restart devices simply re-register as they come back.
const MAX_DEVICES = Number(process.env.MAX_DEVICES) || 2;
const devices = new Map();      // email -> [{ id, lastSeen }]
const loggedOut = new Set();    // device ids pushed out by the limit (or logged out), so they can't sneak back in

function useDevice(email, device) {
    if (loggedOut.has(device)) return false;
    const list = devices.get(email) || [];
    const known = list.find(d => d.id === device);
    if (known) { known.lastSeen = Date.now(); return true; }
    list.push({ id: device, lastSeen: Date.now() });
    list.sort((x, y) => x.lastSeen - y.lastSeen);
    while (list.length > MAX_DEVICES) {
        const oldest = list.shift();
        loggedOut.add(oldest.id);
        for (const s of io.of('/').sockets.values()) {
            if (s.data.device === oldest.id) {
                s.emit('logged_out', { reason: 'device_limit' });
                s.disconnect(true);
            }
        }
    }
    devices.set(email, list);
    return true;
}

function forgetDevice(email, device) {
    const list = (devices.get(email) || []).filter(d => d.id !== device);
    if (list.length) devices.set(email, list); else devices.delete(email);
    loggedOut.add(device);
}

function parseCookies(header = '') {
    return Object.fromEntries(header.split(';').map(c => {
        const i = c.indexOf('=');
        return i < 0 ? [c.trim(), ''] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
    }));
}

function sessionCookie(value, maxAgeSec) {
    const secure = IS_PROD || useLocalHttps ? '; Secure' : '';
    return `sid=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

function requireAuth(req, res, next) {
    const session = readSession(parseCookies(req.headers.cookie).sid);
    if (!session) return res.status(401).json({ error: 'Not logged in' });
    if (!useDevice(session.email, session.device)) return res.status(401).json({ error: 'Not logged in', reason: 'device_limit' });
    if (isBanned(session.email)) return res.status(403).json({ error: 'banned', until: db.bans[session.email].until });
    req.email = session.email;
    req.device = session.device;
    next();
}

// Log in on this browser as a new device (may log out the least recently used one)
function startSession(res, email) {
    const device = crypto.randomBytes(12).toString('base64url');
    useDevice(email, device);
    res.set('Set-Cookie', sessionCookie(createSession(email, device), SESSION_DAYS * 86400));
}

// ---------- RATE LIMITING ----------
const hits = new Map();
function rateLimited(key, max, windowMs) {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter(t => now - t < windowMs);
    const limited = recent.length >= max;
    if (!limited) recent.push(now);
    hits.set(key, recent);
    return limited;
}
setInterval(() => {
    const now = Date.now();
    for (const [key, times] of hits) if (!times.some(t => now - t < 3600e3)) hits.delete(key);
    for (const [email, entry] of pendingCodes) if (entry.expires < now) pendingCodes.delete(email);
}, 10 * 60 * 1000).unref();

// ---------- EMAIL LOGIN ----------
const pendingCodes = new Map(); // email -> { code, hash, expires, wrong } (memory only, gone after 15 min)

function normalizeEmail(raw) {
    if (typeof raw !== 'string') return null;
    const email = raw.trim().toLowerCase();
    const m = email.match(/^[a-z0-9._%+-]+@([a-z0-9.-]+)$/);
    if (!m || email.length > 254 || !ALLOWED_DOMAINS.includes(m[1])) return null;
    return email;
}

const hashCode = (email, code) => crypto.createHash('sha256').update(`${email}:${code}:${SESSION_SECRET}`).digest('hex');

// Login codes can be sent three ways (first one that's set up wins):
//  1. EMAIL_WEBHOOK_URL: a Google Apps Script that sends from your Gmail over HTTPS (works on hosts that block email ports, like Render's free plan)
//  2. GMAIL_USER + GMAIL_APP_PASSWORD: Gmail directly over SMTP (works on your laptop)
//  3. RESEND_API_KEY: Resend (needs your own domain)
// With none set up, codes are printed in the terminal while developing.
const EMAIL_WEBHOOK_URL = (process.env.EMAIL_WEBHOOK_URL || '').trim();
const EMAIL_WEBHOOK_SECRET = (process.env.EMAIL_WEBHOOK_SECRET || '').trim();
const GMAIL_USER = (process.env.GMAIL_USER || '').trim();
const GMAIL_APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
let gmail = null;
if (GMAIL_USER && GMAIL_APP_PASSWORD) {
    gmail = require('nodemailer').createTransport({
        service: 'gmail',
        auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
        // Fail fast instead of hanging if the host blocks email ports
        connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    });
}
const webhookConfigured = !!(EMAIL_WEBHOOK_URL && EMAIL_WEBHOOK_SECRET);
const emailConfigured = webhookConfigured || !!gmail || !!process.env.RESEND_API_KEY;

async function sendCodeEmail(email, code, minutes = 15) {
    const subject = `Your CampusVibe login code: ${code}`;
    const text = `Your CampusVibe login code is ${code}\n\nIt works for the next ${minutes} minutes, and you can use it more than once. If you didn't ask for this, you can ignore this email.`;

    if (webhookConfigured) {
        const res = await fetch(EMAIL_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },     // plain text avoids a CORS preflight on Apps Script
            body: JSON.stringify({ secret: EMAIL_WEBHOOK_SECRET, to: email, code, minutes }),
            redirect: 'follow',
            signal: AbortSignal.timeout(20000),
        });
        const body = await res.text();
        let result = {};
        try { result = JSON.parse(body); } catch { }
        if (!res.ok || result.ok !== true) throw new Error(`Email webhook failed (${res.status}): ${result.error || body.slice(0, 200)}`);
        return;
    }
    if (gmail) {
        await gmail.sendMail({ from: `CampusVibe <${GMAIL_USER}>`, to: email, subject, text });
        return;
    }
    if (process.env.RESEND_API_KEY) {
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: process.env.EMAIL_FROM || 'onboarding@resend.dev', to: email, subject, text }),
            signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) throw new Error(`Resend error ${res.status}: ${await res.text()}`);
        return;
    }
    if (IS_PROD) throw new Error('No email sender configured (set EMAIL_WEBHOOK_URL + EMAIL_WEBHOOK_SECRET, GMAIL_USER + GMAIL_APP_PASSWORD, or RESEND_API_KEY)');
    console.log(`\n📧 [dev mode] Login code for ${email}: ${code}\n`);
}

app.post('/api/request-code', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: `Use your college email (@${ALLOWED_DOMAINS.join(' or @')})` });
    if (isBanned(email)) return res.status(403).json({ error: 'This account is banned.' });

    // Never block a student. Asking again always gives the SAME code while it's valid.
    // To save the daily email quota we just don't send a duplicate email if one went out
    // under a minute ago (or 5 already this hour) — their code still works.
    let entry = pendingCodes.get(email);
    const reused = !!entry && entry.expires - Date.now() > 2 * 60e3;
    if (!reused) {
        // Brand-new code: only a spam guard (campus Wi-Fi shares one IP, so this is generous)
        if (rateLimited(`ip:${req.ip}`, 300, 3600e3)) return res.status(429).json({ error: 'Too many login attempts from this network. Try again in a few minutes.' });
        const code = crypto.randomInt(0, 1e6).toString().padStart(6, '0');
        entry = { code, hash: hashCode(email, code), expires: Date.now() + CODE_TTL_MS, wrong: 0, sentAt: [] };
        pendingCodes.set(email, entry);
    }
    const minutesLeft = Math.max(1, Math.round((entry.expires - Date.now()) / 60e3));
    const now = Date.now();
    entry.sentAt = (entry.sentAt || []).filter(t => now - t < 3600e3);
    const sentRecently = entry.sentAt.some(t => now - t < 60e3) || entry.sentAt.length >= 5;
    if (reused && sentRecently) {
        return res.json({ ok: true, minutes: minutesLeft, resent: true, emailed: false });
    }
    try {
        await sendCodeEmail(email, entry.code, minutesLeft);
        entry.sentAt.push(Date.now());
        res.json({ ok: true, minutes: minutesLeft, resent: reused, emailed: true });
    } catch (err) {
        console.error(err);
        if (!reused) pendingCodes.delete(email);
        res.status(500).json({ error: "Couldn't send the email. Try again in a bit." });
    }
});

app.post('/api/verify-code', (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code || '').trim();
    if (req.body?.agree !== true) return res.status(400).json({ error: 'You need to confirm you are 18+ and accept the Terms & Privacy Policy.' });

    const entry = email && pendingCodes.get(email);
    if (!entry || entry.expires < Date.now()) return res.status(400).json({ error: 'Code expired. Ask for a new one.' });
    const a = Buffer.from(hashCode(email, code)), b = Buffer.from(entry.hash);
    if (!crypto.timingSafeEqual(a, b)) {
        // 5 wrong guesses and the code is thrown away, so nobody can guess their way in
        if (++entry.wrong >= 5) {
            pendingCodes.delete(email);
            return res.status(429).json({ error: 'Too many wrong tries. Ask for a new code.' });
        }
        return res.status(400).json({ error: 'Wrong code, try again.' });
    }

    // Right code: log in. The code stays valid until its 15 minutes are up (e.g. for a second device).
    startSession(res, email);
    res.json({ email });
});

app.get('/api/me', requireAuth, (req, res) => {
    // Sliding login: every visit pushes the expiry out again
    res.set('Set-Cookie', sessionCookie(createSession(req.email, req.device), SESSION_DAYS * 86400));
    res.json({ email: req.email, admin: isAdmin(req.email) });
});

// ---------- ADMIN (developer dashboard at /admin) ----------
function requireAdmin(req, res, next) {
    requireAuth(req, res, () => {
        if (!isAdmin(req.email)) return res.status(403).json({ error: 'Not an admin' });
        next();
    });
}

app.get('/api/admin/reports', requireAdmin, (req, res) => {
    const now = Date.now();
    const accounts = Object.entries(db.reports).map(([email, list]) => {
        const reasons = {};
        for (const r of list) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
        const ban = db.bans[email];
        return {
            email,
            reports: list.length,
            reporters: new Set(list.map(r => r.by)).size,
            reporters7d: new Set(list.filter(r => now - r.at < 7 * 864e5).map(r => r.by)).size,
            reasons,
            notes: list.filter(r => r.note).map(r => ({ note: r.note, reason: r.reason, at: r.at })).slice(-20).reverse(),
            lastAt: Math.max(...list.map(r => r.at)),
            redMark: !!db.marks[email],
            warned: db.marks[email]?.acknowledged ? 'acknowledged' : db.marks[email] ? 'pending' : null,
            banned: isBanned(email) ? { until: ban.until, reason: ban.reason } : null,
        };
    }).sort((a, b) => (b.redMark - a.redMark) || (b.reporters - a.reporters) || (b.lastAt - a.lastAt));
    // Banned accounts without current reports (e.g. manual bans) are listed too
    for (const [email, ban] of Object.entries(db.bans)) {
        if (!db.reports[email] && isBanned(email)) accounts.push({ email, reports: 0, reporters: 0, reporters7d: 0, reasons: {}, notes: [], lastAt: ban.at, redMark: false, warned: null, banned: { until: ban.until, reason: ban.reason } });
    }
    res.json({ redMarkAt: RED_MARK_AT, banAt: REPORTS_TO_BAN, banHours: BAN_HOURS, online: io.of('/').sockets.size, accounts });
});

app.post('/api/admin/ban', requireAdmin, (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: 'Bad email' });
    const hours = req.body?.hours === null ? null : Number(req.body?.hours);
    if (hours !== null && !(hours > 0)) return res.status(400).json({ error: 'Bad duration' });
    db.bans[email] = { until: hours === null ? null : Date.now() + hours * 3600e3, reason: 'admin', at: Date.now() };
    kickEmail(email);
    saveDb();
    res.json({ ok: true });
});

app.post('/api/admin/unban', requireAdmin, (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: 'Bad email' });
    delete db.bans[email];
    saveDb();
    res.json({ ok: true });
});

// Clear an account's reports and red mark (e.g. after reviewing false reports)
app.post('/api/admin/clear', requireAdmin, (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: 'Bad email' });
    delete db.reports[email];
    delete db.marks[email];
    saveDb();
    res.json({ ok: true });
});

// ---------- GOOGLE SIGN-IN (SRM's email runs on Google Workspace) ----------
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const codeLoginAvailable = !IS_PROD || emailConfigured;

// What the login page should offer
app.get('/api/config', (req, res) => {
    res.json({ googleClientId: GOOGLE_CLIENT_ID || null, codeLogin: codeLoginAvailable, domain: ALLOWED_DOMAINS[0] });
});

// Google's public signing keys, cached as long as Google says they're valid
let googleCerts = { keys: [], expires: 0 };
async function getGoogleCerts() {
    if (Date.now() < googleCerts.expires) return googleCerts.keys;
    const res = await fetch('https://www.googleapis.com/oauth2/v3/certs');
    if (!res.ok) throw new Error(`Could not fetch Google keys (${res.status})`);
    const maxAge = Number((res.headers.get('cache-control') || '').match(/max-age=(\d+)/)?.[1] || 3600);
    googleCerts = { keys: (await res.json()).keys, expires: Date.now() + maxAge * 1000 };
    return googleCerts.keys;
}

// Check a Google ID token ourselves: signature, issuer, audience, expiry, verified SRM account
function verifyGoogleIdToken(token, keys, clientId, now = Date.now()) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw new Error('malformed token');
    const [h, p, sig] = parts;
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (header.alg !== 'RS256') throw new Error('unexpected algorithm');
    const jwk = keys.find(k => k.kid === header.kid);
    if (!jwk) throw new Error('unknown signing key');
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url'));
    if (!ok) throw new Error('bad signature');
    if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) throw new Error('wrong issuer');
    if (payload.aud !== clientId) throw new Error('wrong audience');
    if (!payload.exp || payload.exp * 1000 < now - 60e3) throw new Error('expired');
    if (payload.email_verified !== true && payload.email_verified !== 'true') throw new Error('email not verified');
    const email = normalizeEmail(payload.email);
    // hd is only present for Workspace accounts, so personal Gmail can never pass
    if (!email || !ALLOWED_DOMAINS.includes(String(payload.hd || '').toLowerCase())) throw new Error('not an allowed domain');
    return email;
}

app.post('/api/google', async (req, res) => {
    if (!GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Google sign-in is not set up yet.' });
    if (req.body?.agree !== true) return res.status(400).json({ error: 'You need to confirm you are 18+ and accept the Terms & Privacy Policy.' });
    if (rateLimited(`google:${req.ip}`, 30, 3600e3)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });

    let email;
    try {
        email = verifyGoogleIdToken(req.body?.credential, await getGoogleCerts(), GOOGLE_CLIENT_ID);
    } catch (err) {
        const domainProblem = err.message === 'not an allowed domain';
        return res.status(domainProblem ? 403 : 400).json({
            error: domainProblem ? `Use your college Google account (@${ALLOWED_DOMAINS.join(' or @')})` : 'Google sign-in failed. Try again.',
        });
    }
    if (isBanned(email)) return res.status(403).json({ error: 'banned', until: db.bans[email].until });

    startSession(res, email);
    res.json({ email });
});

app.post('/api/logout', (req, res) => {
    const session = readSession(parseCookies(req.headers.cookie).sid);
    if (session) forgetDevice(session.email, session.device);
    res.set('Set-Cookie', sessionCookie('', 0));
    res.json({ ok: true });
});

// STUN finds your public address; TURN relays video when campus Wi-Fi blocks direct connections.
app.get('/api/ice', requireAuth, (req, res) => {
    // With a TURN server, video goes through the relay only, so users never see each other's IP address.
    if (process.env.TURN_URLS) {
        return res.json({
            relayOnly: true,
            iceServers: [{
                urls: process.env.TURN_URLS.split(',').map(u => u.trim()),
                username: process.env.TURN_USERNAME,
                credential: process.env.TURN_CREDENTIAL,
            }],
        });
    }
    // Without TURN (local testing), browsers connect directly and can see each other's IP address.
    res.json({ relayOnly: false, iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
});

// ---------- MATCHMAKING ----------
let waitingQueue = [];          // { id, email, mode, interests }
const partners = new Map();     // socketId -> partner socketId

function cleanInterests(list) {
    if (!Array.isArray(list)) return [];
    const out = list
        .filter(i => typeof i === 'string')
        .map(i => i.toLowerCase().replace(/[^a-z0-9 +#.-]/g, '').trim().slice(0, 20))
        .filter(Boolean);
    return [...new Set(out)].slice(0, 5);
}

function leaveQueue(id) {
    waitingQueue = waitingQueue.filter(w => w.id !== id);
}

function endPair(socket) {
    const partnerId = partners.get(socket.id);
    if (!partnerId) return;
    partners.delete(socket.id);
    partners.delete(partnerId);
    io.to(partnerId).emit('partner_left');
}

function kickEmail(email) {
    for (const s of io.of('/').sockets.values()) {
        if (s.data.email === email) {
            s.emit('banned', { until: db.bans[email]?.until });
            s.disconnect(true);
        }
    }
}

io.use((socket, next) => {
    const session = readSession(parseCookies(socket.handshake.headers.cookie).sid);
    if (!session) return next(new Error('unauthorized'));
    if (!useDevice(session.email, session.device)) return next(new Error('device_limit'));
    if (isBanned(session.email)) return next(new Error('banned'));
    socket.data.email = session.email;
    socket.data.device = session.device;
    next();
});

// Tell every open tab of this account about their red mark
function warningPayload(email) {
    const counts = {};
    for (const r of db.reports[email] || []) counts[r.reason] = (counts[r.reason] || 0) + 1;
    return { reporters: distinctReporters30d(email), reasons: counts };
}
function sendWarning(email) {
    for (const s of io.of('/').sockets.values()) if (s.data.email === email) s.emit('warning', warningPayload(email));
}

io.on('connection', (socket) => {
    socket.emit('online', io.of('/').sockets.size);
    const mark = db.marks[socket.data.email];
    if (mark && !mark.acknowledged) socket.emit('warning', warningPayload(socket.data.email));

    // 1. Join / Matchmaking
    socket.on('join', (opts = {}) => {
        endPair(socket);
        leaveQueue(socket.id);

        const mode = opts?.mode === 'text' ? 'text' : 'video';
        const interests = cleanInterests(opts?.interests);
        const me = { id: socket.id, email: socket.data.email, mode, interests };

        // Best match: same mode, most shared interests, preferably not the person you just skipped.
        let best = null, bestScore = -1;
        for (const w of waitingQueue) {
            if (w.mode !== mode || w.email === me.email) continue;
            const shared = w.interests.filter(i => interests.includes(i)).length;
            const score = shared * 10 + (w.id === socket.data.lastPartner ? 0 : 1);
            if (score > bestScore) { best = w; bestScore = score; }
        }

        if (!best) {
            waitingQueue.push(me);
            return;
        }

        leaveQueue(best.id);
        const partnerSocket = io.of('/').sockets.get(best.id);
        if (!partnerSocket) {
            waitingQueue.push(me);
            return;
        }

        const shared = best.interests.filter(i => interests.includes(i));
        partners.set(socket.id, best.id);
        partners.set(best.id, socket.id);
        socket.data.lastPartner = best.id;
        partnerSocket.data.lastPartner = socket.id;

        socket.emit('matched', { initiator: true, mode, shared });
        partnerSocket.emit('matched', { initiator: false, mode, shared });
    });

    // 2. Signaling (video handshake) — only ever relayed to your current partner
    socket.on('signal', (signal) => {
        const partnerId = partners.get(socket.id);
        if (partnerId) io.to(partnerId).emit('signal', signal);
    });

    // 3. Chat
    socket.on('chat_message', (msg) => {
        const partnerId = partners.get(socket.id);
        if (!partnerId || typeof msg !== 'string') return;
        const text = msg.trim().slice(0, 500);
        if (!text) return;
        if (rateLimited(`msg:${socket.id}`, 8, 5000)) {
            socket.emit('system', 'Slow down a little 😅');
            return;
        }
        io.to(partnerId).emit('chat_message', text);
    });

    socket.on('typing', (isTyping) => {
        const partnerId = partners.get(socket.id);
        if (partnerId) io.to(partnerId).emit('typing', !!isTyping);
    });

    // 4. Leave the current chat (stop or before "next")
    socket.on('leave', () => {
        endPair(socket);
        leaveQueue(socket.id);
    });

    // 5. Report
    socket.on('report', (data) => {
        const partnerId = partners.get(socket.id);
        const reported = partnerId && io.of('/').sockets.get(partnerId)?.data.email;
        endPair(socket);
        if (!reported) return;
        if (rateLimited(`report:${socket.data.email}`, 5, 3600e3)) return;

        const REASONS = ['nudity', 'harassment', 'underage', 'spam', 'other'];
        const reason = REASONS.includes(data?.reason) ? data.reason : 'other';
        // Optional short note from the reporter, only visible to admins, deleted with the report after 30 days
        const note = String(data?.note || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
        const list = db.reports[reported] || [];
        list.push({ by: reporterId(socket.data.email), reason, ...(note && { note }), at: Date.now() });
        db.reports[reported] = list;

        // Short-term: several different reporters within 7 days → automatic temporary ban
        const weekAgo = Date.now() - 7 * 864e5;
        const recentReporters = new Set(list.filter(r => r.at > weekAgo).map(r => r.by)).size;
        const reporters30d = distinctReporters30d(reported);
        console.log(`🚩 Report received (${reason}); ${reporters30d} different reporter(s) on this account in 30 days`);

        // Long-term: more than RED_MARK_AT different reporters within 30 days → red mark + warning
        if (reporters30d > RED_MARK_AT && !db.marks[reported]) {
            db.marks[reported] = { at: Date.now(), count: reporters30d, acknowledged: false };
            console.log('🟥 An account got a red mark');
        } else if (db.marks[reported]) {
            db.marks[reported].count = reporters30d;
        }

        if (recentReporters >= REPORTS_TO_BAN && !isBanned(reported)) {
            db.bans[reported] = { until: Date.now() + BAN_HOURS * 3600e3, reason: 'auto: multiple reports', at: Date.now() };
            console.log(`⛔ An account was auto-banned for ${BAN_HOURS}h`);
            kickEmail(reported);
        } else if (db.marks[reported] && !db.marks[reported].acknowledged) {
            sendWarning(reported);
        }
        saveDb();
    });

    // The reported person tapped "I understand" on their warning
    socket.on('ack_warning', () => {
        const mark = db.marks[socket.data.email];
        if (mark && !mark.acknowledged) { mark.acknowledged = true; mark.acknowledgedAt = Date.now(); saveDb(); }
    });

    // 6. Disconnect
    socket.on('disconnect', () => {
        endPair(socket);
        leaveQueue(socket.id);
        hits.delete(`msg:${socket.id}`);
    });
});

// Online counter, pushed every few seconds when it changes
let lastOnline = -1;
setInterval(() => {
    const count = io.of('/').sockets.size;
    if (count !== lastOnline) {
        lastOnline = count;
        io.emit('online', count);
    }
}, 3000).unref();

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. The app is probably already running in another terminal. Stop it with Ctrl+C there, or use PORT=3001 npm start.`);
        process.exit(1);
    }
    throw err;
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on ${useLocalHttps ? 'https' : 'http'}://localhost:${PORT}`);
    console.log(`Allowed email domains: ${ALLOWED_DOMAINS.join(', ')}`);
    if (webhookConfigured) console.log('Login codes are emailed through the Google Apps Script mailer');
    else if (gmail) console.log(`Login codes are emailed from ${GMAIL_USER}`);
    else if (process.env.RESEND_API_KEY) console.log('Login codes are emailed through Resend');
    else console.log('No email sender set up: login codes will be printed here instead of emailed.');
});

// Minimal .env reader so you don't need an extra package.
function loadEnvFile(file) {
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
}

module.exports = { verifyGoogleIdToken };

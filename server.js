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
const SESSION_DAYS = 30;
const CODE_TTL_MS = 10 * 60 * 1000;
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
    "script-src 'self' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "media-src 'self' blob: https://d8j0ntlcm91z4.cloudfront.net",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
].join('; ');

app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Frame-Options', 'DENY');
    res.set('Content-Security-Policy', CSP);
    res.set('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()');
    if (IS_PROD) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
});
// Pages can be linked without .html (e.g. /privacy once legal pages are added)
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

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
    if (changed) saveDb();
}
pruneDb();
setInterval(pruneDb, 3600e3).unref();

// A ban with until: null is permanent (set it by hand in data/moderation.json).
function isBanned(email) {
    const ban = db.bans[email];
    return !!ban && (ban.until === null || ban.until > Date.now());
}

// ---------- SESSIONS (signed cookie, survives restarts) ----------
function sign(payload) {
    return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}

function createSession(email) {
    const payload = Buffer.from(JSON.stringify({ e: email, x: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
    return `${payload}.${sign(payload)}`;
}

function readSession(token) {
    if (typeof token !== 'string') return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const a = Buffer.from(sig), b = Buffer.from(sign(payload));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        const { e, x } = JSON.parse(Buffer.from(payload, 'base64url').toString());
        return Date.now() < x ? e : null;
    } catch { return null; }
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
    const email = readSession(parseCookies(req.headers.cookie).sid);
    if (!email) return res.status(401).json({ error: 'Not logged in' });
    if (isBanned(email)) return res.status(403).json({ error: 'banned', until: db.bans[email].until });
    req.email = email;
    next();
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
const pendingCodes = new Map(); // email -> { hash, expires, attempts }

function normalizeEmail(raw) {
    if (typeof raw !== 'string') return null;
    const email = raw.trim().toLowerCase();
    const m = email.match(/^[a-z0-9._%+-]+@([a-z0-9.-]+)$/);
    if (!m || email.length > 254 || !ALLOWED_DOMAINS.includes(m[1])) return null;
    return email;
}

const hashCode = (email, code) => crypto.createHash('sha256').update(`${email}:${code}:${SESSION_SECRET}`).digest('hex');

async function sendCodeEmail(email, code) {
    if (!process.env.RESEND_API_KEY) {
        if (IS_PROD) throw new Error('RESEND_API_KEY is not set');
        console.log(`\n📧 [dev mode] Login code for ${email}: ${code}\n`);
        return;
    }
    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from: process.env.EMAIL_FROM || 'onboarding@resend.dev',
            to: email,
            subject: `Your login code: ${code}`,
            text: `Your login code is ${code}\n\nIt expires in 10 minutes. If you didn't ask for this, ignore this email.`,
        }),
    });
    if (!res.ok) throw new Error(`Resend error ${res.status}: ${await res.text()}`);
}

app.post('/api/request-code', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: `Use your college email (@${ALLOWED_DOMAINS.join(' or @')})` });
    if (isBanned(email)) return res.status(403).json({ error: 'This account is banned.' });

    if (rateLimited(`ip:${req.ip}`, 10, 3600e3) || rateLimited(`hour:${email}`, 5, 3600e3)) {
        return res.status(429).json({ error: 'Too many codes requested. Try again later.' });
    }
    if (rateLimited(`min:${email}`, 1, 60e3)) {
        return res.status(429).json({ error: 'Wait a minute before asking for another code.' });
    }

    const code = crypto.randomInt(0, 1e6).toString().padStart(6, '0');
    pendingCodes.set(email, { hash: hashCode(email, code), expires: Date.now() + CODE_TTL_MS, attempts: 0 });
    try {
        await sendCodeEmail(email, code);
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        pendingCodes.delete(email);
        res.status(500).json({ error: "Couldn't send the email. Try again in a bit." });
    }
});

app.post('/api/verify-code', (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code || '').trim();
    if (req.body?.agree !== true) return res.status(400).json({ error: 'You need to confirm you are 18+ and accept the rules.' });

    const entry = email && pendingCodes.get(email);
    if (!entry || entry.expires < Date.now()) return res.status(400).json({ error: 'Code expired. Ask for a new one.' });
    if (++entry.attempts > 5) {
        pendingCodes.delete(email);
        return res.status(429).json({ error: 'Too many wrong tries. Ask for a new code.' });
    }
    const a = Buffer.from(hashCode(email, code)), b = Buffer.from(entry.hash);
    if (!crypto.timingSafeEqual(a, b)) return res.status(400).json({ error: 'Wrong code, try again.' });

    pendingCodes.delete(email);
    res.set('Set-Cookie', sessionCookie(createSession(email), SESSION_DAYS * 86400));
    res.json({ email });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ email: req.email }));

app.post('/api/logout', (req, res) => {
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
    const email = readSession(parseCookies(socket.handshake.headers.cookie).sid);
    if (!email) return next(new Error('unauthorized'));
    if (isBanned(email)) return next(new Error('banned'));
    socket.data.email = email;
    next();
});

io.on('connection', (socket) => {
    socket.emit('online', io.of('/').sockets.size);

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

        // Only fixed reasons are stored, so no free text (or personal details) ends up in the file
        const REASONS = ['nudity', 'harassment', 'underage', 'spam', 'other'];
        const reason = REASONS.includes(data?.reason) ? data.reason : 'other';
        const weekAgo = Date.now() - 7 * 864e5;
        const list = (db.reports[reported] || []).filter(r => r.at > weekAgo);
        list.push({ by: reporterId(socket.data.email), reason, at: Date.now() });
        db.reports[reported] = list;
        console.log(`🚩 Report received (${reason}); ${list.length} report(s) on this account in 7 days`);

        const distinctReporters = new Set(list.map(r => r.by)).size;
        if (distinctReporters >= REPORTS_TO_BAN && !isBanned(reported)) {
            db.bans[reported] = { until: Date.now() + BAN_HOURS * 3600e3, reason: 'auto: multiple reports', at: Date.now() };
            console.log(`⛔ An account was auto-banned for ${BAN_HOURS}h`);
            kickEmail(reported);
        }
        saveDb();
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
    if (!process.env.RESEND_API_KEY) console.log('No RESEND_API_KEY set: login codes will be printed here instead of emailed.');
});

// Minimal .env reader so you don't need an extra package.
function loadEnvFile(file) {
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
}

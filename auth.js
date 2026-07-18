// ── Auth (password hashing + signed-cookie sessions) ────────────────────────
// Zero external auth deps: scrypt for password hashing, HMAC-signed stateless
// cookie for sessions. Mirrors the app's "keep it simple" style.
const crypto = require('crypto');
const db = require('./db');

const COOKIE_NAME   = 'bewe_sess';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// SESSION_SECRET should be set in .env so sessions survive restarts. If missing
// we generate an ephemeral one (dev only) — every restart then logs everyone out.
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
    SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    console.warn('auth: SESSION_SECRET not set — using an ephemeral secret (sessions reset on restart)');
}

// Reserved local-parts that must never be handed to a normal user.
const RESERVED = new Set([
    'admin', 'administrator', 'postmaster', 'hostmaster', 'webmaster',
    'abuse', 'root', 'no-reply', 'noreply', 'mailer-daemon', 'daemon',
    'support', 'info', 'security', 'ssl', 'www', 'ftp', 'mail',
]);

// Normalize/validate a requested username (email local-part). Returns the
// canonical lowercase form or null if invalid. 3–32 chars, must start/end
// alphanumeric, inner chars [a-z0-9._-], no consecutive dots.
function normalizeUsername(raw) {
    const u = String(raw || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/.test(u)) return null;
    if (u.includes('..')) return null;
    if (RESERVED.has(u)) return null;
    return u;
}

// ── passwords ──
function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const dk = crypto.scryptSync(String(password), salt, 64);
    return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
}

function verifyPassword(password, stored) {
    const [algo, saltHex, hashHex] = String(stored).split('$');
    if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const dk = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 64);
    return expected.length === dk.length && crypto.timingSafeEqual(expected, dk);
}

// ── session cookie ──
function signSession(username) {
    const payload = Buffer.from(JSON.stringify({ u: username, t: Date.now() })).toString('base64url');
    const mac = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    return `${payload}.${mac}`;
}

function readSession(token) {
    if (!token) return null;
    const dot = token.lastIndexOf('.');
    if (dot < 0) return null;
    const payload = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    const macBuf = Buffer.from(mac);
    const expBuf = Buffer.from(expected);
    if (macBuf.length !== expBuf.length || !crypto.timingSafeEqual(macBuf, expBuf)) return null;
    try {
        const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!obj.u || (Date.now() - obj.t) > SESSION_TTL_MS) return null;
        return obj.u;
    } catch { return null; }
}

function parseCookies(header) {
    const out = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

// Secure flag only when the edge served us over HTTPS (Cloudflare tunnel sets
// X-Forwarded-Proto). Lets plain-HTTP localhost testing keep the cookie.
function isHttps(req) {
    return (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function setSessionCookie(req, res, username) {
    const attrs = [
        `${COOKIE_NAME}=${signSession(username)}`,
        'HttpOnly', 'SameSite=Lax', 'Path=/',
        `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ];
    if (isHttps(req)) attrs.push('Secure');
    res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(req, res) {
    const attrs = [`${COOKIE_NAME}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
    if (isHttps(req)) attrs.push('Secure');
    res.setHeader('Set-Cookie', attrs.join('; '));
}

// Resolve the current user from the request cookie, or null. Only active/admin
// accounts count as logged in (pending accounts cannot authenticate).
function currentUser(req) {
    const cookies = parseCookies(req.headers.cookie);
    const username = readSession(cookies[COOKIE_NAME]);
    if (!username) return null;
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!u || (u.status !== 'active' && u.status !== 'admin')) return null;
    return u;
}

function requireAuth(req, res, next) {
    const u = currentUser(req);
    if (!u) return res.status(401).json({ error: 'unauthorized' });
    req.user = u;
    next();
}

function requireAdmin(req, res, next) {
    const u = currentUser(req);
    if (!u) return res.status(401).json({ error: 'unauthorized' });
    if (u.status !== 'admin') return res.status(403).json({ error: 'forbidden' });
    req.user = u;
    next();
}

module.exports = {
    normalizeUsername, hashPassword, verifyPassword,
    setSessionCookie, clearSessionCookie, currentUser,
    requireAuth, requireAdmin,
};

'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set');
  return s;
}

// Panel session token. The bot sends this same token inside the magic login
// link, so there is no separate password: Telegram account == identity.
function signToken(payload, expiresIn = '30d') {
  return jwt.sign(payload, secret(), { expiresIn });
}

function verifyToken(token) {
  return jwt.verify(token, secret());
}

function authMiddleware(req, res, next) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer (.+)$/);
  const token = m ? m[1] : req.query.token;
  if (!token) return res.status(401).json({ error: 'auth required' });
  try {
    const p = verifyToken(token);
    if (!p.tg_id) throw new Error('bad token');
    req.user = p;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid token' });
  }
}

// --- Telegram Login Widget verification (https://core.telegram.org/widgets/login) ---
function verifyTelegramWidget(data, botToken) {
  const { hash, ...rest } = data;
  if (!hash) return null;
  const check = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join('\n');
  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  const hmac = crypto.createHmac('sha256', secretKey).update(check).digest('hex');
  if (hmac !== hash) return null;
  const authDate = Number(rest.auth_date || 0);
  if (authDate && Date.now() / 1000 - authDate > 86400) return null; // 24h
  return { tg_id: Number(rest.id), first_name: rest.first_name, username: rest.username };
}

// --- Telegram WebApp initData verification (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app) ---
function verifyWebAppInitData(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const keys = [...params.keys()].sort();
    const check = keys.map((k) => `${k}=${params.get(k)}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const hmac = crypto.createHmac('sha256', secretKey).update(check).digest('hex');
    if (hmac !== hash) return null;
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !user.id) return null;
    const authDate = Number(params.get('auth_date') || 0);
    if (authDate && Date.now() / 1000 - authDate > 86400 * 7) return null;
    return { tg_id: user.id, first_name: user.first_name, username: user.username };
  } catch (_) {
    return null;
  }
}

module.exports = { signToken, verifyToken, authMiddleware, verifyTelegramWidget, verifyWebAppInitData };

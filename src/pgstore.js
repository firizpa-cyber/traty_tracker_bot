'use strict';
// PostgreSQL store. Used when DATABASE_URL is set (e.g. Vercel Postgres /
// Neon) so data survives redeploys and cold starts. Without DATABASE_URL the
// app falls back to the local SQLite file (see db.js).
//
// Same function names and (db, ...) signatures as db.js; every function is
// async (SQLite versions stay sync — `await` works for both). Pure date
// helpers are re-exported from db.js.

const base = require('./db');

let sharedPool = null;

function getPool() {
  if (sharedPool) return sharedPool;
  const { Pool } = require('pg');
  const cs = process.env.DATABASE_URL || '';
  const local = /localhost|127\.0\.0\.1/.test(cs);
  sharedPool = new Pool({
    connectionString: cs,
    ssl: local ? false : { rejectUnauthorized: false },
  });
  return sharedPool;
}

async function openDb() {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      tg_id BIGINT PRIMARY KEY,
      first_name TEXT,
      username TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      tg_id BIGINT NOT NULL,
      amount DOUBLE PRECISION NOT NULL,
      currency TEXT NOT NULL,
      amount_base DOUBLE PRECISION NOT NULL,
      base_currency TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      day TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_expenses_user_day ON expenses(tg_id, day);
    CREATE TABLE IF NOT EXISTS limits (
      tg_id BIGINT NOT NULL,
      category TEXT NOT NULL,
      amount_base DOUBLE PRECISION NOT NULL,
      PRIMARY KEY (tg_id, category)
    );
    CREATE TABLE IF NOT EXISTS pairs (
      tg_id BIGINT PRIMARY KEY,
      partner_tg_id BIGINT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS pair_codes (
      code TEXT PRIMARY KEY,
      owner_tg_id BIGINT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);
  return pool;
}

function nowIso() {
  return new Date().toISOString();
}

async function upsertUser(pool, { tg_id, first_name, username }) {
  await pool.query(
    `INSERT INTO users (tg_id, first_name, username)
     VALUES ($1, $2, $3)
     ON CONFLICT(tg_id) DO UPDATE SET first_name=EXCLUDED.first_name, username=EXCLUDED.username`,
    [tg_id, first_name || null, username || null]
  );
}

async function addExpense(pool, tgId, e) {
  const createdAt = e.created_at || nowIso();
  const day = e.day || base.ymdInTz(new Date(createdAt));
  const r = await pool.query(
    `INSERT INTO expenses (tg_id, amount, currency, amount_base, base_currency, description, category, day, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
    [
      tgId, e.amount, e.currency, e.amountBase ?? e.amount_base,
      e.baseCurrency ?? e.base_currency, e.description, e.category || 'other',
      day, createdAt,
    ]
  );
  return r.rows[0];
}

async function getExpense(pool, tgId, id) {
  const r = await pool.query('SELECT * FROM expenses WHERE tg_id = $1 AND id = $2', [tgId, id]);
  return r.rows[0] || null;
}

function whereClause({ from, to, category, q }) {
  const where = ['tg_id = $1'];
  const params = [];
  let n = 2;
  if (from) { where.push(`day >= $${n++}`); params.push(from); }
  if (to) { where.push(`day <= $${n++}`); params.push(to); }
  if (category && category !== 'all') { where.push(`category = $${n++}`); params.push(category); }
  if (q) { where.push(`description LIKE $${n++}`); params.push(`%${q}%`); }
  return { where: where.join(' AND '), params, n };
}

async function listExpenses(pool, tgId, { from, to, category, q, limit = 50, offset = 0 } = {}) {
  const { where, params, n } = whereClause({ from, to, category, q });
  const rows = (
    await pool.query(
      `SELECT * FROM expenses WHERE ${where} ORDER BY day DESC, id DESC LIMIT $${n} OFFSET $${n + 1}`,
      [tgId, ...params, Math.min(limit, 5000), Math.max(offset, 0)]
    )
  ).rows;
  const total = Number(
    (await pool.query(`SELECT COUNT(*) AS cnt FROM expenses WHERE ${where}`, [tgId, ...params])).rows[0].cnt
  );
  return { rows, total };
}

async function updateExpense(pool, tgId, id, patch) {
  const cur = await getExpense(pool, tgId, id);
  if (!cur) return null;
  const next = {
    amount: patch.amount ?? cur.amount,
    currency: patch.currency ?? cur.currency,
    amount_base: patch.amount_base ?? patch.amountBase ?? cur.amount_base,
    base_currency: patch.base_currency ?? patch.baseCurrency ?? cur.base_currency,
    description: patch.description ?? cur.description,
    category: patch.category ?? cur.category,
    day: patch.day ?? cur.day,
  };
  const r = await pool.query(
    `UPDATE expenses SET amount=$3, currency=$4, amount_base=$5, base_currency=$6,
      description=$7, category=$8, day=$9, updated_at=$10
     WHERE tg_id=$1 AND id=$2 RETURNING *`,
    [tgId, id, next.amount, next.currency, next.amount_base, next.base_currency,
      next.description, next.category, next.day, nowIso()]
  );
  return r.rows[0] || null;
}

async function deleteExpense(pool, tgId, id) {
  const r = await pool.query('DELETE FROM expenses WHERE tg_id = $1 AND id = $2', [tgId, id]);
  return r.rowCount > 0;
}

async function sumBetween(pool, tgId, from, to) {
  const r = (
    await pool.query(
      `SELECT SUM(amount_base) AS total, COUNT(*) AS cnt FROM expenses WHERE tg_id = $1 AND day >= $2 AND day <= $3`,
      [tgId, from, to]
    )
  ).rows[0];
  return { total: Math.round(Number(r.total || 0) * 100) / 100, count: Number(r.cnt) };
}

async function totalsByCategory(pool, tgId, from, to) {
  const r = await pool.query(
    `SELECT category, SUM(amount_base) AS total, COUNT(*) AS cnt
     FROM expenses WHERE tg_id = $1 AND day >= $2 AND day <= $3 GROUP BY category ORDER BY total DESC`,
    [tgId, from, to]
  );
  return r.rows.map((x) => ({ category: x.category, total: Number(x.total), cnt: Number(x.cnt) }));
}

async function totalsByDay(pool, tgId, from, to) {
  const r = await pool.query(
    `SELECT day, SUM(amount_base) AS total, COUNT(*) AS cnt
     FROM expenses WHERE tg_id = $1 AND day >= $2 AND day <= $3 GROUP BY day ORDER BY day ASC`,
    [tgId, from, to]
  );
  return r.rows.map((x) => ({ day: x.day, total: Number(x.total), cnt: Number(x.cnt) }));
}

async function getLimits(pool, tgId) {
  const r = await pool.query('SELECT category, amount_base FROM limits WHERE tg_id = $1', [tgId]);
  return r.rows.map((x) => ({ category: x.category, amount_base: Number(x.amount_base) }));
}

async function setLimit(pool, tgId, category, amountBase) {
  await pool.query(
    `INSERT INTO limits (tg_id, category, amount_base) VALUES ($1, $2, $3)
     ON CONFLICT(tg_id, category) DO UPDATE SET amount_base=EXCLUDED.amount_base`,
    [tgId, category, amountBase]
  );
}

async function deleteLimit(pool, tgId, category) {
  await pool.query('DELETE FROM limits WHERE tg_id = $1 AND category = $2', [tgId, category]);
}

async function getLimit(pool, tgId, category) {
  const r = await pool.query('SELECT amount_base FROM limits WHERE tg_id = $1 AND category = $2', [tgId, category]);
  return r.rows[0] ? Number(r.rows[0].amount_base) : null;
}

// --- Shared budget for two ---
const crypto = require('crypto');
const PAIR_TTL_MS = 15 * 60 * 1000;

async function createPairCode(pool, ownerTgId) {
  await pool.query('DELETE FROM pair_codes WHERE owner_tg_id = $1 OR expires_at <= $2', [ownerTgId, nowIso()]);
  const code = String(crypto.randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + PAIR_TTL_MS).toISOString();
  await pool.query('INSERT INTO pair_codes (code, owner_tg_id, expires_at) VALUES ($1, $2, $3)', [code, ownerTgId, expiresAt]);
  return { code, expiresAt };
}

async function getPair(pool, tgId) {
  const r = await pool.query(
    `SELECT p.partner_tg_id AS tg_id, u.first_name, u.username
     FROM pairs p LEFT JOIN users u ON u.tg_id = p.partner_tg_id
     WHERE p.tg_id = $1`,
    [tgId]
  );
  if (!r.rows[0]) return null;
  return { ...r.rows[0], tg_id: Number(r.rows[0].tg_id) };
}

async function linkPair(pool, tgId, code) {
  const c = String(code || '').trim();
  const inv = (await pool.query('SELECT owner_tg_id, expires_at FROM pair_codes WHERE code = $1', [c])).rows[0];
  if (!inv) return { error: 'Такого кода нет. Попросите партнёра создать новый: /pair' };
  if (new Date(inv.expires_at).toISOString() <= nowIso()) {
    await pool.query('DELETE FROM pair_codes WHERE code = $1', [c]);
    return { error: 'Код истёк. Создайте новый: /pair' };
  }
  const owner = Number(inv.owner_tg_id);
  if (owner === tgId) return { error: 'Это ваш собственный код. Отправьте его партнёру.' };
  if (await getPair(pool, tgId)) return { error: 'Вы уже в паре. Сначала /unpair' };
  if (await getPair(pool, owner)) return { error: 'Партнёр уже в другой паре.' };
  const now = nowIso();
  await pool.query('INSERT INTO pairs (tg_id, partner_tg_id, created_at) VALUES ($1, $2, $3)', [tgId, owner, now]);
  await pool.query('INSERT INTO pairs (tg_id, partner_tg_id, created_at) VALUES ($1, $2, $3)', [owner, tgId, now]);
  await pool.query('DELETE FROM pair_codes WHERE code = $1', [c]);
  return { partnerTgId: owner };
}

async function unpair(pool, tgId) {
  const p = await getPair(pool, tgId);
  if (!p) return false;
  await pool.query('DELETE FROM pairs WHERE tg_id = $1 OR tg_id = $2', [tgId, Number(p.tg_id)]);
  return true;
}

async function sharedMonth(pool, tgId, from, to) {
  const partner = await getPair(pool, tgId);
  if (!partner) return null;
  const partnerId = Number(partner.tg_id);
  const mine = await sumBetween(pool, tgId, from, to);
  const theirs = await sumBetween(pool, partnerId, from, to);
  const merge = new Map();
  for (const r of await totalsByCategory(pool, tgId, from, to)) {
    merge.set(r.category, { category: r.category, mine: r.total, theirs: 0, total: r.total });
  }
  for (const r of await totalsByCategory(pool, partnerId, from, to)) {
    const e = merge.get(r.category) || { category: r.category, mine: 0, theirs: 0, total: 0 };
    e.theirs = r.total;
    e.total = Math.round((e.mine + e.theirs) * 100) / 100;
    merge.set(r.category, e);
  }
  return {
    partner: { ...partner, tg_id: partnerId },
    mine,
    theirs,
    combined: {
      total: Math.round((mine.total + theirs.total) * 100) / 100,
      count: mine.count + theirs.count,
    },
    byCat: [...merge.values()].sort((a, b) => b.total - a.total),
  };
}

module.exports = {
  // pure helpers shared with sqlite
  ymdInTz: base.ymdInTz,
  addDaysYmd: base.addDaysYmd,
  mondayOf: base.mondayOf,
  monthRangeSafe: base.monthRangeSafe,
  openDb,
  upsertUser,
  addExpense,
  getExpense,
  listExpenses,
  updateExpense,
  deleteExpense,
  sumBetween,
  totalsByCategory,
  totalsByDay,
  getLimits,
  setLimit,
  deleteLimit,
  getLimit,
  createPairCode,
  getPair,
  linkPair,
  unpair,
  sharedMonth,
};

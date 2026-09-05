'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// node:sqlite (built into Node ≥ 22): zero native deps, nothing to install.
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('This project needs Node.js 22+. Current:', process.version);
  throw e;
}

// Day boundaries in a fixed timezone (default Asia/Dushanbe).
function tz() {
  return process.env.TIMEZONE || 'Asia/Dushanbe';
}

function ymdInTz(date = new Date(), timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || tz(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(date); // YYYY-MM-DD
}

function addDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function mondayOf(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = (dt.getUTCDay() + 6) % 7; // Mon=0
  dt.setUTCDate(dt.getUTCDate() - dow);
  return dt.toISOString().slice(0, 10);
}

function monthRangeSafe(month) {
  const [y, m] = month.split('-').map(Number);
  const firstNext = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1));
  firstNext.setUTCDate(firstNext.getUTCDate() - 1);
  return { from: `${month}-01`, to: firstNext.toISOString().slice(0, 10) };
}

function openDb(dataDir) {
  const dir = dataDir || process.env.DATA_DIR || './data';
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'expenses.db');
  const db = new DatabaseSync(file);
  try { db.exec('PRAGMA journal_mode = WAL;'); } catch (_) {}
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      tg_id INTEGER PRIMARY KEY,
      first_name TEXT,
      username TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tg_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      amount_base REAL NOT NULL,
      base_currency TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      day TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_expenses_user_day ON expenses(tg_id, day);
    CREATE TABLE IF NOT EXISTS limits (
      tg_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      amount_base REAL NOT NULL,
      PRIMARY KEY (tg_id, category)
    );
    CREATE TABLE IF NOT EXISTS pairs (
      tg_id INTEGER PRIMARY KEY,
      partner_tg_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS pair_codes (
      code TEXT PRIMARY KEY,
      owner_tg_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
  // Light migration: older DBs may miss columns.
  const cols = db.prepare('PRAGMA table_info(expenses)').all().map((c) => c.name);
  if (!cols.includes('day')) {
    db.exec(`ALTER TABLE expenses ADD COLUMN day TEXT DEFAULT ''`);
    db.exec(`UPDATE expenses SET day = substr(created_at, 1, 10) WHERE day = ''`);
  }
  return db;
}

function nowIso() {
  return new Date().toISOString();
}

function upsertUser(db, { tg_id, first_name, username }) {
  db.prepare(
    `INSERT INTO users (tg_id, first_name, username)
     VALUES (@tg_id, @first_name, @username)
     ON CONFLICT(tg_id) DO UPDATE SET first_name=excluded.first_name, username=excluded.username`
  ).run({ tg_id, first_name: first_name || null, username: username || null });
}

function addExpense(db, tgId, e) {
  const createdAt = e.created_at || nowIso();
  const day = e.day || ymdInTz(new Date(createdAt));
  const row = db.prepare(
    `INSERT INTO expenses (tg_id, amount, currency, amount_base, base_currency, description, category, day, created_at, updated_at)
     VALUES (@tg_id, @amount, @currency, @amount_base, @base_currency, @description, @category, @day, @created_at, @updated_at)`
  ).run({
    tg_id: tgId,
    amount: e.amount,
    currency: e.currency,
    amount_base: e.amountBase ?? e.amount_base,
    base_currency: e.baseCurrency ?? e.base_currency,
    description: e.description,
    category: e.category || 'other',
    day,
    created_at: createdAt,
    updated_at: createdAt,
  });
  return getExpense(db, tgId, row.lastInsertRowid);
}

function getExpense(db, tgId, id) {
  return db.prepare('SELECT * FROM expenses WHERE tg_id = ? AND id = ?').get(tgId, id) || null;
}

function listExpenses(db, tgId, { from, to, category, q, limit = 50, offset = 0 } = {}) {
  const where = ['tg_id = ?'];
  const params = [tgId];
  if (from) { where.push('day >= ?'); params.push(from); }
  if (to) { where.push('day <= ?'); params.push(to); }
  if (category && category !== 'all') { where.push('category = ?'); params.push(category); }
  if (q) { where.push('description LIKE ?'); params.push(`%${q}%`); }
  const rows = db.prepare(
    `SELECT * FROM expenses WHERE ${where.join(' AND ')} ORDER BY day DESC, id DESC LIMIT ? OFFSET ?`
  ).all(...params, Math.min(limit, 200), Math.max(offset, 0));
  const total = db.prepare(`SELECT COUNT(*) v FROM expenses WHERE ${where.join(' AND ')}`).get(...params).v;
  return { rows, total };
}

function updateExpense(db, tgId, id, patch) {
  const cur = getExpense(db, tgId, id);
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
  db.prepare(
    `UPDATE expenses SET amount=@amount, currency=@currency, amount_base=@amount_base,
      base_currency=@base_currency, description=@description, category=@category, day=@day,
      updated_at=@updated_at WHERE tg_id=@tg_id AND id=@id`
  ).run({ ...next, updated_at: nowIso(), tg_id: tgId, id });
  return getExpense(db, tgId, id);
}

function deleteExpense(db, tgId, id) {
  const r = db.prepare('DELETE FROM expenses WHERE tg_id = ? AND id = ?').run(tgId, id);
  return r.changes > 0;
}

function sumBetween(db, tgId, from, to) {
  const r = db.prepare(
    `SELECT COALESCE(SUM(amount_base), 0) total, COUNT(*) cnt FROM expenses WHERE tg_id = ? AND day >= ? AND day <= ?`
  ).get(tgId, from, to);
  return { total: Math.round(r.total * 100) / 100, count: r.cnt };
}

function totalsByCategory(db, tgId, from, to) {
  return db.prepare(
    `SELECT category, COALESCE(SUM(amount_base),0) total, COUNT(*) cnt
     FROM expenses WHERE tg_id = ? AND day >= ? AND day <= ? GROUP BY category ORDER BY total DESC`
  ).all(tgId, from, to);
}

function totalsByDay(db, tgId, from, to) {
  return db.prepare(
    `SELECT day, COALESCE(SUM(amount_base),0) total, COUNT(*) cnt
     FROM expenses WHERE tg_id = ? AND day >= ? AND day <= ? GROUP BY day ORDER BY day ASC`
  ).all(tgId, from, to);
}

function getLimits(db, tgId) {
  return db.prepare('SELECT category, amount_base FROM limits WHERE tg_id = ?').all(tgId);
}

function setLimit(db, tgId, category, amountBase) {
  db.prepare(
    `INSERT INTO limits (tg_id, category, amount_base) VALUES (?, ?, ?)
     ON CONFLICT(tg_id, category) DO UPDATE SET amount_base=excluded.amount_base`
  ).run(tgId, category, amountBase);
}

function deleteLimit(db, tgId, category) {
  db.prepare('DELETE FROM limits WHERE tg_id = ? AND category = ?').run(tgId, category);
}

function getLimit(db, tgId, category) {
  const row = db.prepare('SELECT amount_base FROM limits WHERE tg_id = ? AND category = ?').get(tgId, category);
  return row ? row.amount_base : null;
}

// --- Shared budget for two ---
const PAIR_TTL_MS = 15 * 60 * 1000;

function createPairCode(db, ownerTgId) {
  db.prepare('DELETE FROM pair_codes WHERE owner_tg_id = ? OR expires_at <= ?').run(ownerTgId, nowIso());
  const code = String(crypto.randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + PAIR_TTL_MS).toISOString();
  db.prepare('INSERT INTO pair_codes (code, owner_tg_id, expires_at) VALUES (?, ?, ?)').run(code, ownerTgId, expiresAt);
  return { code, expiresAt };
}

function getPair(db, tgId) {
  return (
    db.prepare(
      `SELECT p.partner_tg_id AS tg_id, u.first_name, u.username
       FROM pairs p LEFT JOIN users u ON u.tg_id = p.partner_tg_id
       WHERE p.tg_id = ?`
    ).get(tgId) || null
  );
}

function linkPair(db, tgId, code) {
  const c = String(code || '').trim();
  const inv = db.prepare('SELECT owner_tg_id, expires_at FROM pair_codes WHERE code = ?').get(c);
  if (!inv) return { error: 'Такого кода нет. Попросите партнёра создать новый: /pair' };
  if (inv.expires_at <= nowIso()) {
    db.prepare('DELETE FROM pair_codes WHERE code = ?').run(c);
    return { error: 'Код истёк. Создайте новый: /pair' };
  }
  if (inv.owner_tg_id === tgId) return { error: 'Это ваш собственный код. Отправьте его партнёру.' };
  if (getPair(db, tgId)) return { error: 'Вы уже в паре. Сначала /unpair' };
  if (getPair(db, inv.owner_tg_id)) return { error: 'Партнёр уже в другой паре.' };
  const now = nowIso();
  db.prepare('INSERT INTO pairs (tg_id, partner_tg_id, created_at) VALUES (?, ?, ?)').run(tgId, inv.owner_tg_id, now);
  db.prepare('INSERT INTO pairs (tg_id, partner_tg_id, created_at) VALUES (?, ?, ?)').run(inv.owner_tg_id, tgId, now);
  db.prepare('DELETE FROM pair_codes WHERE code = ?').run(c);
  return { partnerTgId: inv.owner_tg_id };
}

function unpair(db, tgId) {
  const p = getPair(db, tgId);
  if (!p) return false;
  db.prepare('DELETE FROM pairs WHERE tg_id = ? OR tg_id = ?').run(tgId, p.tg_id);
  return true;
}

function sharedMonth(db, tgId, from, to) {
  const partner = getPair(db, tgId);
  if (!partner) return null;
  const mine = sumBetween(db, tgId, from, to);
  const theirs = sumBetween(db, partner.tg_id, from, to);
  const merge = new Map();
  for (const r of totalsByCategory(db, tgId, from, to)) {
    merge.set(r.category, { category: r.category, mine: r.total, theirs: 0, total: r.total });
  }
  for (const r of totalsByCategory(db, partner.tg_id, from, to)) {
    const e = merge.get(r.category) || { category: r.category, mine: 0, theirs: 0, total: 0 };
    e.theirs = r.total;
    e.total = Math.round((e.mine + e.theirs) * 100) / 100;
    merge.set(r.category, e);
  }
  return {
    partner,
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
  openDb,
  ymdInTz,
  addDaysYmd,
  mondayOf,
  monthRangeSafe,
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

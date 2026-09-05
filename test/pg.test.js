'use strict';

// Same scenario against the Postgres store, backed by pg-mem (in-memory
// Postgres emulator). Guarantees the pg SQL matches the sqlite behavior.
const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ALLOW_DEV_AUTH = 'true';

const { newDb } = require('pg-mem');
const pgstore = require('../src/pgstore');
const { createServer } = require('../src/server');

async function bootPg() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  // pgstore.openDb() would create its own pool; here we init schema manually.
  await pool.query(`
    CREATE TABLE users (
      tg_id BIGINT PRIMARY KEY, first_name TEXT, username TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE expenses (
      id SERIAL PRIMARY KEY, tg_id BIGINT NOT NULL,
      amount DOUBLE PRECISION NOT NULL, currency TEXT NOT NULL,
      amount_base DOUBLE PRECISION NOT NULL, base_currency TEXT NOT NULL,
      description TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'other',
      day TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX idx_expenses_user_day ON expenses(tg_id, day);
    CREATE TABLE limits (
      tg_id BIGINT NOT NULL, category TEXT NOT NULL,
      amount_base DOUBLE PRECISION NOT NULL, PRIMARY KEY (tg_id, category)
    );
    CREATE TABLE pairs (
      tg_id BIGINT PRIMARY KEY, partner_tg_id BIGINT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE pair_codes (
      code TEXT PRIMARY KEY, owner_tg_id BIGINT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);
  return pool;
}

test('pgstore: full CRUD + stats + limits + isolation', async () => {
  const pool = await bootPg();
  const tg = 4242;
  await pgstore.upsertUser(pool, { tg_id: tg, first_name: 'Pg', username: 'pg' });

  const e1 = await pgstore.addExpense(pool, tg, {
    amount: 350, currency: 'TJS', amountBase: 350, baseCurrency: 'TJS',
    description: 'Кофе', category: 'cafe', day: '2026-09-05',
  });
  assert.ok(e1.id);
  assert.equal(e1.description, 'Кофе');

  const e2 = await pgstore.addExpense(pool, tg, {
    amount: 12, currency: 'USD', amountBase: 130.8, baseCurrency: 'TJS',
    description: 'Обед', category: 'cafe', day: '2026-09-06',
  });

  const s = await pgstore.sumBetween(pool, tg, '2026-09-01', '2026-09-30');
  assert.equal(s.total, 480.8);
  assert.equal(s.count, 2);

  const byDay = await pgstore.totalsByDay(pool, tg, '2026-09-01', '2026-09-30');
  assert.equal(byDay.length, 2);
  const byCat = await pgstore.totalsByCategory(pool, tg, '2026-09-01', '2026-09-30');
  assert.equal(byCat[0].category, 'cafe');
  assert.equal(Number(byCat[0].total), 480.8);

  const upd = await pgstore.updateExpense(pool, tg, e1.id, { description: 'Кофе большой' });
  assert.equal(upd.description, 'Кофе большой');

  await pgstore.setLimit(pool, tg, 'cafe', 1000);
  assert.equal(await pgstore.getLimit(pool, tg, 'cafe'), 1000);

  // Isolation: another user sees nothing.
  const other = await pgstore.listExpenses(pool, 999, {});
  assert.equal(other.total, 0);
  assert.equal(await pgstore.deleteExpense(pool, 999, e2.id), false);

  assert.equal(await pgstore.deleteExpense(pool, tg, e2.id), true);
  const s2 = await pgstore.sumBetween(pool, tg, '2026-09-01', '2026-09-30');
  assert.equal(s2.count, 1);

  await pgstore.deleteLimit(pool, tg, 'cafe');
  assert.equal(await pgstore.getLimits(pool, tg).then((l) => l.length), 0);
  await pool.end();
});

test('pgstore: shared budget pair flow', async () => {
  const pool = await bootPg();
  const a = 111;
  const b = 222;
  await pgstore.upsertUser(pool, { tg_id: a, first_name: 'A' });
  await pgstore.upsertUser(pool, { tg_id: b, first_name: 'B' });
  assert.equal(await pgstore.getPair(pool, a), null);
  const { code } = await pgstore.createPairCode(pool, a);
  assert.match(code, /^\d{6}$/);
  const bad = await pgstore.linkPair(pool, b, '000000');
  assert.ok(bad.error);
  const ok = await pgstore.linkPair(pool, b, code);
  assert.equal(ok.partnerTgId, a);
  const p = await pgstore.getPair(pool, a);
  assert.equal(p.tg_id, b);
  assert.equal(p.first_name, 'B');
  await pgstore.addExpense(pool, a, {
    amount: 100, currency: 'TJS', amountBase: 100, baseCurrency: 'TJS',
    description: 'X', category: 'food', day: '2026-09-01',
  });
  await pgstore.addExpense(pool, b, {
    amount: 200, currency: 'TJS', amountBase: 200, baseCurrency: 'TJS',
    description: 'Y', category: 'food', day: '2026-09-02',
  });
  const s = await pgstore.sharedMonth(pool, a, '2026-09-01', '2026-09-30');
  assert.equal(s.combined.total, 300);
  assert.equal(s.byCat[0].mine, 100);
  assert.equal(s.byCat[0].theirs, 200);
  assert.equal(await pgstore.unpair(pool, a), true);
  assert.equal(await pgstore.getPair(pool, b), null);
  assert.equal(await pgstore.sharedMonth(pool, a, '2026-09-01', '2026-09-30'), null);
  await pool.end();
});

test('server works on top of pgstore', async () => {
  const pool = await bootPg();
  // createServer only needs the same method names; inject pg-backed shim.
  const dbm = { ...pgstore };
  const app = createServer(pool, dbm);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = await fetch(`${base}/api/auth/dev`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id: 31337 }),
    }).then((r) => r.json()).then((j) => j.token);
    const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const created = await fetch(`${base}/api/expenses`, {
      method: 'POST', headers: h, body: JSON.stringify({ text: 'такси 900' }),
    }).then((r) => { assert.equal(r.status, 201); return r.json(); });
    assert.equal(created.category, 'transport');
    const sum = await fetch(`${base}/api/stats/summary`, { headers: h }).then((r) => r.json());
    assert.ok(sum.month.total >= 900);
  } finally {
    server.close();
    await pool.end();
  }
});

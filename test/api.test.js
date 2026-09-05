'use strict';

// API smoke test: boots the express app with an isolated sqlite file,
// logs in via dev auth, adds an expense with bot-style text, edits,
// checks stats isolation between two users.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.JWT_SECRET = 'test-secret';
process.env.BOT_TOKEN = 'test-token';
process.env.ALLOW_DEV_AUTH = 'true';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'et-test-'));
process.env.BASE_CURRENCY = 'TJS';
process.env.DEFAULT_CURRENCY = 'TJS';
process.env.RATES_JSON = '{"TJS":1,"USD":10.9}';

const { openDb } = require('../src/db');
const { createServer } = require('../src/server');

async function boot() {
  const db = openDb(process.env.DATA_DIR);
  const app = createServer(db);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

async function devLogin(base, tgId) {
  const r = await fetch(`${base}/api/auth/dev`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tg_id: tgId, first_name: 'U' + tgId }),
  }).then((x) => x.json());
  assert.ok(r.token);
  const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${r.token}` };
  const api = (p, opts = {}) => fetch(base + p, { ...opts, headers: { ...h, ...(opts.headers || {}) } });
  return api;
}

test('add/edit/stats + isolation', async () => {
  const { server, base } = await boot();
  try {
    const alice = await devLogin(base, 101);
    const bob = await devLogin(base, 202);

    const created = await alice('/api/expenses', {
      method: 'POST', body: JSON.stringify({ text: 'кофе 350' }),
    }).then((r) => { assert.equal(r.status, 201); return r.json(); });
    assert.equal(created.category, 'cafe');

    const bad = await alice('/api/expenses', {
      method: 'POST', body: JSON.stringify({ text: 'без суммы' }),
    });
    assert.equal(bad.status, 400);

    const sum = await alice('/api/stats/summary').then((r) => r.json());
    assert.ok(sum.month.total >= 350);

    // Bob cannot see Alice's expense.
    const bobList = await bob('/api/expenses').then((r) => r.json());
    assert.equal(bobList.total, 0);
    const bobDel = await bob('/api/expenses/' + created.id, { method: 'DELETE' });
    assert.equal(bobDel.status, 404);

    // Alice edits and deletes.
    const edited = await alice('/api/expenses/' + created.id, {
      method: 'PATCH', body: JSON.stringify({ text: 'кофе 400' }),
    }).then((r) => r.json());
    assert.equal(edited.amount, 400);
    const del = await alice('/api/expenses/' + created.id, { method: 'DELETE' });
    assert.equal(del.status, 200);
  } finally {
    server.close();
  }
});

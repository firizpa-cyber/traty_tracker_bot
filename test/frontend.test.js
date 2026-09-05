'use strict';

// Guards the "HTTP 404 on quick add" class of bugs: every api('...') call in
// the panel must target /api/..., otherwise Express answers 404 (POST/PUT/
// PATCH/DELETE) or serves index.html (GET) and the UI breaks silently.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('all frontend api() calls use the /api/ prefix', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const calls = [...src.matchAll(/api\('([^']*)'/g)].map((m) => m[1]);
  assert.ok(calls.length > 5, 'expected several api() calls');
  const bad = calls.filter((p) => !p.startsWith('/api/'));
  assert.deepEqual(bad, [], `calls without /api/ prefix: ${bad.join(', ')}`);
});

test('server exposes every route the panel uses', async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  process.env.ALLOW_DEV_AUTH = 'true';
  const { openDb } = require('../src/db');
  const { createServer } = require('../src/server');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'et-routes-'));
  const db = openDb(dir);
  const app = createServer(db);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = await fetch(`${base}/api/auth/dev`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id: 999 }),
    }).then((r) => r.json()).then((j) => j.token);
    const h = { Authorization: `Bearer ${token}` };
    for (const [method, url, body] of [
      ['GET', '/api/me'],
      ['GET', '/api/expenses'],
      ['POST', '/api/expenses', { text: 'кофе 350' }],
      ['GET', '/api/stats/summary'],
      ['GET', '/api/stats/by-day'],
      ['GET', '/api/stats/by-category'],
      ['GET', '/api/limits'],
      ['PUT', '/api/limits', { limits: [] }],
    ]) {
      const r = await fetch(base + url, {
        method, headers: { ...h, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      assert.notEqual(r.status, 404, `${method} ${url} is 404`);
    }
  } finally {
    server.close();
  }
});

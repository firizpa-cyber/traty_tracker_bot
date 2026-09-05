'use strict';

// Verifies Telegram auth the same way real clients do:
// craft a signed WebApp initData and Login Widget payload, then verify.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { verifyWebAppInitData, verifyTelegramWidget } = require('../src/auth');

const BOT_TOKEN = 'test-bot-token';

function webAppInitData(user) {
  const params = new URLSearchParams({
    user: JSON.stringify(user),
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAE-test',
  });
  const keys = [...params.keys()].sort();
  const check = keys.map((k) => `${k}=${params.get(k)}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(check).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

test('valid WebApp initData passes', () => {
  const initData = webAppInitData({ id: 777, first_name: 'Mini', username: 'mini' });
  const p = verifyWebAppInitData(initData, BOT_TOKEN);
  assert.ok(p);
  assert.equal(p.tg_id, 777);
});

test('tampered WebApp initData fails', () => {
  const initData = webAppInitData({ id: 777, first_name: 'Mini' }).replace('777', '778');
  assert.equal(verifyWebAppInitData(initData, BOT_TOKEN), null);
});

test('valid Login Widget payload passes', () => {
  const rest = {
    id: '777', first_name: 'Mini', username: 'mini',
    auth_date: String(Math.floor(Date.now() / 1000)),
  };
  const check = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(check).digest('hex');
  const p = verifyTelegramWidget({ ...rest, hash }, BOT_TOKEN);
  assert.ok(p);
  assert.equal(p.tg_id, 777);
});

test('wrong widget hash fails', () => {
  assert.equal(
    verifyTelegramWidget({ id: '1', first_name: 'X', auth_date: '1', hash: 'nope' }, BOT_TOKEN),
    null
  );
});

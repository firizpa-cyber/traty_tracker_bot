'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseExpense } = require('../src/parse');

const OPTS = { defaultCurrency: 'TJS', baseCurrency: 'TJS', rates: { TJS: 1, USD: 10.9, EUR: 11.8, RUB: 0.12 } };

test('кофе 350: amount at end', () => {
  const p = parseExpense('кофе 350', OPTS);
  assert.equal(p.ok, true);
  assert.equal(p.amount, 350);
  assert.equal(p.currency, 'TJS');
  assert.equal(p.category, 'cafe');
});

test('такси 900 работа: explicit category word wins', () => {
  const p = parseExpense('такси 900 работа', OPTS);
  assert.equal(p.ok, true);
  assert.equal(p.amount, 900);
  assert.equal(p.category, 'work');
});

test('amount first: 350 кофе', () => {
  const p = parseExpense('350 кофе', OPTS);
  assert.equal(p.ok, true);
  assert.equal(p.amount, 350);
  assert.equal(p.category, 'cafe');
});

test('$12 lunch: currency symbol before', () => {
  const p = parseExpense('$12 lunch', OPTS);
  assert.equal(p.ok, true);
  assert.equal(p.amount, 12);
  assert.equal(p.currency, 'USD');
  assert.equal(p.amountBase, 130.8);
});

test('обед 450р: glued ruble letter', () => {
  const p = parseExpense('обед 450р', OPTS);
  assert.equal(p.ok, true);
  assert.equal(p.currency, 'RUB');
});

test('thousand separators: 1 200 магазин', () => {
  const p = parseExpense('1 200 магазин', OPTS);
  assert.equal(p.ok, true);
  assert.equal(p.amount, 1200);
});

test('no amount fails with hint', () => {
  const p = parseExpense('просто текст', OPTS);
  assert.equal(p.ok, false);
});

test('unknown currency word stays description', () => {
  const p = parseExpense('кофе 350 работа', OPTS);
  assert.equal(p.ok, true);
  assert.equal(p.category, 'work');
});

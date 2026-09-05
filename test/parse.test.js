'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseExpense, extractAmount, splitExpenseParts, cleanDescription, parseReceiptTotal } = require('../src/parse');

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

test('потратил 500 на такси: filler words cleaned', () => {
  const p = parseExpense('потратил 500 на такси', OPTS);
  assert.equal(p.ok, true);
  assert.equal(p.amount, 500);
  assert.equal(p.category, 'transport');
  assert.match(p.description, /Такси/);
  assert.doesNotMatch(p.description, /потратил/i);
});

test('extractAmount for dialog step', () => {
  const a = extractAmount('около 1200', OPTS);
  assert.equal(a.ok, true);
  assert.equal(a.amount, 1200);
  assert.equal(extractAmount('без цифр', OPTS).ok, false);
});

test('splitExpenseParts: two at once', () => {
  assert.deepEqual(splitExpenseParts('кофе 350 и такси 900'), ['кофе 350', 'такси 900']);
  assert.deepEqual(splitExpenseParts('кофе 350, такси 900'), ['кофе 350', 'такси 900']);
  assert.equal(splitExpenseParts('2 кофе 350'), null);
  assert.equal(splitExpenseParts('кофе 350'), null);
});

test('cleanDescription strips fillers and prepositions', () => {
  assert.equal(cleanDescription('потратил на такси'), 'такси');
  assert.equal(cleanDescription('заплатил за обед'), 'обед');
});

test('receipt total: итого line wins', () => {
  const p = parseReceiptTotal('Магазин\nХлеб 120\nМолоко 200\nИТОГО 1 250\nОплата картой', OPTS);
  assert.equal(p.ok, true);
  assert.equal(p.amount, 1250);
});

test('receipt total: hinted small beats unhinted big', () => {
  const p = parseReceiptTotal('TOTAL: $12.50\nCASH 50.00', OPTS);
  assert.equal(p.ok, true);
  assert.equal(p.amount, 12.5);
  assert.equal(p.currency, 'USD');
});

test('receipt total: falls back to max amount', () => {
  const p = parseReceiptTotal('120\n340\n25', OPTS);
  assert.equal(p.ok, true);
  assert.equal(p.amount, 340);
});

test('receipt total: garbage fails', () => {
  assert.equal(parseReceiptTotal('нет цифр тут', OPTS).ok, false);
});

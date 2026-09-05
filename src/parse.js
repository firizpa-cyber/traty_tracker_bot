'use strict';

const { detectCategory } = require('./categories');

// Currency tokens: symbol/word -> ISO code. Order matters (longer first).
// Note: single "р" / "с" are only treated as currency when glued to the
// number ("450р"), otherwise they are just letters of the description.
const CURRENCY_WORDS = [
  [/сомони|сомон/i, 'TJS'],
  [/смн/i, 'TJS'],
  [/tjs|tjsom/i, 'TJS'],
  [/руб|рублей|рубля/i, 'RUB'],
  [/\brub\b/i, 'RUB'],
  [/\busd\b/i, 'USD'],
  [/\beur\b/i, 'EUR'],
  [/€/, 'EUR'],
  [/\$/, 'USD'],
  [/₽/, 'RUB'],
];

function detectCurrencyAround(text, numStart, numEnd) {
  const before = text.slice(Math.max(0, numStart - 8), numStart);
  const after = text.slice(numEnd, numEnd + 10);
  const gluedAfter = text.slice(numEnd, numEnd + 4);
  for (const [re, code] of CURRENCY_WORDS) {
    if (re.test(after) || re.test(before)) return code;
  }
  // Glued single letters: "450р", "900с"? "с" is too ambiguous, skip it.
  if (/^[рp]\b/i.test(gluedAfter) || /^[рp]$/i.test(gluedAfter.trim())) return 'RUB';
  return null;
}

// Find all numbers like 1 000, 12.50, 12,50, 350.
function findNumbers(text) {
  const re = /(\d[\d \u00a0']*\d|\d)([.,]\d+)?/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    // Skip numbers that are part of words like "covid19"? Keep simple: require
    // boundaries (space/start/end or currency symbol).
    out.push({ raw: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function parseNumberSafe(raw) {
  const cleaned = String(raw).replace(/[\s\u00a0']/g, '').replace(',', '.');
  const v = Number(cleaned);
  return Number.isFinite(v) ? v : NaN;
}

function stripRange(text, start, end, extraChars = 0) {
  // Remove number + adjacent currency word to get a clean description.
  let s = text.slice(0, start) + ' ' + text.slice(end);
  // Remove one adjacent currency token (word form) left after number removal.
  s = s.replace(/сомони|сомон|смн|рублей|рубля|руб\.?|\b(rub|usd|eur|tjs)\b|[$€₽]/gi, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // Remove stray leading/trailing prepositions left by removal: keep simple.
  return s.replace(/^[-–—:;,.]+|[-–—:;,.]+$/g, '').trim();
}

function title1(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Parse one expense message.
 * @param {string} text e.g. "кофе 350", "такси 900 работа", "$12 lunch"
 * @param {{defaultCurrency?:string, baseCurrency?:string, rates?:Record<string,number>}} opts
 * @returns {{ok:boolean, error?:string, amount?:number, currency?:string,
 *   amountBase?:number, baseCurrency?:string, description?:string, category?:string}}
 */
function parseExpense(text, opts = {}) {
  const defaultCurrency = (opts.defaultCurrency || 'TJS').toUpperCase();
  const baseCurrency = (opts.baseCurrency || defaultCurrency).toUpperCase();
  const rates = opts.rates || {};
  const input = String(text || '').replace(/\s+/g, ' ').trim();
  if (!input || input.startsWith('/')) {
    return { ok: false, error: 'Похоже на команду. Напишите сумму и описание, например: кофе 350' };
  }
  const nums = findNumbers(input);
  if (nums.length === 0) {
    return { ok: false, error: 'Не вижу сумму. Например: кофе 350' };
  }
  // Prefer a number with an explicit currency marker, else the LAST number
  // ("2 кофе 350" -> 350, not 2).
  let chosen = null;
  let chosenCurrency = null;
  for (const n of nums) {
    const c = detectCurrencyAround(input, n.start, n.end);
    if (c) { chosen = n; chosenCurrency = c; }
  }
  if (!chosen) chosen = nums[nums.length - 1];
  const amount = parseNumberSafe(chosen.raw);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) {
    return { ok: false, error: 'Сумма выглядит странно. Например: кофе 350' };
  }
  const currency = (chosenCurrency || defaultCurrency).toUpperCase();
  const rate = Number(rates[currency] ?? (currency === baseCurrency ? 1 : NaN));
  if (!Number.isFinite(rate)) {
    return { ok: false, error: `Не знаю курс ${currency}. Проверьте RATES_JSON.` };
  }
  const amountBase = Math.round(amount * rate * 100) / 100;
  let description = stripRange(input, chosen.start, chosen.end);
  const category = detectCategory(description || input);
  if (!description) description = require('./categories').getCategory(category).label;
  description = title1(description).slice(0, 200);
  return { ok: true, amount, currency, amountBase, baseCurrency, description, category };
}

function formatMoney(amount, currency) {
  const n = Number(amount);
  const str = Number.isInteger(n)
    ? n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
    : n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${str} ${currency}`;
}

module.exports = { parseExpense, formatMoney };

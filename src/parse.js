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

// Filler words people naturally type: "потратил 500 на такси".
// Stripped from the start of the description so cards look clean.
const FILLERS = [
  'потратил', 'потратила', 'потрачено', 'заплатил', 'заплатила', 'оплатил', 'оплатила',
  'отдал', 'отдала', 'купил', 'купила', 'взял', 'взяла', 'вышло', 'вышла',
  'стоило', 'стоил', 'стоила', 'стоит', 'цена', 'сумма', 'всего', 'итого', 'чек', 'покупка',
];
// NB: \b doesn't see Cyrillic as word chars, so boundaries use explicit lookahead.
const WORD_END = '(?=[\\s,.!?;:\\-—()"]|$)';
const FILLER_RE = new RegExp(`^(?:${FILLERS.join('|')})${WORD_END}`, 'i');
const LEAD_PREP = /^(на|за|в|во|по|для|от|с|со|к)(?=[\s,.!?;:\-—()"]|$)/i;

function cleanDescription(s) {
  let t = String(s || '').replace(/\s+/g, ' ').trim();
  let prev;
  do {
    prev = t;
    t = t.replace(FILLER_RE, '').replace(LEAD_PREP, '').replace(/^[-–—:;,.]+/, '').trim();
  } while (t !== prev);
  return t;
}

function detectCurrencyAround(text, numStart, numEnd) {
  const before = text.slice(Math.max(0, numStart - 8), numStart);
  const after = text.slice(numEnd, numEnd + 10);
  const gluedAfter = text.slice(numEnd, numEnd + 4);
  for (const [re, code] of CURRENCY_WORDS) {
    if (re.test(after) || re.test(before)) return code;
  }
  // Glued single letters: "450р". "с" is too ambiguous, skip it.
  if (/^[рp]\b/i.test(gluedAfter) || /^[рp]$/i.test(gluedAfter.trim())) return 'RUB';
  return null;
}

// Find all numbers like 1 000, 12.50, 12,50, 350.
function findNumbers(text) {
  const re = /(\d[\d \u00a0']*\d|\d)([.,]\d+)?/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ raw: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function parseNumberSafe(raw) {
  const cleaned = String(raw).replace(/[\s\u00a0']/g, '').replace(',', '.');
  const v = Number(cleaned);
  return Number.isFinite(v) ? v : NaN;
}

function stripRange(text, start, end) {
  // Remove number + adjacent currency word to get a clean description.
  let s = text.slice(0, start) + ' ' + text.slice(end);
  // Remove one adjacent currency token (word form) left after number removal.
  s = s.replace(/сомони|сомон|смн|рублей|рубля|руб\.?|\b(rub|usd|eur|tjs)\b|[$€₽]/gi, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s.replace(/^[-–—:;,.]+|[-–—:;,.]+$/g, '').trim();
}

function title1(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function normOpts(opts = {}) {
  const defaultCurrency = (opts.defaultCurrency || 'TJS').toUpperCase();
  const baseCurrency = (opts.baseCurrency || defaultCurrency).toUpperCase();
  const rates = opts.rates || {};
  return { defaultCurrency, baseCurrency, rates };
}

/**
 * Extract just the money part from free text. Used by the step-by-step
 * dialog ("Сколько потратили?") where description comes separately.
 */
function extractAmount(text, opts = {}) {
  const { defaultCurrency, baseCurrency, rates } = normOpts(opts);
  const input = String(text || '').replace(/\s+/g, ' ').trim();
  if (!input) return { ok: false, error: 'Напишите сумму, например: 350' };
  const nums = findNumbers(input);
  if (nums.length === 0) return { ok: false, error: 'Не вижу сумму. Например: 350' };
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
    return { ok: false, error: 'Сумма выглядит странно. Например: 350' };
  }
  const currency = (chosenCurrency || defaultCurrency).toUpperCase();
  const rate = Number(rates[currency] ?? (currency === baseCurrency ? 1 : NaN));
  if (!Number.isFinite(rate)) {
    return { ok: false, error: `Не знаю курс ${currency}. Проверьте RATES_JSON.` };
  }
  return {
    ok: true,
    amount,
    currency,
    amountBase: Math.round(amount * rate * 100) / 100,
    baseCurrency,
    start: chosen.start,
    end: chosen.end,
  };
}

/**
 * Parse one expense message.
 * e.g. "кофе 350", "такси 900 работа", "$12 lunch", "потратил 500 на такси"
 */
function parseExpense(text, opts = {}) {
  const input = String(text || '').replace(/\s+/g, ' ').trim();
  if (!input || input.startsWith('/')) {
    return { ok: false, error: 'Похоже на команду. Напишите сумму и описание, например: кофе 350' };
  }
  const a = extractAmount(input, opts);
  if (!a.ok) {
    return input.match(/\d/)
      ? { ok: false, error: a.error }
      : { ok: false, error: 'Не вижу сумму. Например: кофе 350' };
  }
  let description = cleanDescription(stripRange(input, a.start, a.end));
  const category = detectCategory(description || input);
  if (!description) description = require('./categories').getCategory(category).label;
  description = title1(description).slice(0, 200);
  return {
    ok: true,
    amount: a.amount,
    currency: a.currency,
    amountBase: a.amountBase,
    baseCurrency: a.baseCurrency,
    description,
    category,
  };
}

/**
 * Split "кофе 350 и такси 900" / "кофе 350, такси 900" into parts.
 * Returns null when it's a single expense ("2 кофе 350" has no separator).
 */function splitExpenseParts(text) {
  const parts = String(text || '')
    .split(/\s*(?:[;,]|[+×]|\n)\s*|\s+(?:и|а|плюс|еще|ещё)\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2 || parts.length > 5) return null;
  if (!parts.every((p) => /\d/.test(p))) return null;
  return parts;
}

// Receipt OCR: find the payable total in noisy recognized text.
// Prefers lines marked итого/total/к оплате, otherwise the largest amount.
const TOTAL_HINTS = [/итог/i, /total/i, /к оплате/i, /коплате/i, /сумм/i, /оплат/i, /sale/i];

function parseReceiptTotal(text, opts = {}) {
  const { defaultCurrency, baseCurrency, rates } = normOpts(opts);
  const lines = String(text || '').split(/[\n;]+/).map((s) => s.trim()).filter(Boolean);
  const cands = [];
  for (const line of lines) {
    // Skip change/credit lines that look like big numbers but aren't the total.
    if (/сдач|return|остаток/i.test(line)) continue;
    for (const n of findNumbers(line)) {
      const amount = parseNumberSafe(n.raw);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) continue;
      cands.push({
        amount,
        currency: detectCurrencyAround(line, n.start, n.end),
        hinted: TOTAL_HINTS.some((re) => re.test(line)),
      });
    }
  }
  if (cands.length === 0) return { ok: false, error: 'Не нашёл сумму в чеке' };
  cands.sort((a, b) => Number(b.hinted) - Number(a.hinted) || b.amount - a.amount);
  const best = cands[0];
  const currency = (best.currency || defaultCurrency).toUpperCase();
  const rate = Number(rates[currency] ?? (currency === baseCurrency ? 1 : NaN));
  if (!Number.isFinite(rate)) return { ok: false, error: `Не знаю курс ${currency}` };
  const description = 'Чек';
  return {
    ok: true,
    amount: best.amount,
    currency,
    amountBase: Math.round(best.amount * rate * 100) / 100,
    baseCurrency,
    description,
    category: detectCategory(String(text || '')),
  };
}

function formatMoney(amount, currency) {
  const n = Number(amount);
  const str = Number.isInteger(n)
    ? n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
    : n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${str} ${currency}`;
}

module.exports = { parseExpense, extractAmount, splitExpenseParts, cleanDescription, parseReceiptTotal, formatMoney };

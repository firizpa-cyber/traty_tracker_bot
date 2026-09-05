'use strict';

const express = require('express');
const path = require('path');
const cors = require('cors');
const dbm = require('./db');
const { parseExpense, formatMoney } = require('./parse');
const { getCategory, CATEGORIES } = require('./categories');
const { signToken, authMiddleware, verifyTelegramWidget, verifyWebAppInitData } = require('./auth');

function ratesCfg() {
  const baseCurrency = (process.env.BASE_CURRENCY || process.env.DEFAULT_CURRENCY || 'TJS').toUpperCase();
  const defaultCurrency = (process.env.DEFAULT_CURRENCY || baseCurrency).toUpperCase();
  let rates = {};
  try { rates = JSON.parse(process.env.RATES_JSON || '{}'); } catch (_) { rates = {}; }
  if (!(baseCurrency in rates)) rates[baseCurrency] = 1;
  if (!(defaultCurrency in rates)) rates[defaultCurrency] = 1;
  return { baseCurrency, defaultCurrency, rates };
}

function toApi(e) {
  return {
    id: e.id,
    amount: e.amount,
    currency: e.currency,
    amountBase: e.amount_base,
    baseCurrency: e.base_currency,
    description: e.description,
    category: e.category,
    categoryLabel: getCategory(e.category).label,
    day: e.day,
    createdAt: e.created_at,
  };
}

function createServer(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.get('/api/config', (req, res) => {
    const { baseCurrency, defaultCurrency } = ratesCfg();
    res.json({
      baseCurrency,
      defaultCurrency,
      categories: CATEGORIES.map((c) => ({ id: c.id, label: c.label, emoji: c.emoji })),
      botUsername: process.env.BOT_USERNAME || null,
    });
  });

  // --- Auth: Telegram Login Widget / WebApp / dev ---
  app.post('/api/auth/telegram', (req, res) => {
    const profile = verifyTelegramWidget(req.body || {}, process.env.BOT_TOKEN || '');
    if (!profile) return res.status(401).json({ error: 'bad telegram signature' });
    dbm.upsertUser(db, profile);
    const token = signToken(profile);
    res.json({ token, profile });
  });

  app.post('/api/auth/webapp', (req, res) => {
    const profile = verifyWebAppInitData(req.body.initData || '', process.env.BOT_TOKEN || '');
    if (!profile) return res.status(401).json({ error: 'bad initData' });
    dbm.upsertUser(db, profile);
    const token = signToken(profile);
    res.json({ token, profile });
  });

  // Dev-only login without Telegram (local testing). Disabled by default.
  app.post('/api/auth/dev', (req, res) => {
    if (process.env.ALLOW_DEV_AUTH !== 'true') return res.status(403).json({ error: 'dev auth disabled' });
    const tgId = Number(req.body.tg_id || 1);
    const profile = { tg_id: tgId, first_name: req.body.first_name || 'Dev', username: 'dev' };
    dbm.upsertUser(db, profile);
    res.json({ token: signToken(profile), profile });
  });

  const api = express.Router();
  api.use(authMiddleware);

  api.get('/me', (req, res) => res.json({ profile: req.user }));

  api.get('/categories', (req, res) => {
    res.json({ categories: CATEGORIES.map((c) => ({ id: c.id, label: c.label, emoji: c.emoji })) });
  });

  api.get('/expenses', (req, res) => {
    const { rows, total } = dbm.listExpenses(db, req.user.tg_id, {
      from: req.query.from,
      to: req.query.to,
      category: req.query.category,
      q: req.query.q,
      limit: Number(req.query.limit || 50),
      offset: Number(req.query.offset || 0),
    });
    res.json({ items: rows.map(toApi), total });
  });

  // Quick add with the same one-line parser as the bot ("РєРѕС„Рµ 350").
  api.post('/expenses', (req, res) => {
    const { defaultCurrency, baseCurrency, rates } = ratesCfg();
    if (typeof req.body.text === 'string' && !('amount' in req.body)) {
      const p = parseExpense(req.body.text, { defaultCurrency, baseCurrency, rates });
      if (!p.ok) return res.status(400).json({ error: p.error });
      const saved = dbm.addExpense(db, req.user.tg_id, {
        amount: p.amount, currency: p.currency, amountBase: p.amountBase,
        baseCurrency: p.baseCurrency, description: p.description, category: p.category,
        day: req.body.day,
      });
      return res.status(201).json(toApi(saved));
    }
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount > 0 required' });
    const currency = String(req.body.currency || defaultCurrency).toUpperCase();
    const rate = Number(rates[currency] ?? (currency === baseCurrency ? 1 : NaN));
    if (!Number.isFinite(rate)) return res.status(400).json({ error: `unknown currency ${currency}` });
    const description = String(req.body.description || '').slice(0, 200) || getCategory(req.body.category).label;
    const saved = dbm.addExpense(db, req.user.tg_id, {
      amount,
      currency,
      amountBase: Math.round(amount * rate * 100) / 100,
      baseCurrency,
      description,
      category: req.body.category || 'other',
      day: req.body.day,
    });
    res.status(201).json(toApi(saved));
  });

  api.patch('/expenses/:id', (req, res) => {
    const id = Number(req.params.id);
    const cur = dbm.getExpense(db, req.user.tg_id, id);
    if (!cur) return res.status(404).json({ error: 'not found' });
    const patch = {};
    if (req.body.text && !('amount' in req.body)) {
      const { defaultCurrency, baseCurrency, rates } = ratesCfg();
      const p = parseExpense(req.body.text, { defaultCurrency, baseCurrency, rates });
      if (!p.ok) return res.status(400).json({ error: p.error });
      patch.amount = p.amount; patch.currency = p.currency;
      patch.amount_base = p.amountBase; patch.base_currency = p.baseCurrency;
      patch.description = p.description; patch.category = p.category;
    } else {
      if (req.body.amount !== undefined) {
        const amount = Number(req.body.amount);
        if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'bad amount' });
        patch.amount = amount;
        const { baseCurrency, rates } = ratesCfg();
        const currency = (req.body.currency || cur.currency).toUpperCase();
        patch.currency = currency;
        patch.amount_base = Math.round(amount * (rates[currency] ?? 1) * 100) / 100;
        patch.base_currency = baseCurrency;
      }
      if (req.body.description !== undefined) patch.description = String(req.body.description).slice(0, 200);
      if (req.body.category !== undefined) patch.category = req.body.category;
      if (req.body.day !== undefined) patch.day = req.body.day;
    }
    res.json(toApi(dbm.updateExpense(db, req.user.tg_id, id, patch)));
  });

  api.delete('/expenses/:id', (req, res) => {
    const ok = dbm.deleteExpense(db, req.user.tg_id, Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  api.get('/stats/summary', (req, res) => {
    const { baseCurrency } = ratesCfg();
    const today = dbm.ymdInTz();
    const month = String(req.query.month || today.slice(0, 7));
    const { from: mf, to: mt } = dbm.monthRangeSafe(month);
    const mon = dbm.mondayOf(today);
    const t = dbm.sumBetween(db, req.user.tg_id, today, today);
    const w = dbm.sumBetween(db, req.user.tg_id, mon, today);
    const m = dbm.sumBetween(db, req.user.tg_id, mf, mt);
    res.json({ baseCurrency, today: t, week: { ...w, from: mon, to: today }, month: { ...m, from: mf, to: mt, month } });
  });

  api.get('/stats/by-day', (req, res) => {
    const today = dbm.ymdInTz();
    const month = String(req.query.month || today.slice(0, 7));
    const { from, to } = dbm.monthRangeSafe(month);
    res.json({ month, from, to, days: dbm.totalsByDay(db, req.user.tg_id, from, to) });
  });

  api.get('/stats/by-category', (req, res) => {
    const today = dbm.ymdInTz();
    let { from, to } = req.query;
    if (!from || !to) {
      const month = String(req.query.month || today.slice(0, 7));
      ({ from, to } = dbm.monthRangeSafe(month));
    }
    const rows = dbm.totalsByCategory(db, req.user.tg_id, from, to).map((r) => ({
      ...r,
      label: getCategory(r.category).label,
      emoji: getCategory(r.category).emoji,
    }));
    res.json({ from, to, categories: rows });
  });

  api.get('/limits', (req, res) => {
    const { baseCurrency } = ratesCfg();
    res.json({ baseCurrency, limits: dbm.getLimits(db, req.user.tg_id) });
  });

  api.put('/limits', (req, res) => {
    const items = req.body.limits || [];
    for (const l of items) {
      if (l.amount == null) dbm.deleteLimit(db, req.user.tg_id, l.category);
      else dbm.setLimit(db, req.user.tg_id, l.category, Number(l.amount));
    }
    res.json({ ok: true, limits: dbm.getLimits(db, req.user.tg_id) });
  });

  api.get('/export.csv', (req, res) => {
    const { rows } = dbm.listExpenses(db, req.user.tg_id, {
      from: req.query.from, to: req.query.to, category: req.query.category, limit: 5000,
    });
    const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const lines = ['id,date,description,category,amount,currency,amount_base,base_currency'];
    for (const r of [...rows].reverse()) {
      lines.push([r.id, r.day, esc(r.description), r.category, r.amount, r.currency, r.amount_base, r.base_currency].join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="expenses.csv"');
    res.send("\uFEFF" + lines.join("\n"));
  });

  app.use('/api', api);

  // Static panel.
  const pub = path.join(__dirname, '..', 'public');
  app.use(express.static(pub));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/tg-webhook')) return next();
    res.sendFile(path.join(pub, 'index.html'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

module.exports = { createServer, formatMoney };

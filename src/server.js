'use strict';

const express = require('express');
const path = require('path');
const cors = require('cors');
const defaultStore = require('./store');
const { parseExpense, formatMoney } = require('./parse');
const { getCategory, CATEGORIES } = require('./categories');
const { signToken, authMiddleware, verifyTelegramWidget, verifyWebAppInitData } = require('./auth');
const sheets = require('./sheets');

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
    amount: Number(e.amount),
    currency: e.currency,
    amountBase: Number(e.amount_base),
    baseCurrency: e.base_currency,
    description: e.description,
    category: e.category,
    categoryLabel: getCategory(e.category).label,
    day: e.day,
    createdAt: e.created_at,
  };
}

function createServer(db, store) {
  const dbm = store || defaultStore;
  const app = express();
  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', (req, res) => res.json({ ok: true, store: process.env.DATABASE_URL ? 'postgres' : 'sqlite' }));

  app.get('/api/config', (req, res) => {
    const { baseCurrency, defaultCurrency } = ratesCfg();
    res.json({
      baseCurrency,
      defaultCurrency,
      categories: CATEGORIES.map((c) => ({ id: c.id, label: c.label, emoji: c.emoji })),
      botUsername: process.env.BOT_USERNAME || null,
      sheetsEnabled: sheets.isConfigured(),
    });
  });

  // --- Auth: Telegram Login Widget / WebApp / dev ---
  app.post('/api/auth/telegram', async (req, res) => {
    const profile = verifyTelegramWidget(req.body || {}, process.env.BOT_TOKEN || '');
    if (!profile) return res.status(401).json({ error: 'bad telegram signature' });
    await dbm.upsertUser(db, profile);
    const token = signToken(profile);
    res.json({ token, profile });
  });

  app.post('/api/auth/webapp', async (req, res) => {
    const profile = verifyWebAppInitData(req.body.initData || '', process.env.BOT_TOKEN || '');
    if (!profile) return res.status(401).json({ error: 'bad initData' });
    await dbm.upsertUser(db, profile);
    const token = signToken(profile);
    res.json({ token, profile });
  });

  // Dev-only login without Telegram (local testing). Disabled by default.
  app.post('/api/auth/dev', async (req, res) => {
    if (process.env.ALLOW_DEV_AUTH !== 'true') return res.status(403).json({ error: 'dev auth disabled' });
    const tgId = Number(req.body.tg_id || 1);
    const profile = { tg_id: tgId, first_name: req.body.first_name || 'Dev', username: 'dev' };
    await dbm.upsertUser(db, profile);
    res.json({ token: signToken(profile), profile });
  });

  const api = express.Router();
  api.use(authMiddleware);

  api.get('/me', (req, res) => res.json({ profile: req.user }));

  api.get('/categories', (req, res) => {
    res.json({ categories: CATEGORIES.map((c) => ({ id: c.id, label: c.label, emoji: c.emoji })) });
  });

  api.get('/expenses', async (req, res) => {
    const { rows, total } = await dbm.listExpenses(db, req.user.tg_id, {
      from: req.query.from,
      to: req.query.to,
      category: req.query.category,
      q: req.query.q,
      limit: Number(req.query.limit || 50),
      offset: Number(req.query.offset || 0),
    });
    res.json({ items: rows.map(toApi), total });
  });

  // Quick add with the same one-line parser as the bot ("кофе 350").
  api.post('/expenses', async (req, res) => {
    const { defaultCurrency, baseCurrency, rates } = ratesCfg();
    if (typeof req.body.text === 'string' && !('amount' in req.body)) {
      const p = parseExpense(req.body.text, { defaultCurrency, baseCurrency, rates });
      if (!p.ok) return res.status(400).json({ error: p.error });
      const saved = await dbm.addExpense(db, req.user.tg_id, {
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
    const saved = await dbm.addExpense(db, req.user.tg_id, {
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

  api.patch('/expenses/:id', async (req, res) => {
    const id = Number(req.params.id);
    const cur = await dbm.getExpense(db, req.user.tg_id, id);
    if (!cur) return res.status(404).json({ error: 'not found' });
    const patch = {};
    if (req.body.text && !('amount' in req.body)) {
      const { defaultCurrency, baseCurrency, rates } = ratesCfg();
      const p = parseExpense(req.body.text, { defaultCurrency, baseCurrency, rates });
      if (!p.ok) return res.status(400).json({ error: p.error });
      patch.amount = p.amount; patch.currency = p.currency;
      patch.amount_base = p.amountBase; patch.base_currency = p.baseCurrency;
      patch.description = p.description;
      // Explicitly chosen category/date win over the re-parsed text.
      patch.category = req.body.category || p.category;
      if (req.body.day) patch.day = req.body.day;
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
    res.json(toApi(await dbm.updateExpense(db, req.user.tg_id, id, patch)));
  });

  api.delete('/expenses/:id', async (req, res) => {
    const ok = await dbm.deleteExpense(db, req.user.tg_id, Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  api.get('/stats/summary', async (req, res) => {
    const { baseCurrency } = ratesCfg();
    const today = dbm.ymdInTz();
    const month = String(req.query.month || today.slice(0, 7));
    const { from: mf, to: mt } = dbm.monthRangeSafe(month);
    const mon = dbm.mondayOf(today);
    const t = await dbm.sumBetween(db, req.user.tg_id, today, today);
    const w = await dbm.sumBetween(db, req.user.tg_id, mon, today);
    const m = await dbm.sumBetween(db, req.user.tg_id, mf, mt);
    res.json({ baseCurrency, today: t, week: { ...w, from: mon, to: today }, month: { ...m, from: mf, to: mt, month } });
  });

  api.get('/stats/by-day', async (req, res) => {
    const today = dbm.ymdInTz();
    const month = String(req.query.month || today.slice(0, 7));
    const { from, to } = dbm.monthRangeSafe(month);
    res.json({ month, from, to, days: await dbm.totalsByDay(db, req.user.tg_id, from, to) });
  });

  api.get('/stats/by-category', async (req, res) => {
    const today = dbm.ymdInTz();
    let { from, to } = req.query;
    if (!from || !to) {
      const month = String(req.query.month || today.slice(0, 7));
      ({ from, to } = dbm.monthRangeSafe(month));
    }
    const rows = (await dbm.totalsByCategory(db, req.user.tg_id, from, to)).map((r) => ({
      category: r.category,
      total: Number(r.total),
      count: Number(r.cnt ?? r.count ?? 0),
      label: getCategory(r.category).label,
      emoji: getCategory(r.category).emoji,
    }));
    res.json({ from, to, categories: rows });
  });

  api.get('/limits', async (req, res) => {
    const { baseCurrency } = ratesCfg();
    res.json({ baseCurrency, limits: await dbm.getLimits(db, req.user.tg_id) });
  });
  api.put('/limits', async (req, res) => {
    const items = req.body.limits || [];
    for (const l of items) {
      if (l.amount == null || l.amount === '') await dbm.deleteLimit(db, req.user.tg_id, l.category);
      else await dbm.setLimit(db, req.user.tg_id, l.category, Number(l.amount));
    }
    res.json({ ok: true, limits: await dbm.getLimits(db, req.user.tg_id) });
  });

  // --- Shared budget for two ---
  api.get('/pair', async (req, res) => {
    const partner = await dbm.getPair(db, req.user.tg_id);
    res.json({ paired: !!partner, partner: partner || null });
  });

  api.post('/pair', async (req, res) => {
    await dbm.upsertUser(db, req.user);
    if (req.body.action === 'link') {
      const r = await dbm.linkPair(db, req.user.tg_id, req.body.code);
      if (r.error) return res.status(400).json({ error: r.error });
      const partner = await dbm.getPair(db, req.user.tg_id);
      return res.json({ ok: true, partner });
    }
    const { code, expiresAt } = await dbm.createPairCode(db, req.user.tg_id);
    res.json({ ok: true, code, expiresAt });
  });

  api.delete('/pair', async (req, res) => {
    res.json({ ok: await dbm.unpair(db, req.user.tg_id) });
  });

  api.get('/stats/shared', async (req, res) => {
    const { baseCurrency } = ratesCfg();
    const today = dbm.ymdInTz();
    const month = String(req.query.month || today.slice(0, 7));
    const { from, to } = dbm.monthRangeSafe(month);
    const s = await dbm.sharedMonth(db, req.user.tg_id, from, to);
    if (!s) return res.json({ paired: false });
    res.json({
      paired: true, baseCurrency, month, from, to,
      partner: s.partner, mine: s.mine, theirs: s.theirs, combined: s.combined,
      byCat: s.byCat.map((c) => ({
        ...c, label: getCategory(c.category).label, emoji: getCategory(c.category).emoji,
      })),
    });
  });

  api.get('/export.csv', async (req, res) => {
    const { rows } = await dbm.listExpenses(db, req.user.tg_id, {
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

  // Google Sheets выписка: appends the selected period into the sheet.
  api.post('/export/sheets', async (req, res) => {
    if (!sheets.isConfigured()) return res.status(501).json({ error: 'Google Sheets not configured on server' });
    try {
      const { rows } = await dbm.listExpenses(db, req.user.tg_id, {
        from: req.body.from, to: req.body.to, category: req.body.category, limit: 5000,
      });
      if (rows.length === 0) return res.status(400).json({ error: 'nothing to export' });
      const r = await sheets.appendExpenses(rows);
      res.json({ ok: true, ...r });
    } catch (e) {
      console.error('sheets export failed:', e.message);
      res.status(500).json({ error: 'sheets export failed' });
    }
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

'use strict';

const { Telegraf, Markup } = require('telegraf');
const { parseExpense, formatMoney } = require('./parse');
const { getCategory, CATEGORIES } = require('./categories');
const dbm = require('./db');
const { signToken } = require('./auth');

function cfg() {
  const baseCurrency = (process.env.BASE_CURRENCY || process.env.DEFAULT_CURRENCY || 'TJS').toUpperCase();
  const defaultCurrency = (process.env.DEFAULT_CURRENCY || baseCurrency).toUpperCase();
  let rates = {};
  try { rates = JSON.parse(process.env.RATES_JSON || '{}'); } catch (_) { rates = {}; }
  for (const k of [baseCurrency, defaultCurrency]) if (!(k in rates)) rates[k] = 1;
  return {
    baseCurrency,
    defaultCurrency,
    rates,
    publicUrl: (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, ''),
    ocrMode: process.env.OCR_MODE || 'caption',
  };
}

function loginLink(tgId, firstName, username) {
  const { publicUrl } = cfg();
  const token = signToken({ tg_id: tgId, first_name: firstName, username }, '30d');
  return `${publicUrl}/?token=${token}`;
}

function mainKeyboard() {
  return Markup.keyboard([
    ['📊 Сегодня', '📈 Неделя'],
    ['🗓 Месяц', '🧾 Последние'],
    ['🌐 Панель', '⚙️ Лимиты'],
  ]).resize().persistent();
}

function expenseLine(e) {
  const c = getCategory(e.category);
  return `#${e.id} ${c.emoji} ${e.description} — ${formatMoney(e.amount, e.currency)} · ${c.label} · ${e.day}`;
}

function helpText() {
  return [
    'Пишите трату одним сообщением:',
    '• кофе 350',
    '• такси 900 работа',
    '• 12.5$ обед',
    '',
    'Команды:',
    '/today — итог за сегодня',
    '/week — итог за неделю',
    '/month — итог за месяц',
    '/list — последние траты',
    '/edit <id> <текст> — исправить (напр. /edit 12 кофе 400)',
    '/del <id> — удалить',
    '/limit <категория> <сумма> — лимит на месяц',
    '/limits — показать лимиты',
    '/export — выгрузить CSV',
    '/app — ссылка на веб-панель',
    '',
    'Категорию можно указать словом в том же сообщении.',
  ].join('\n');
}

function periodRange(kind) {
  const today = dbm.ymdInTz();
  if (kind === 'today') return { from: today, to: today, title: 'сегодня' };
  if (kind === 'week') {
    const mon = dbm.mondayOf(today);
    return { from: mon, to: today, title: 'неделя (пн–сегодня)' };
  }
  const month = today.slice(0, 7);
  const { from, to } = dbm.monthRangeSafe(month);
  return { from, to: today > to ? to : today, title: `месяц (${month})` };
}

async function reportSummary(ctx, db, kind) {
  const { from, to, title } = periodRange(kind);
  const { publicUrl } = cfg();
  void publicUrl;
  const tgId = ctx.from.id;
  const { total, count } = dbm.sumBetween(db, tgId, from, to);
  const byCat = dbm.totalsByCategory(db, tgId, from, to);
  const { baseCurrency } = cfg();
  let msg = `*${title}: ${formatMoney(total, baseCurrency)}* (${count} трат)\n`;
  for (const r of byCat.slice(0, 8)) {
    const c = getCategory(r.category);
    msg += `\n${c.emoji} ${c.label} — ${formatMoney(r.total, baseCurrency)}`;
  }
  if (byCat.length === 0) msg += '\nПока пусто. Напишите, например: кофе 350';
  return ctx.replyWithMarkdown(msg);
}

function parseLimitArgs(text) {
  // "/limit кафе 5000" -> {category:'cafe', amount:5000}
  const parts = text.trim().split(/\s+/).slice(1);
  if (parts.length < 2) return { error: 'Пример: /limit кафе 5000' };
  const amount = Number(parts[parts.length - 1].replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'Сумма лимита странная. Пример: /limit кафе 5000' };
  const catWords = parts.slice(0, -1).join(' ');
  const { detectCategory } = require('./categories');
  const category = detectCategory(catWords);
  // If user typed unknown word, detectCategory -> other; treat 'прочее' explicitly only.
  return { category, amount };
}

function createBot(db) {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error('BOT_TOKEN is not set');
  const bot = new Telegraf(token);
  const pendingEdit = new Map(); // tgId -> expenseId

  bot.start(async (ctx) => {
    dbm.upsertUser(db, { tg_id: ctx.from.id, first_name: ctx.from.first_name, username: ctx.from.username });
    await ctx.reply(
      `Привет! Я трекер расходов 👋\nНапишите первую трату, например: кофе 350`,
      mainKeyboard()
    );
    await ctx.reply(helpText());
  });
  bot.help((ctx) => ctx.reply(helpText(), mainKeyboard()));
  bot.command('app', (ctx) => ctx.reply(`Веб-панель:\n${loginLink(ctx.from.id, ctx.from.first_name, ctx.from.username)}`));
  bot.command('login', (ctx) => ctx.reply(`Вход в панель (ссылка на 30 дней):\n${loginLink(ctx.from.id, ctx.from.first_name, ctx.from.username)}`));
  bot.command('today', (ctx) => reportSummary(ctx, db, 'today'));
  bot.command('week', (ctx) => reportSummary(ctx, db, 'week'));
  bot.command('month', (ctx) => reportSummary(ctx, db, 'month'));
  bot.command('cancel', (ctx) => { pendingEdit.delete(ctx.from.id); return ctx.reply('Ок, отменил.'); });

  bot.hears('📊 Сегодня', (ctx) => reportSummary(ctx, db, 'today'));
  bot.hears('📈 Неделя', (ctx) => reportSummary(ctx, db, 'week'));
  bot.hears('🗓 Месяц', (ctx) => reportSummary(ctx, db, 'month'));
  bot.hears('🧾 Последние', (ctx) => listCmd(ctx, db));
  bot.hears('🌐 Панель', (ctx) => ctx.reply(`Веб-панель:\n${loginLink(ctx.from.id, ctx.from.first_name, ctx.from.username)}`));
  bot.hears('⚙️ Лимиты', (ctx) => limitsCmd(ctx, db));

  bot.command('list', (ctx) => listCmd(ctx, db));
  bot.command('limits', (ctx) => limitsCmd(ctx, db));

  bot.command('export', async (ctx) => {
    const { rows } = dbm.listExpenses(db, ctx.from.id, { limit: 200 });
    if (rows.length === 0) return ctx.reply('Пока нечего выгружать.');
    const lines = ['id,date,description,category,amount,currency,amount_base,base_currency'];
    const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
    for (const r of [...rows].reverse()) {
      lines.push([r.id, r.day, esc(r.description), r.category, r.amount, r.currency, r.amount_base, r.base_currency].join(','));
    }
    const buf = Buffer.from('﻿' + lines.join('\n'), 'utf8');
    await ctx.replyWithDocument({ source: buf, filename: 'expenses.csv' });
  });

  bot.command('limit', (ctx) => {
    const { error, category, amount } = parseLimitArgs(ctx.message.text);
    if (error) return ctx.reply(error);
    const { baseCurrency, rates } = cfg();
    const amountBase = Math.round(amount * (rates[baseCurrency] ?? 1) * 100) / 100;
    // Лимит задаётся в базовой валюте.
    dbm.setLimit(db, ctx.from.id, category, amount);
    const c = getCategory(category);
    return ctx.reply(`${c.emoji} Лимит «${c.label}»: ${formatMoney(amount, baseCurrency)} на месяц. Предупрежу, когда превысите.`);
  });

  bot.command('rmlimit', (ctx) => {
    const words = ctx.message.text.trim().split(/\s+/).slice(1).join(' ');
    if (!words) return ctx.reply('Пример: /rmlimit кафе');
    const { detectCategory } = require('./categories');
    dbm.deleteLimit(db, ctx.from.id, detectCategory(words));
    return ctx.reply('Лимит убран.');
  });

  bot.command('del', (ctx) => {
    const id = Number(ctx.message.text.trim().split(/\s+/)[1]);
    if (!Number.isInteger(id)) return ctx.reply('Пример: /del 12');
    const ok = dbm.deleteExpense(db, ctx.from.id, id);
    return ctx.reply(ok ? `Трата #${id} удалена.` : `Не нашёл трату #${id}.`);
  });

  bot.command('edit', async (ctx) => {
    const m = ctx.message.text.match(/^\/edit\s+(\d+)\s+([\s\S]+)/);
    if (!m) return ctx.reply('Пример: /edit 12 кофе 400');
    const id = Number(m[1]);
    const cur = dbm.getExpense(db, ctx.from.id, id);
    if (!cur) return ctx.reply(`Не нашёл трату #${id}.`);
    const { defaultCurrency, baseCurrency, rates } = cfg();
    const p = parseExpense(m[2], { defaultCurrency, baseCurrency, rates });
    if (!p.ok) return ctx.reply(p.error);
    const next = dbm.updateExpense(db, ctx.from.id, id, {
      amount: p.amount, currency: p.currency, amount_base: p.amountBase,
      base_currency: p.baseCurrency, description: p.description, category: p.category,
    });
    return ctx.reply(`Готово: ${expenseLine(next)}`, editKeyboard(next.id));
  });

  // Inline buttons: edit:<id> / del:<id> / del_yes:<id>
  bot.action(/edit:(\d+)/, async (ctx) => {
    pendingEdit.set(ctx.from.id, Number(ctx.match[1]));
    await ctx.answerCbQuery();
    return ctx.reply(`Пришлите новую сумму и описание для #${ctx.match[1]} (или /cancel):`);
  });
  bot.action(/del:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    return ctx.reply(`Удалить #${ctx.match[1]}?`, Markup.inlineKeyboard([
      Markup.button.callback('Да, удалить', `del_yes:${ctx.match[1]}`),
      Markup.button.callback('Отмена', 'del_no'),
    ]));
  });
  bot.action(/del_yes:(\d+)/, async (ctx) => {
    dbm.deleteExpense(db, ctx.from.id, Number(ctx.match[1]));
    await ctx.answerCbQuery('Удалено');
    return ctx.editMessageText(`Трата #${ctx.match[1]} удалена.`);
  });
  bot.action('del_no', async (ctx) => {
    await ctx.answerCbQuery();
    return ctx.editMessageText('Ок, оставил.');
  });

  // Receipt photos: parse caption; optional OCR stub.
  bot.on('photo', async (ctx) => {
    const caption = ctx.message.caption || '';
    const { defaultCurrency, baseCurrency, rates, ocrMode } = cfg();
    dbm.upsertUser(db, { tg_id: ctx.from.id, first_name: ctx.from.first_name, username: ctx.from.username });
    if (caption) {
      const p = parseExpense(caption, { defaultCurrency, baseCurrency, rates });
      if (p.ok) {
        const saved = saveExpense(ctx, db, p);
        return ctx.reply(` photo: ${expenseLine(saved)}`, editKeyboard(saved.id));
      }
    }
    if (ocrMode === 'tesseract') {
      try {
        const text = await ocrPhoto(ctx);
        if (text) {
          const p = parseExpense(text, { defaultCurrency, baseCurrency, rates });
          if (p.ok) {
            const saved = saveExpense(ctx, db, p);
            return ctx.reply(`Чек распознан: ${expenseLine(saved)}\nЕсли сумма неверная — исправьте: /edit ${saved.id} <текст>`, editKeyboard(saved.id));
          }
        }
      } catch (e) {
        console.error('OCR failed', e.message);
      }
    }
    return ctx.reply('Пришлите фото с подписью-суммой (например, фото чека с подписью «обед 450») — или просто напишите сумму текстом.');
  });

  // Main text handler: pending edit first, then new expense.
  bot.on('text', async (ctx) => {
    const text = ctx.message.text || '';
    if (text.startsWith('/')) return; // commands handled above
    dbm.upsertUser(db, { tg_id: ctx.from.id, first_name: ctx.from.first_name, username: ctx.from.username });
    const { defaultCurrency, baseCurrency, rates } = cfg();

    const pend = pendingEdit.get(ctx.from.id);
    if (pend) {
      pendingEdit.delete(ctx.from.id);
      const p = parseExpense(text, { defaultCurrency, baseCurrency, rates });
      if (!p.ok) return ctx.reply(p.error + '\nПравка отменена. Попробуйте ещё раз через кнопку «Изменить».');
      const next = dbm.updateExpense(db, ctx.from.id, pend, {
        amount: p.amount, currency: p.currency, amount_base: p.amountBase,
        base_currency: p.baseCurrency, description: p.description, category: p.category,
      });
      if (!next) return ctx.reply(`Не нашёл трату #${pend}.`);
      return ctx.reply(`Готово: ${expenseLine(next)}`, editKeyboard(next.id));
    }

    const p = parseExpense(text, { defaultCurrency, baseCurrency, rates });
    if (!p.ok) return ctx.reply(p.error + '\n\n' + helpText());
    const saved = saveExpense(ctx, db, p);
    const warn = limitWarning(db, ctx.from.id, saved);
    const { total } = dbm.sumBetween(db, ctx.from.id, dbm.ymdInTz(), dbm.ymdInTz());
    let msg = `✅ ${expenseLine(saved)}\nСегодня: ${formatMoney(total, saved.base_currency)}`;
    if (warn) msg += `\n\n${warn}`;
    return ctx.reply(msg, editKeyboard(saved.id));
  });

  return bot;
}

function editKeyboard(id) {
  return Markup.inlineKeyboard([
    Markup.button.callback('✏️ Изменить', `edit:${id}`),
    Markup.button.callback('🗑 Удалить', `del:${id}`),
  ]);
}

function saveExpense(ctx, db, p) {
  return dbm.addExpense(db, ctx.from.id, {
    amount: p.amount,
    currency: p.currency,
    amountBase: p.amountBase,
    baseCurrency: p.baseCurrency,
    description: p.description,
    category: p.category,
  });
}

function limitWarning(db, tgId, saved) {
  // Warn when monthly total in this category (or overall) exceeds the limit.
  const month = saved.day.slice(0, 7);
  const { from, to } = dbm.monthRangeSafe(month);
  const check = (category) => {
    const lim = dbm.getLimit(db, tgId, category);
    if (!lim) return null;
    let spent;
    if (category === '*') {
      spent = dbm.sumBetween(db, tgId, from, to).total;
    } else {
      const rows = dbm.totalsByCategory(db, tgId, from, to);
      spent = (rows.find((r) => r.category === category) || { total: 0 }).total;
    }
    if (spent > lim) {
      const name = category === '*' ? 'общий' : getCategory(category).label;
      return `⚠️ Лимит «${name}» превышен: ${formatMoney(spent, saved.base_currency)} / ${formatMoney(lim, saved.base_currency)}`;
    }
    if (spent > lim * 0.8) {
      const name = category === '*' ? 'общий' : getCategory(category).label;
      return `Лимит «${name}» почти исчерпан: ${formatMoney(spent, saved.base_currency)} / ${formatMoney(lim, saved.base_currency)}`;
    }
    return null;
  };
  return check(saved.category) || check('*');
}

async function listCmd(ctx, db) {
  const { rows } = dbm.listExpenses(db, ctx.from.id, { limit: 10 });
  if (rows.length === 0) return ctx.reply('Пока пусто. Напишите, например: кофе 350');
  const lines = rows.map(expenseLine);
  return ctx.reply('Последние:\n' + lines.join('\n') + '\n\nИсправить: /edit <id> <текст> · Удалить: /del <id>');
}

async function limitsCmd(ctx, db) {
  const lims = dbm.getLimits(db, ctx.from.id);
  if (lims.length === 0) return ctx.reply('Лимитов нет. Пример: /limit кафе 5000');
  const { baseCurrency } = cfg();
  const lines = lims.map((l) => {
    const name = l.category === '*' ? 'Общий' : getCategory(l.category).label;
    return `${name}: ${formatMoney(l.amount_base, baseCurrency)}`;
  });
  return ctx.reply('Лимиты на месяц:\n' + lines.join('\n'));
}

async function ocrPhoto(ctx) {
  // Lazy optional OCR. Requires `npm i tesseract.js` and OCR_MODE=tesseract.
  const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  const link = await ctx.telegram.getFileLink(fileId);
  const { createWorker } = require('tesseract.js');
  const worker = await createWorker('rus+eng');
  try {
    const { data } = await worker.recognize(link.href || String(link));
    return data.text || '';
  } finally {
    await worker.terminate();
  }
}

module.exports = { createBot, helpText };

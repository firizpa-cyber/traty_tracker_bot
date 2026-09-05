'use strict';

const { Telegraf, Markup } = require('telegraf');
const { parseExpense, extractAmount, splitExpenseParts, cleanDescription, formatMoney } = require('./parse');
const { getCategory, detectCategory, CATEGORIES, norm } = require('./categories');
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

const COMMANDS = [
  { command: 'menu', description: '🏠 Главное меню' },
  { command: 'today', description: 'Итог за сегодня' },
  { command: 'week', description: 'Итог за неделю' },
  { command: 'month', description: 'Итог за месяц' },
  { command: 'list', description: 'Последние траты' },
  { command: 'undo', description: 'Отменить последнюю трату' },
  { command: 'limit', description: 'Лимит: /limit кафе 5000' },
  { command: 'limits', description: 'Показать лимиты' },
  { command: 'export', description: 'Выгрузить CSV' },
  { command: 'app', description: 'Ссылка на веб-панель' },
];

async function setupBotMenu(bot) {
  try {
    await bot.telegram.setMyCommands(COMMANDS);
  } catch (e) {
    console.error('setMyCommands failed:', e.message);
  }
}

function loginLink(tgId, firstName, username) {
  const { publicUrl } = cfg();
  const token = signToken({ tg_id: tgId, first_name: firstName, username }, '30d');
  return `${publicUrl}/?token=${token}`;
}

function mainKeyboard() {
  return Markup.keyboard([
    ['➕ Добавить', '📊 Сегодня'],
    ['📈 Неделя', '🗓 Месяц'],
    ['🧾 Последние', '🏠 Меню'],
    ['🌐 Панель', '⚙️ Лимиты'],
  ]).resize().persistent();
}

function menuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('➕ Добавить трату', 'flow:add')],
    [Markup.button.callback('📊 Сегодня', 'sum:today'), Markup.button.callback('📈 Неделя', 'sum:week')],
    [Markup.button.callback('🗓 Месяц', 'sum:month'), Markup.button.callback('🧾 Последние', 'list')],
    [Markup.button.callback('🌐 Панель', 'panel'), Markup.button.callback('⚙️ Лимиты', 'flow:limits')],
    [Markup.button.callback('↩️ Отменить последнюю', 'undo'), Markup.button.callback('❓ Помощь', 'help')],
  ]);
}

function categoryGrid(prefix, includeAuto = false) {
  const rows = [];
  const btns = CATEGORIES.filter((c) => c.id !== 'other').map((c) =>
    Markup.button.callback(`${c.emoji} ${c.label}`, `${prefix}:${c.id}`)
  );
  for (let i = 0; i < btns.length; i += 3) rows.push(btns.slice(i, i + 3));
  if (includeAuto) rows.push([Markup.button.callback('✨ Определить саму', `${prefix}:auto`)]);
  rows.push([Markup.button.callback('❌ Отмена', 'cancel')]);
  return Markup.inlineKeyboard(rows);
}

function expenseLine(e) {
  const c = getCategory(e.category);
  return `#${e.id} ${c.emoji} ${e.description} — ${formatMoney(e.amount, e.currency)} · ${c.label} · ${e.day}`;
}

function welcomeText(name) {
  return [
    `👋 Привет${name ? `, ${name}` : ''}! Я помогу следить за деньгами.`,
    '',
    'Просто пишите траты как есть:',
    '• <code>кофе 350</code>',
    '• <code>такси 900 работа</code>',
    '• <code>потратил 500 на такси</code>',
    '• <code>кофе 350 и такси 900</code> — запишу обе сразу',
    '',
    'Или нажмите ➕ Добавить — проведу по шагам.',
  ].join('\n');
}

function helpText() {
  return [
    'Пишите трату одним сообщением — сумму и описание:',
    '• кофе 350',
    '• такси 900 работа',
    '• потратил 500 на такси',
    '• кофе 350 и такси 900 (несколько сразу)',
    '',
    'Понимаю вопросы: «сколько потратил?», «итог за неделю».',
    '',
    'Команды:',
    '/menu — главное меню с кнопками',
    '/today · /week · /month — итоги',
    '/list — последние траты',
    '/undo — отменить последнюю',
    '/edit <id> <текст> — исправить',
    '/del <id> — удалить',
    '/limit <категория> <сумма> — лимит',
    '/export — выгрузить CSV',
    '/app — веб-панель',
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
  try {
    await ctx.answerCbQuery();
  } catch (_) {}
  return ctx.replyWithMarkdown(msg);
}

function parseLimitArgs(text) {
  // "/limit кафе 5000" -> {category:'cafe', amount:5000}
  const parts = text.trim().split(/\s+/).slice(1);
  if (parts.length < 2) return { error: 'Пример: /limit кафе 5000' };
  const amount = Number(parts[parts.length - 1].replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'Сумма лимита странная. Пример: /limit кафе 5000' };
  return { category: detectCategory(parts.slice(0, -1).join(' ')), amount };
}

function createBot(db) {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error('BOT_TOKEN is not set');
  const bot = new Telegraf(token);
  const pendingEdit = new Map(); // tgId -> expenseId (legacy inline edit)
  const sessions = new Map(); // tgId -> {flow, step, draft}
  const lastSaved = new Map(); // tgId -> expenseId (for /undo)
  const popts = () => {
    const { defaultCurrency, baseCurrency, rates } = cfg();
    return { defaultCurrency, baseCurrency, rates };
  };

  const clearSession = (tgId) => {
    sessions.delete(tgId);
    pendingEdit.delete(tgId);
  };

  // ---------- entry points ----------
  bot.start(async (ctx) => {
    dbm.upsertUser(db, { tg_id: ctx.from.id, first_name: ctx.from.first_name, username: ctx.from.username });
    clearSession(ctx.from.id);
    await ctx.replyWithHTML(welcomeText(ctx.from.first_name), mainKeyboard());
    return ctx.reply('Все действия — здесь:', menuKeyboard());
  });
  bot.help((ctx) => ctx.reply(helpText(), mainKeyboard()));
  bot.command('menu', (ctx) => ctx.reply('Главное меню:', menuKeyboard()));
  bot.command('app', (ctx) => ctx.reply(`Веб-панель:\n${loginLink(ctx.from.id, ctx.from.first_name, ctx.from.username)}`));
  bot.command('login', (ctx) => ctx.reply(`Вход в панель (ссылка на 30 дней):\n${loginLink(ctx.from.id, ctx.from.first_name, ctx.from.username)}`));
  bot.command('today', (ctx) => reportSummary(ctx, db, 'today'));
  bot.command('week', (ctx) => reportSummary(ctx, db, 'week'));
  bot.command('month', (ctx) => reportSummary(ctx, db, 'month'));
  bot.command('undo', (ctx) => undoLast(ctx, db, lastSaved));
  bot.command('cancel', (ctx) => {
    clearSession(ctx.from.id);
    return ctx.reply('Ок, отменил.', mainKeyboard());
  });

  bot.hears('➕ Добавить', (ctx) => startAdd(ctx, sessions));
  bot.hears('📊 Сегодня', (ctx) => reportSummary(ctx, db, 'today'));
  bot.hears('📈 Неделя', (ctx) => reportSummary(ctx, db, 'week'));
  bot.hears('🗓 Месяц', (ctx) => reportSummary(ctx, db, 'month'));
  bot.hears('🧾 Последние', (ctx) => listCmd(ctx, db));
  bot.hears('🏠 Меню', (ctx) => ctx.reply('Главное меню:', menuKeyboard()));
  bot.hears('🌐 Панель', (ctx) => ctx.reply(`Веб-панель:\n${loginLink(ctx.from.id, ctx.from.first_name, ctx.from.username)}`));
  bot.hears('⚙️ Лимиты', (ctx) => limitsMenu(ctx, db));

  bot.command('list', (ctx) => listCmd(ctx, db));
  bot.command('limits', (ctx) => limitsMenu(ctx, db));

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
    if (error) return ctx.reply(`${error}\nИли нажмите ⚙️ Лимиты — настроим кнопками.`);
    const { baseCurrency } = cfg();
    dbm.setLimit(db, ctx.from.id, category, amount);
    const c = getCategory(category);
    return ctx.reply(`${c.emoji} Лимит «${c.label}»: ${formatMoney(amount, baseCurrency)} на месяц. Предупрежу на 80% и при превышении.`);
  });

  bot.command('rmlimit', (ctx) => {
    const words = ctx.message.text.trim().split(/\s+/).slice(1).join(' ');
    if (!words) return ctx.reply('Пример: /rmlimit кафе');
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
    const p = parseExpense(m[2], popts());
    if (!p.ok) return ctx.reply(p.error);
    const next = dbm.updateExpense(db, ctx.from.id, id, {
      amount: p.amount, currency: p.currency, amount_base: p.amountBase,
      base_currency: p.baseCurrency, description: p.description, category: p.category,
    });
    return ctx.reply(`Готово: ${expenseLine(next)}`, editKeyboard(next.id));
  });

  // ---------- inline menu ----------
  bot.action('menu', async (ctx) => {
    await ctx.answerCbQuery();
    return ctx.reply('Главное меню:', menuKeyboard());
  });
  bot.action('panel', async (ctx) => {
    await ctx.answerCbQuery();
    return ctx.reply(`Веб-панель с графиками:\n${loginLink(ctx.from.id, ctx.from.first_name, ctx.from.username)}`);
  });
  bot.action('help', async (ctx) => {
    await ctx.answerCbQuery();
    return ctx.reply(helpText());
  });
  bot.action('list', async (ctx) => {
    await ctx.answerCbQuery();
    return listCmd(ctx, db);
  });
  bot.action(/sum:(today|week|month)/, async (ctx) => reportSummary(ctx, db, ctx.match[1]));
  bot.action('undo', async (ctx) => {
    await ctx.answerCbQuery();
    return undoLast(ctx, db, lastSaved);
  });
  bot.action('cancel', async (ctx) => {
    clearSession(ctx.from.id);
    await ctx.answerCbQuery('Отменено');
    try {
      await ctx.editMessageText('Ок, отменил.');
    } catch (_) {
      await ctx.reply('Ок, отменил.');
    }
  });

  // ---------- add flow: amount -> category -> description -> confirm ----------
  bot.action('flow:add', async (ctx) => {
    await ctx.answerCbQuery();
    return startAdd(ctx, sessions);
  });
  bot.action(/addcat:(other|[a-z]+|auto)/, async (ctx) => {
    const s = sessions.get(ctx.from.id);
    if (!s || s.flow !== 'add') { await ctx.answerCbQuery(); return; }
    await ctx.answerCbQuery();
    s.draft.category = ctx.match[1] === 'auto' ? null : ctx.match[1];
    s.step = 'desc';
    const c = s.draft.category ? getCategory(s.draft.category) : null;
    return ctx.reply(
      c ? `${c.emoji} Категория «${c.label}». Что именно купили? Напишите описание или пропустите.`
        : 'Что именно купили? Напишите описание или пропустите — категорию определю сам.',
      Markup.inlineKeyboard([
        Markup.button.callback('⏭ Пропустить', 'addskip'),
        Markup.button.callback('❌ Отмена', 'cancel'),
      ])
    );
  });
  bot.action('addskip', async (ctx) => {
    const s = sessions.get(ctx.from.id);
    if (!s || s.flow !== 'add') { await ctx.answerCbQuery(); return; }
    await ctx.answerCbQuery();
    const cat = s.draft.category || detectCategory('');
    s.draft.category = cat === 'other' && s.draft.hint ? detectCategory(s.draft.hint) : cat;
    s.draft.description = s.draft.hint
      || (s.draft.category && s.draft.category !== 'other' ? getCategory(s.draft.category).label : 'Трата');
    s.step = 'confirm';
    return ctx.reply(confirmText(s.draft), confirmKeyboard());
  });
  bot.action('addsave', async (ctx) => {
    const s = sessions.get(ctx.from.id);
    if (!s || s.flow !== 'add') { await ctx.answerCbQuery(); return; }
    await ctx.answerCbQuery('Сохранено ✅');
    sessions.delete(ctx.from.id);
    const saved = saveExpense(ctx, db, s.draft);
    lastSaved.set(ctx.from.id, saved.id);
    try {
      await ctx.editMessageText(`✅ ${expenseLine(saved)}`, undoKeyboard(saved.id));
    } catch (_) {
      await ctx.reply(`✅ ${expenseLine(saved)}`, undoKeyboard(saved.id));
    }
    const warn = limitWarning(db, ctx.from.id, saved);
    if (warn) await ctx.reply(warn);
  });
  bot.action('addrestart', async (ctx) => {
    await ctx.answerCbQuery();
    return startAdd(ctx, sessions);
  });

  // ---------- limits flow ----------
  bot.action('flow:limits', async (ctx) => {
    await ctx.answerCbQuery();
    return limitsMenu(ctx, db);
  });
  bot.action('lim:new', async (ctx) => {
    await ctx.answerCbQuery();
    sessions.set(ctx.from.id, { flow: 'limit', step: 'category', draft: {} });
    return ctx.reply('На какую категорию ставим лимит?', categoryGrid('limset'));
  });
  bot.action(/limset:([a-z]+)/, async (ctx) => {
    const s = sessions.get(ctx.from.id);
    if (!s || s.flow !== 'limit') { await ctx.answerCbQuery(); return; }
    await ctx.answerCbQuery();
    s.draft.category = ctx.match[1];
    s.step = 'amount';
    const c = getCategory(ctx.match[1]);
    return ctx.reply(
      `${c.emoji} Лимит «${c.label}» на месяц. Напишите сумму в ${cfg().baseCurrency} (например 5000):`,
      Markup.inlineKeyboard([Markup.button.callback('❌ Отмена', 'cancel')])
    );
  });
  bot.action('lim:rm', async (ctx) => {
    await ctx.answerCbQuery();
    const lims = dbm.getLimits(db, ctx.from.id);
    if (lims.length === 0) return ctx.reply('Лимитов нет — и убирать нечего 🙂');
    const rows = lims.map((l) => {
      const name = l.category === '*' ? 'Общий' : getCategory(l.category).label;
      return [Markup.button.callback(`🗑 ${name}`, `limdel:${l.category}`)];
    });
    rows.push([Markup.button.callback('❌ Отмена', 'cancel')]);
    return ctx.reply('Какой лимит убрать?', Markup.inlineKeyboard(rows));
  });
  bot.action(/limdel:(.+)/, async (ctx) => {
    dbm.deleteLimit(db, ctx.from.id, ctx.match[1]);
    await ctx.answerCbQuery('Убран');
    try {
      await ctx.editMessageText('Лимит убран.');
    } catch (_) {}
    return limitsMenu(ctx, db);
  });

  // ---------- edit/delete on saved expenses ----------
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
  bot.action(/undo:(\d+)/, async (ctx) => {
    const ok = dbm.deleteExpense(db, ctx.from.id, Number(ctx.match[1]));
    await ctx.answerCbQuery(ok ? 'Отменено' : 'Уже удалено');
    try {
      await ctx.editMessageText(ok ? `↩️ Запись #${ctx.match[1]} отменена.` : 'Запись уже удалена.');
    } catch (_) {}
  });

  // ---------- receipt photos ----------
  bot.on('photo', async (ctx) => {
    const caption = ctx.message.caption || '';
    dbm.upsertUser(db, { tg_id: ctx.from.id, first_name: ctx.from.first_name, username: ctx.from.username });
    if (caption) {
      const p = parseExpense(caption, popts());
      if (p.ok) {
        const saved = saveExpense(ctx, db, p);
        lastSaved.set(ctx.from.id, saved.id);
        return ctx.reply(`🧾 ${expenseLine(saved)}`, undoKeyboard(saved.id));
      }
    }
    if (cfg().ocrMode === 'tesseract') {
      try {
        const text = await ocrPhoto(ctx);
        if (text) {
          const p = parseExpense(text, popts());
          if (p.ok) {
            const saved = saveExpense(ctx, db, p);
            lastSaved.set(ctx.from.id, saved.id);
            return ctx.reply(`Чек распознан: ${expenseLine(saved)}\nЕсли сумма неверная — исправьте: /edit ${saved.id} <текст>`, editKeyboard(saved.id));
          }
        }
      } catch (e) {
        console.error('OCR failed', e.message);
      }
    }
    return ctx.reply('Пришлите фото с подписью-суммой (например, фото чека с подписью «обед 450») — или просто напишите сумму текстом.');
  });

  // ---------- main text handler ----------
  bot.on('text', async (ctx) => {
    const text = ctx.message.text || '';
    if (text.startsWith('/')) return; // commands handled above
    dbm.upsertUser(db, { tg_id: ctx.from.id, first_name: ctx.from.first_name, username: ctx.from.username });
    const tgId = ctx.from.id;

    // 1) legacy inline edit
    const pend = pendingEdit.get(tgId);
    if (pend) {
      pendingEdit.delete(tgId);
      const p = parseExpense(text, popts());
      if (!p.ok) return ctx.reply(p.error + '\nПравка отменена. Попробуйте ещё раз через кнопку «Изменить».');
      const next = dbm.updateExpense(db, tgId, pend, {
        amount: p.amount, currency: p.currency, amount_base: p.amountBase,
        base_currency: p.baseCurrency, description: p.description, category: p.category,
      });
      if (!next) return ctx.reply(`Не нашёл трату #${pend}.`);
      return ctx.reply(`Готово: ${expenseLine(next)}`, editKeyboard(next.id));
    }

    // 2) dialog sessions (add / limit flows)
    const s = sessions.get(tgId);
    if (s) {
      const done = await handleSessionText(ctx, db, s, text, lastSaved, popts());
      if (done) sessions.delete(tgId);
      else if (s.cancelled) sessions.delete(tgId);
      return;
    }

    // 3) smart questions: "сколько потратил?", "итог за неделю"
    const smart = await handleSmartQuestion(ctx, db, text);
    if (smart) return;

    // 4) several expenses at once: "кофе 350 и такси 900"
    const parts = splitExpenseParts(text);
    if (parts) {
      const parsed = parts.map((part) => parseExpense(part, popts()));
      if (parsed.every((p) => p.ok)) {
        const saved = parsed.map((p) => saveExpense(ctx, db, p));
        lastSaved.set(tgId, saved[saved.length - 1].id);
        const lines = saved.map(expenseLine).join('\n');
        const { total } = dbm.sumBetween(db, tgId, dbm.ymdInTz(), dbm.ymdInTz());
        return ctx.reply(`✅ Записал сразу ${saved.length}:\n${lines}\nСегодня: ${formatMoney(total, saved[0].base_currency)}`, undoKeyboard(saved[saved.length - 1].id));
      }
      // else fall through to single-message parse (better error message)
    }

    // 5) single expense
    const p = parseExpense(text, popts());
    if (!p.ok) return ctx.reply(p.error + '\n\nНажмите ➕ Добавить — проведу по шагам, или /menu для всех действий.');
    const saved = saveExpense(ctx, db, p);
    lastSaved.set(tgId, saved.id);
    const warn = limitWarning(db, tgId, saved);
    const { total } = dbm.sumBetween(db, tgId, dbm.ymdInTz(), dbm.ymdInTz());
    let msg = `✅ ${expenseLine(saved)}\nСегодня: ${formatMoney(total, saved.base_currency)}`;
    if (warn) msg += `\n\n${warn}`;
    return ctx.reply(msg, undoKeyboard(saved.id));
  });

  return bot;
}

// ---------- dialog helpers ----------

function startAdd(ctx, sessions) {
  sessions.set(ctx.from.id, { flow: 'add', step: 'amount', draft: {} });
  return ctx.reply(
    'Сколько потратили? 💰\nНапишите сумму — можно сразу с описанием: <code>кофе 350</code>',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([Markup.button.callback('❌ Отмена', 'cancel')]),
    }
  );
}

function confirmText(d) {
  const c = getCategory(d.category || 'other');
  return `Проверьте:\n${c.emoji} ${d.description} — ${formatMoney(d.amount, d.currency)}\nКатегория: ${c.label}`;
}

function confirmKeyboard() {
  return Markup.inlineKeyboard([
    Markup.button.callback('✅ Сохранить', 'addsave'),
    Markup.button.callback('🔁 Заново', 'addrestart'),
    Markup.button.callback('❌ Отмена', 'cancel'),
  ]);
}

function undoKeyboard(id) {
  return Markup.inlineKeyboard([
    Markup.button.callback('✏️ Изменить', `edit:${id}`),
    Markup.button.callback('↩️ Отменить', `undo:${id}`),
    Markup.button.callback('🗑 Удалить', `del:${id}`),
  ]);
}

function editKeyboard(id) {
  return Markup.inlineKeyboard([
    Markup.button.callback('✏️ Изменить', `edit:${id}`),
    Markup.button.callback('🗑 Удалить', `del:${id}`),
  ]);
}

// Returns true when the session is finished.
async function handleSessionText(ctx, db, s, text, lastSaved, popts) {
  const tgId = ctx.from.id;
  if (s.flow === 'add') {
    if (s.step === 'amount') {
      const a = extractAmount(text, popts);
      if (!a.ok) {
        await ctx.reply(a.error + ' Попробуйте ещё раз или нажмите ❌ Отмена.');
        return false;
      }
      s.draft.amount = a.amount;
      s.draft.currency = a.currency;
      s.draft.amountBase = a.amountBase;
      s.draft.baseCurrency = a.baseCurrency;
      // Fast path: user already wrote description with the amount.
      const rest = cleanDescription(text.slice(0, a.start) + ' ' + text.slice(a.end));
      if (rest.length > 1) {
        s.draft.hint = rest.charAt(0).toUpperCase() + rest.slice(1);
        s.draft.category = detectCategory(rest);
        s.draft.description = s.draft.hint;
        s.step = 'confirm';
        return ctx.reply(confirmText(s.draft), confirmKeyboard()).then(() => false);
      }
      s.step = 'category';
      await ctx.reply(`💰 ${formatMoney(a.amount, a.currency)}. Какая категория?`, categoryGrid('addcat', true));
      return false;
    }
    if (s.step === 'desc') {
      const t = text.trim().slice(0, 200);
      s.draft.description = t.charAt(0).toUpperCase() + t.slice(1);
      if (!s.draft.category) s.draft.category = detectCategory(t);
      s.step = 'confirm';
      await ctx.reply(confirmText(s.draft), confirmKeyboard());
      return false;
    }
    return false;
  }
  if (s.flow === 'limit' && s.step === 'amount') {
    const amount = Number(text.replace(',', '.').replace(/[^\d.]/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) {
      await ctx.reply('Не понял сумму. Напишите число, например: 5000');
      return false;
    }
    const { baseCurrency } = cfg();
    dbm.setLimit(db, tgId, s.draft.category, amount);
    const c = getCategory(s.draft.category);
    await ctx.reply(`${c.emoji} Готово: лимит «${c.label}» — ${formatMoney(amount, baseCurrency)} на месяц.`);
    return true;
  }
  return true;
}

// Natural questions like "сколько потратил?" / "итог за неделю" / "последние".
async function handleSmartQuestion(ctx, db, text) {
  const q = norm(text);
  const asksTotal = /(сколько|скока).*(потратил|потратили|ушло|уходит|расход|трат|денег|итог)|^(итог|итоги|баланс|отч[её]т|статистика|сумма|расходы)\b/.test(q);
  if (asksTotal && !/\d/.test(q)) {
    let kind = 'today';
    if (/недел/.test(q)) kind = 'week';
    else if (/мес/.test(q)) kind = 'month';
    await reportSummary(ctx, db, kind);
    return true;
  }
  if (/^(покажи |показать )?(последн|история|список|мои траты)/.test(q) && !/\d/.test(q)) {
    await listCmd(ctx, db);
    return true;
  }
  if (/^(спасибо|благодарю|рахмат)/.test(q)) {
    await ctx.reply('Пожалуйста! 😊 Записывайте каждый день — графики скажут спасибо.');
    return true;
  }
  return false;
}

function saveExpense(ctx, db, p) {
  return dbm.addExpense(db, ctx.from.id, {
    amount: p.amount,
    currency: p.currency,
    amountBase: p.amountBase,
    baseCurrency: p.baseCurrency,
    description: p.description,
    category: p.category || 'other',
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

async function limitsMenu(ctx, db) {
  const { baseCurrency } = cfg();
  const lims = dbm.getLimits(db, ctx.from.id);
  let msg = '⚙️ Лимиты на месяц:\n';
  if (lims.length === 0) {
    msg += 'пока нет. Поставьте первый — и я предупрежу о перерасходе.';
  } else {
    msg += lims.map((l) => {
      const name = l.category === '*' ? 'Общий' : getCategory(l.category).label;
      return `• ${name}: ${formatMoney(l.amount_base, baseCurrency)}`;
    }).join('\n');
  }
  return ctx.reply(msg, Markup.inlineKeyboard([
    Markup.button.callback('➕ Установить лимит', 'lim:new'),
    Markup.button.callback('🗑 Убрать лимит', 'lim:rm'),
  ]));
}

async function undoLast(ctx, db, lastSaved) {
  const id = lastSaved.get(ctx.from.id);
  if (!id) return ctx.reply('Нечего отменять — последней записи нет.');
  const ok = dbm.deleteExpense(db, ctx.from.id, id);
  lastSaved.delete(ctx.from.id);
  return ctx.reply(ok ? `↩️ Отменил: трата #${id} удалена.` : 'Эта запись уже удалена.');
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

module.exports = { createBot, setupBotMenu, helpText, welcomeText };

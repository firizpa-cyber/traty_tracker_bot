'use strict';

// Bot = fast input + launcher for the Mini App.
// All screens moved into the Telegram Mini App (public/); here stays:
// one-message expense input, smart questions, edit/delete/undo buttons,
// totals by command, limits, CSV/Sheets export.

const { Telegraf, Markup } = require('telegraf');
const { parseExpense, splitExpenseParts, parseReceiptTotal, formatMoney } = require('./parse');
const { getCategory, detectCategory, norm } = require('./categories');
const dbm = require('./store');
const { signToken } = require('./auth');
const sheets = require('./sheets');

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
  { command: 'app', description: '📱 Открыть приложение' },
  { command: 'today', description: 'Итог за сегодня' },
  { command: 'week', description: 'Итог за неделю' },
  { command: 'month', description: 'Итог за месяц' },
  { command: 'list', description: 'Последние траты' },
  { command: 'undo', description: 'Отменить последнюю трату' },
  { command: 'limit', description: 'Лимит: /limit кафе 5000' },
  { command: 'limits', description: 'Показать лимиты' },
  { command: 'export', description: 'Выгрузить CSV' },
  { command: 'sheets', description: 'Выписка в Google Sheets' },
  { command: 'pair', description: 'Общий бюджет: /pair или /pair КОД' },
  { command: 'shared', description: 'Общий итог на двоих' },
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

// One persistent button: opens the Mini App right inside Telegram.
function appKeyboard() {
  const { publicUrl } = cfg();
  return Markup.keyboard([
    [Markup.button.webApp('📱 Открыть расходы', publicUrl)],
  ]).resize().persistent();
}

function openAppInline(ctx) {
  const { publicUrl } = cfg();
  return Markup.inlineKeyboard([
    [Markup.button.webApp('📱 Открыть приложение', publicUrl)],
    [Markup.button.url('🌐 Открыть в браузере', loginLink(ctx.from.id, ctx.from.first_name, ctx.from.username))],
  ]);
}

function expenseLine(e) {
  const c = getCategory(e.category);
  return `#${e.id} ${c.emoji} ${e.description} — ${formatMoney(e.amount, e.currency)} · ${c.label} · ${e.day}`;
}

function welcomeText(name) {
  return [
    `👋 Привет${name ? `, ${name}` : ''}! Я записываю расходы.`,
    '',
    'Пишите траты как есть: <code>кофе 350</code>',
    'А графики и история — в приложении, кнопка ниже ⬇️',
  ].join('\n');
}

function helpText() {
  return [
    'Пишите трату одним сообщением:',
    '• кофе 350 • такси 900 работа • потратил 500 на такси',
    '• кофе 350 и такси 900 — несколько сразу',
    'Понимаю вопросы: «сколько потратил?», «итог за неделю».',
    '',
    'Всё остальное — в мини-приложении (кнопка 📱 Открыть расходы).',
    '',
    '/today · /week · /month — итоги',
    '/list — последние · /undo — отменить последнюю',
    '/edit <id> <текст> · /del <id>',
    '/limit <категория> <сумма> · /limits · /export · /sheets',
    '/pair — общий бюджет на двоих · /shared — итог на двоих',
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
  const { total, count } = await dbm.sumBetween(db, tgId, from, to);
  const byCat = await dbm.totalsByCategory(db, tgId, from, to);
  const { baseCurrency } = cfg();
  let msg = `*${title}: ${formatMoney(total, baseCurrency)}* (${count} трат)\n`;
  for (const r of byCat.slice(0, 8)) {
    const c = getCategory(r.category);
    msg += `\n${c.emoji} ${c.label} — ${formatMoney(Number(r.total), baseCurrency)}`;
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
  const pendingEdit = new Map(); // tgId -> expenseId
  const lastSaved = new Map(); // tgId -> expenseId (for /undo)
  const popts = () => {
    const { defaultCurrency, baseCurrency, rates } = cfg();
    return { defaultCurrency, baseCurrency, rates };
  };

  bot.start(async (ctx) => {
    await dbm.upsertUser(db, { tg_id: ctx.from.id, first_name: ctx.from.first_name, username: ctx.from.username });
    pendingEdit.delete(ctx.from.id);
    await ctx.replyWithHTML(welcomeText(ctx.from.first_name), appKeyboard());
    return ctx.reply('Графики, история и лимиты — здесь:', openAppInline(ctx));
  });
  bot.help((ctx) => ctx.reply(helpText(), appKeyboard()));
  bot.command('app', (ctx) => ctx.reply('Открыть приложение:', openAppInline(ctx)));
  bot.command('login', (ctx) => ctx.reply(`Вход в панель (ссылка на 30 дней):\n${loginLink(ctx.from.id, ctx.from.first_name, ctx.from.username)}`));
  bot.command('menu', (ctx) => ctx.reply('Всё переехало в приложение:', openAppInline(ctx)));
  bot.command('today', (ctx) => reportSummary(ctx, db, 'today'));
  bot.command('week', (ctx) => reportSummary(ctx, db, 'week'));
  bot.command('month', (ctx) => reportSummary(ctx, db, 'month'));
  bot.command('undo', (ctx) => undoLast(ctx, db, lastSaved));
  bot.command('cancel', (ctx) => {
    pendingEdit.delete(ctx.from.id);
    return ctx.reply('Ок, отменил.', appKeyboard());
  });

  bot.command('list', (ctx) => listCmd(ctx, db));
  bot.command('limits', (ctx) => limitsCmd(ctx, db));

  bot.command('pair', async (ctx) => {
    await dbm.upsertUser(db, { tg_id: ctx.from.id, first_name: ctx.from.first_name, username: ctx.from.username });
    const arg = ctx.message.text.trim().split(/\s+/)[1];
    if (!arg) {
      const paired = await dbm.getPair(db, ctx.from.id);
      if (paired) {
        return ctx.reply(`Вы уже в паре с ${pairName(paired)}. Общий итог: /shared · Расформировать: /unpair`);
      }
      const { code } = await dbm.createPairCode(db, ctx.from.id);
      return ctx.replyWithMarkdown(
        `Ваш код для партнёра: *${code}*\nДействует 15 минут. Партнёр вводит:\n/pair ${code}`
      );
    }
    const r = await dbm.linkPair(db, ctx.from.id, arg);
    if (r.error) return ctx.reply(r.error);
    const partner = await dbm.getPair(db, ctx.from.id);
    try {
      await ctx.telegram.sendMessage(
        r.partnerTgId,
        `👥 ${ctx.from.first_name || 'Пользователь'} объединился с вами в общий бюджет. Итог: /shared`
      );
    } catch (_) {}
    return ctx.reply(`👥 Готово! Общий бюджет с ${pairName(partner)}. Смотрите итог: /shared`);
  });

  bot.command('unpair', async (ctx) => {
    const ok = await dbm.unpair(db, ctx.from.id);
    return ctx.reply(ok ? 'Пара расформирована. Все ваши траты остались у вас.' : 'Вы не в паре.');
  });

  bot.command('shared', async (ctx) => {
    const { baseCurrency } = cfg();
    const today = dbm.ymdInTz();
    const { from, to } = dbm.monthRangeSafe(today.slice(0, 7));
    const s = await dbm.sharedMonth(db, ctx.from.id, from, to);
    if (!s) return ctx.reply('Вы не в паре. Создайте код: /pair — партнёр введёт /pair КОД.');
    let msg = `*👥 На двоих в этом месяце: ${formatMoney(s.combined.total, baseCurrency)}* (${s.combined.count} трат)\n`;
    msg += `\nВы: ${formatMoney(s.mine.total, baseCurrency)} (${s.mine.count})`;
    msg += `\n${pairName(s.partner)}: ${formatMoney(s.theirs.total, baseCurrency)} (${s.theirs.count})`;
    for (const c of s.byCat.slice(0, 6)) {
      const cat = getCategory(c.category);
      msg += `\n${cat.emoji} ${cat.label} — ${formatMoney(c.total, baseCurrency)}`;
    }
    return ctx.replyWithMarkdown(msg);
  });

  bot.command('export', async (ctx) => {
    const { rows } = await dbm.listExpenses(db, ctx.from.id, { limit: 200 });
    if (rows.length === 0) return ctx.reply('Пока нечего выгружать.');
    const lines = ['id,date,description,category,amount,currency,amount_base,base_currency'];
    const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
    for (const r of [...rows].reverse()) {
      lines.push([r.id, r.day, esc(r.description), r.category, r.amount, r.currency, r.amount_base, r.base_currency].join(','));
    }
    const buf = Buffer.from('﻿' + lines.join('\n'), 'utf8');
    await ctx.replyWithDocument({ source: buf, filename: 'expenses.csv' });
  });

  bot.command('sheets', async (ctx) => {
    if (!sheets.isConfigured()) {
      return ctx.reply('Выписка в Google Sheets не настроена на сервере. Инструкция — в README (GOOGLE_SHEET_ID). А пока работает /export в CSV.');
    }
    await ctx.reply('Готовлю выписку…');
    try {
      const { rows } = await dbm.listExpenses(db, ctx.from.id, { limit: 5000 });
      if (rows.length === 0) return ctx.reply('Пока нечего выгружать.');
      const r = await sheets.appendExpenses(rows);
      return ctx.reply(`✅ Выписка готова: ${r.count} строк.\n${r.url}`);
    } catch (e) {
      console.error('sheets failed:', e.message);
      return ctx.reply('Не получилось записать в таблицу. Проверьте доступ сервисного аккаунта к таблице.');
    }
  });

  bot.command('limit', async (ctx) => {
    const { error, category, amount } = parseLimitArgs(ctx.message.text);
    if (error) return ctx.reply(`${error}\nУдобнее — в приложении: 📱 Открыть расходы → Лимиты.`);
    const { baseCurrency } = cfg();
    await dbm.setLimit(db, ctx.from.id, category, amount);
    const c = getCategory(category);
    return ctx.reply(`${c.emoji} Лимит «${c.label}»: ${formatMoney(amount, baseCurrency)} на месяц. Предупрежу на 80% и при превышении.`);
  });

  bot.command('rmlimit', async (ctx) => {
    const words = ctx.message.text.trim().split(/\s+/).slice(1).join(' ');
    if (!words) return ctx.reply('Пример: /rmlimit кафе');
    await dbm.deleteLimit(db, ctx.from.id, detectCategory(words));
    return ctx.reply('Лимит убран.');
  });

  bot.command('del', async (ctx) => {
    const id = Number(ctx.message.text.trim().split(/\s+/)[1]);
    if (!Number.isInteger(id)) return ctx.reply('Пример: /del 12');
    const ok = await dbm.deleteExpense(db, ctx.from.id, id);
    return ctx.reply(ok ? `Трата #${id} удалена.` : `Не нашёл трату #${id}.`);
  });

  bot.command('edit', async (ctx) => {
    const m = ctx.message.text.match(/^\/edit\s+(\d+)\s+([\s\S]+)/);
    if (!m) return ctx.reply('Пример: /edit 12 кофе 400');
    const id = Number(m[1]);
    const cur = await dbm.getExpense(db, ctx.from.id, id);
    if (!cur) return ctx.reply(`Не нашёл трату #${id}.`);
    const p = parseExpense(m[2], popts());
    if (!p.ok) return ctx.reply(p.error);
    const next = await dbm.updateExpense(db, ctx.from.id, id, {
      amount: p.amount, currency: p.currency, amount_base: p.amountBase,
      base_currency: p.baseCurrency, description: p.description, category: p.category,
    });
    return ctx.reply(`Готово: ${expenseLine(next)}`, editKeyboard(next.id));
  });

  // Inline buttons on saved expenses: edit / undo / delete.
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
    await dbm.deleteExpense(db, ctx.from.id, Number(ctx.match[1]));
    await ctx.answerCbQuery('Удалено');
    return ctx.editMessageText(`Трата #${ctx.match[1]} удалена.`);
  });
  bot.action('del_no', async (ctx) => {
    await ctx.answerCbQuery();
    return ctx.editMessageText('Ок, оставил.');
  });
  bot.action(/undo:(\d+)/, async (ctx) => {
    const ok = await dbm.deleteExpense(db, ctx.from.id, Number(ctx.match[1]));
    await ctx.answerCbQuery(ok ? 'Отменено' : 'Уже удалено');
    try {
      await ctx.editMessageText(ok ? `↩️ Запись #${ctx.match[1]} отменена.` : 'Запись уже удалена.');
    } catch (_) {}
  });

  // Receipt photos: parse caption; optional OCR.
  bot.on('photo', async (ctx) => {
    const caption = ctx.message.caption || '';
    await dbm.upsertUser(db, { tg_id: ctx.from.id, first_name: ctx.from.first_name, username: ctx.from.username });
    if (caption) {
      const p = parseExpense(caption, popts());
      if (p.ok) {
        const saved = await saveExpense(ctx, db, p);
        lastSaved.set(ctx.from.id, saved.id);
        return ctx.reply(`🧾 ${expenseLine(saved)}`, undoKeyboard(saved.id));
      }
    }
    if (cfg().ocrMode === 'tesseract') {
      try {
        const text = await ocrPhoto(ctx);
        if (text) {
          const p = parseReceiptTotal(text, popts());
          if (p.ok) {
            const saved = await saveExpense(ctx, db, p);
            lastSaved.set(ctx.from.id, saved.id);
            return ctx.reply(`Чек распознан: ${expenseLine(saved)}\nЕсли сумма неверная — исправьте: /edit ${saved.id} <текст>`, editKeyboard(saved.id));
          }
          return ctx.reply('Не смог разобрать сумму в чеке. Пришлите фото с подписью, например «обед 450».');
        }
      } catch (e) {
        console.error('OCR failed', e.message);
      }
    }
    return ctx.reply('Пришлите фото с подписью-суммой (например, фото чека с подписью «обед 450») — или просто напишите сумму текстом.');
  });

  // Main text handler: pending edit -> smart question -> multi -> single.
  bot.on('text', async (ctx) => {
    const text = ctx.message.text || '';
    if (text.startsWith('/')) return; // commands handled above
    await dbm.upsertUser(db, { tg_id: ctx.from.id, first_name: ctx.from.first_name, username: ctx.from.username });
    const tgId = ctx.from.id;

    const pend = pendingEdit.get(tgId);
    if (pend) {
      pendingEdit.delete(tgId);
      const p = parseExpense(text, popts());
      if (!p.ok) return ctx.reply(p.error + '\nПравка отменена. Попробуйте ещё раз через кнопку «Изменить».');
      const next = await dbm.updateExpense(db, tgId, pend, {
        amount: p.amount, currency: p.currency, amount_base: p.amountBase,
        base_currency: p.baseCurrency, description: p.description, category: p.category,
      });
      if (!next) return ctx.reply(`Не нашёл трату #${pend}.`);
      return ctx.reply(`Готово: ${expenseLine(next)}`, editKeyboard(next.id));
    }

    const smart = await handleSmartQuestion(ctx, db, text);
    if (smart) return;

    // Several expenses at once: "кофе 350 и такси 900"
    const parts = splitExpenseParts(text);
    if (parts) {
      const parsed = parts.map((part) => parseExpense(part, popts()));
      if (parsed.every((p) => p.ok)) {
        const saved = [];
        for (const p of parsed) saved.push(await saveExpense(ctx, db, p));
        lastSaved.set(tgId, saved[saved.length - 1].id);
        const lines = saved.map(expenseLine).join('\n');
        const { total } = await dbm.sumBetween(db, tgId, dbm.ymdInTz(), dbm.ymdInTz());
        return ctx.reply(`✅ Записал сразу ${saved.length}:\n${lines}\nСегодня: ${formatMoney(total, saved[0].base_currency)}`, undoKeyboard(saved[saved.length - 1].id));
      }
      // else fall through to single-message parse (better error message)
    }

    const p = parseExpense(text, popts());
    if (!p.ok) return ctx.reply(p.error + '\nГрафики и история — в приложении: /app');
    const saved = await saveExpense(ctx, db, p);
    lastSaved.set(tgId, saved.id);
    const warn = await limitWarning(db, tgId, saved);
    const { total } = await dbm.sumBetween(db, tgId, dbm.ymdInTz(), dbm.ymdInTz());
    let msg = `✅ ${expenseLine(saved)}\nСегодня: ${formatMoney(total, saved.base_currency)}`;
    if (warn) msg += `\n\n${warn}`;
    return ctx.reply(msg, undoKeyboard(saved.id));
  });

  return bot;
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

async function limitWarning(db, tgId, saved) {
  // Warn when monthly total in this category (or overall) exceeds the limit.
  const month = saved.day.slice(0, 7);
  const { from, to } = dbm.monthRangeSafe(month);
  const check = async (category) => {
    const lim = await dbm.getLimit(db, tgId, category);
    if (!lim) return null;
    let spent;
    if (category === '*') {
      spent = (await dbm.sumBetween(db, tgId, from, to)).total;
    } else {
      const rows = await dbm.totalsByCategory(db, tgId, from, to);
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
  return (await check(saved.category)) || (await check('*'));
}

async function listCmd(ctx, db) {
  const { rows } = await dbm.listExpenses(db, ctx.from.id, { limit: 10 });
  if (rows.length === 0) return ctx.reply('Пока пусто. Напишите, например: кофе 350');
  const lines = rows.map(expenseLine);
  return ctx.reply('Последние:\n' + lines.join('\n') + '\n\nИсправить: /edit <id> <текст> · Удалить: /del <id>');
}

async function limitsCmd(ctx, db) {
  const { baseCurrency } = cfg();
  const lims = await dbm.getLimits(db, ctx.from.id);
  let msg = '⚙️ Лимиты на месяц:\n';
  if (lims.length === 0) {
    msg += 'пока нет. Удобнее ставить в приложении: /app → Лимиты.';
  } else {
    msg += lims.map((l) => {
      const name = l.category === '*' ? 'Общий' : getCategory(l.category).label;
      return `• ${name}: ${formatMoney(l.amount_base, baseCurrency)}`;
    }).join('\n');
  }
  return ctx.reply(msg);
}

function pairName(p) {
  if (!p) return 'партнёр';
  return p.first_name || (p.username ? `@${p.username}` : `id ${p.tg_id}`);
}

async function undoLast(ctx, db, lastSaved) {
  const id = lastSaved.get(ctx.from.id);
  if (!id) return ctx.reply('Нечего отменять — последней записи нет.');
  const ok = await dbm.deleteExpense(db, ctx.from.id, id);
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
